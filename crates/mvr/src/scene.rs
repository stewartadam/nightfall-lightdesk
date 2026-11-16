// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! The scene described by `GeneralSceneDescription.xml`.
//!
//! The model follows MVR 1.6 and reads files from 1.4 onwards. Nodes and fields this
//! reader does not model are skipped, so newer files still load. Fixture features that
//! are recognized but not modelled in detail (custom commands, overwrites and so on) are
//! reported by [`Fixture::unmodelled_features`] so callers can tell the user they were
//! not imported.

use std::collections::HashMap;
use std::sync::OnceLock;

use quick_xml::Reader;
use quick_xml::events::Event;
use serde::Deserialize;
use serde::de::IgnoredAny;
use uuid::Uuid;

use crate::de;
use crate::error::MvrError;
use crate::transform::Transform;
use crate::values::{CieColor, DmxAddress, FixtureAddress};

/// Root node of an MVR scene description.
#[derive(Debug, Clone, Deserialize)]
pub struct GeneralSceneDescription {
    /// Major MVR version the file was written with.
    #[serde(rename = "@verMajor")]
    pub ver_major: u32,
    /// Minor MVR version the file was written with.
    #[serde(rename = "@verMinor")]
    pub ver_minor: u32,
    /// Name of the exporting application (MVR 1.6 and later).
    #[serde(rename = "@provider", default, deserialize_with = "de::opt_text")]
    pub provider: Option<String>,
    /// Version of the exporting application (MVR 1.6 and later).
    #[serde(
        rename = "@providerVersion",
        default,
        deserialize_with = "de::opt_text"
    )]
    pub provider_version: Option<String>,
    /// Application-specific data blocks.
    #[serde(rename = "UserData", default)]
    pub user_data: Option<UserData>,
    /// The scene itself.
    #[serde(rename = "Scene")]
    pub scene: Scene,
}

impl GeneralSceneDescription {
    /// Parses scene description XML and checks that its major version is supported.
    pub fn from_xml(xml: &str) -> Result<Self, MvrError> {
        let xml = xml.strip_prefix('\u{feff}').unwrap_or(xml);
        check_nesting(xml)?;
        let description: Self = quick_xml::de::from_str(xml)?;
        if description.ver_major != 1 {
            return Err(MvrError::UnsupportedVersion {
                major: description.ver_major,
                minor: description.ver_minor,
            });
        }
        Ok(description)
    }

    /// Returns the exporting application's name: the `provider` attribute when present,
    /// otherwise the first provider named in `UserData` (Vectorworks writes it there).
    pub fn provider_name(&self) -> Option<&str> {
        self.provider.as_deref().or_else(|| {
            self.user_data
                .as_ref()?
                .data
                .iter()
                .find_map(|data| data.provider.as_deref())
        })
    }
}

/// Application-specific data attached to the file.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct UserData {
    /// One block per application.
    #[serde(rename = "Data", default)]
    pub data: Vec<UserDataEntry>,
}

/// One application's data block. Only the identifying attributes are kept.
#[derive(Debug, Clone, Deserialize)]
pub struct UserDataEntry {
    /// Application that wrote the block.
    #[serde(rename = "@provider", default, deserialize_with = "de::opt_text")]
    pub provider: Option<String>,
    /// Version of that application's data.
    #[serde(rename = "@ver", default, deserialize_with = "de::opt_text")]
    pub version: Option<String>,
}

/// The scene: shared definitions plus the layers holding every object.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct Scene {
    /// Shared definitions referenced by objects.
    #[serde(rename = "AUXData", default)]
    pub aux_data: Option<AuxData>,
    /// Layers in file order.
    #[serde(rename = "Layers", default)]
    pub layers: Layers,
}

impl Scene {
    /// Returns every hanging position (`Position` in `AUXData`), in file order.
    pub fn positions(&self) -> impl Iterator<Item = &NamedDefinition> {
        self.aux_nodes().filter_map(|node| match node {
            AuxNode::Position(position) => Some(position),
            _ => None,
        })
    }

    /// Returns every class (`Class` in `AUXData`), in file order.
    pub fn classes(&self) -> impl Iterator<Item = &NamedDefinition> {
        self.aux_nodes().filter_map(|node| match node {
            AuxNode::Class(class) => Some(class),
            _ => None,
        })
    }

    /// Returns every symbol definition, in file order.
    pub fn symdefs(&self) -> impl Iterator<Item = &Symdef> {
        self.aux_nodes().filter_map(|node| match node {
            AuxNode::Symdef(symdef) => Some(symdef),
            _ => None,
        })
    }

    /// Finds the hanging position with this UUID.
    pub fn position(&self, uuid: Uuid) -> Option<&NamedDefinition> {
        match self.aux_data.as_ref()?.get(uuid)? {
            AuxNode::Position(position) => Some(position),
            _ => None,
        }
    }

    /// Finds the class with this UUID.
    pub fn class(&self, uuid: Uuid) -> Option<&NamedDefinition> {
        match self.aux_data.as_ref()?.get(uuid)? {
            AuxNode::Class(class) => Some(class),
            _ => None,
        }
    }

    /// Finds the symbol definition with this UUID.
    pub fn symdef(&self, uuid: Uuid) -> Option<&Symdef> {
        match self.aux_data.as_ref()?.get(uuid)? {
            AuxNode::Symdef(symdef) => Some(symdef),
            _ => None,
        }
    }

    /// Iterates the `AUXData` children, or nothing when the scene has none.
    fn aux_nodes(&self) -> impl Iterator<Item = &AuxNode> {
        self.aux_data.iter().flat_map(|aux| aux.nodes.iter())
    }
}

/// Shared definitions that scene objects refer to by UUID.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct AuxData {
    /// Definitions in file order.
    #[serde(rename = "$value", default)]
    pub nodes: Vec<AuxNode>,
    /// Index of each definition in `nodes` by UUID, built on first lookup.
    #[serde(skip)]
    by_uuid: OnceLock<HashMap<Uuid, usize>>,
}

impl AuxData {
    /// Finds the definition with this UUID; the first one wins if a file repeats a UUID.
    pub fn get(&self, uuid: Uuid) -> Option<&AuxNode> {
        let index = self.by_uuid.get_or_init(|| {
            let mut index = HashMap::new();
            for (position, node) in self.nodes.iter().enumerate() {
                if let Some(uuid) = node.uuid() {
                    index.entry(uuid).or_insert(position);
                }
            }
            index
        });
        self.nodes.get(*index.get(&uuid)?)
    }
}

/// One shared definition.
#[derive(Debug, Clone, Deserialize)]
pub enum AuxNode {
    /// Reusable geometry instanced by `Symbol` nodes.
    Symdef(Symdef),
    /// A hanging position such as "LX 1".
    Position(NamedDefinition),
    /// A class objects can belong to.
    Class(NamedDefinition),
    /// A video mapping definition; only its identity is kept.
    MappingDefinition(NamedDefinition),
    /// A definition this reader does not know.
    #[serde(other)]
    Other,
}

impl AuxNode {
    /// Returns the definition's UUID, or `None` for an unknown definition type.
    pub fn uuid(&self) -> Option<Uuid> {
        match self {
            Self::Symdef(symdef) => Some(symdef.uuid),
            Self::Position(definition)
            | Self::Class(definition)
            | Self::MappingDefinition(definition) => Some(definition.uuid),
            Self::Other => None,
        }
    }
}

/// A definition identified by UUID and name.
#[derive(Debug, Clone, Deserialize)]
pub struct NamedDefinition {
    /// Persistent identifier.
    #[serde(rename = "@uuid", deserialize_with = "de::uuid")]
    pub uuid: Uuid,
    /// Display name.
    #[serde(rename = "@name", default)]
    pub name: String,
}

/// Reusable geometry, placed in the scene by `Symbol` nodes.
#[derive(Debug, Clone, Deserialize)]
pub struct Symdef {
    /// Persistent identifier.
    #[serde(rename = "@uuid", deserialize_with = "de::uuid")]
    pub uuid: Uuid,
    /// Display name.
    #[serde(rename = "@name", default)]
    pub name: String,
    /// Geometry making up the definition, in its own local space.
    #[serde(rename = "ChildList", default)]
    pub geometries: Geometries,
}

/// The layers of a scene.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct Layers {
    /// Layers in file order.
    #[serde(rename = "Layer", default)]
    pub layers: Vec<Layer>,
}

/// A layer of the scene, such as "Truss Lights" or "Venue".
#[derive(Debug, Clone, Deserialize)]
pub struct Layer {
    /// Persistent identifier.
    #[serde(rename = "@uuid", deserialize_with = "de::uuid")]
    pub uuid: Uuid,
    /// Display name.
    #[serde(rename = "@name", default)]
    pub name: String,
    /// Placement of the layer; the spec only allows an elevation.
    #[serde(rename = "Matrix", default, deserialize_with = "de::opt_matrix")]
    pub matrix: Option<Transform>,
    /// Objects on the layer.
    #[serde(rename = "ChildList", default)]
    pub children: ChildList,
}

/// Objects contained in a layer, group or other object.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct ChildList {
    /// Objects in file order.
    #[serde(rename = "$value", default)]
    pub nodes: Vec<SceneNode>,
}

/// One object in the scene tree.
#[derive(Debug, Clone, Deserialize)]
pub enum SceneNode {
    /// A generic object with geometry, such as a set piece or the venue.
    SceneObject(GeometryObject),
    /// A group of objects sharing a local coordinate system.
    GroupObject(GroupObject),
    /// A point fixtures can be focused on.
    FocusPoint(GeometryObject),
    /// A lighting fixture or other controllable device.
    Fixture(Box<Fixture>),
    /// A truss section.
    Truss(GeometryObject),
    /// A support such as a motor or a ground support tower.
    Support(GeometryObject),
    /// A video screen.
    VideoScreen(GeometryObject),
    /// A projector.
    Projector(GeometryObject),
    /// An object type this reader does not know.
    #[serde(other)]
    Other,
}

impl SceneNode {
    /// Returns the node's UUID, or `None` for an unknown node type.
    pub fn uuid(&self) -> Option<Uuid> {
        match self {
            Self::SceneObject(object)
            | Self::FocusPoint(object)
            | Self::Truss(object)
            | Self::Support(object)
            | Self::VideoScreen(object)
            | Self::Projector(object) => Some(object.uuid),
            Self::GroupObject(group) => Some(group.uuid),
            Self::Fixture(fixture) => Some(fixture.uuid),
            Self::Other => None,
        }
    }

    /// Returns the node's display name, or `None` for an unknown node type.
    pub fn name(&self) -> Option<&str> {
        match self {
            Self::SceneObject(object)
            | Self::FocusPoint(object)
            | Self::Truss(object)
            | Self::Support(object)
            | Self::VideoScreen(object)
            | Self::Projector(object) => Some(&object.name),
            Self::GroupObject(group) => Some(&group.name),
            Self::Fixture(fixture) => Some(&fixture.name),
            Self::Other => None,
        }
    }

    /// Returns the node's placement inside its parent, or `None` when it has none.
    pub fn matrix(&self) -> Option<&Transform> {
        match self {
            Self::SceneObject(object)
            | Self::FocusPoint(object)
            | Self::Truss(object)
            | Self::Support(object)
            | Self::VideoScreen(object)
            | Self::Projector(object) => object.matrix.as_ref(),
            Self::GroupObject(group) => group.matrix.as_ref(),
            Self::Fixture(fixture) => fixture.matrix.as_ref(),
            Self::Other => None,
        }
    }

    /// Returns the objects nested inside this node.
    pub fn children(&self) -> &[SceneNode] {
        match self {
            Self::SceneObject(object)
            | Self::FocusPoint(object)
            | Self::Truss(object)
            | Self::Support(object)
            | Self::VideoScreen(object)
            | Self::Projector(object) => &object.children.nodes,
            Self::GroupObject(group) => &group.children.nodes,
            Self::Fixture(fixture) => &fixture.children.nodes,
            Self::Other => &[],
        }
    }
}

/// A group of objects sharing a local coordinate system.
#[derive(Debug, Clone, Deserialize)]
pub struct GroupObject {
    /// Persistent identifier.
    #[serde(rename = "@uuid", deserialize_with = "de::uuid")]
    pub uuid: Uuid,
    /// Display name.
    #[serde(rename = "@name", default)]
    pub name: String,
    /// Placement inside the parent.
    #[serde(rename = "Matrix", default, deserialize_with = "de::opt_matrix")]
    pub matrix: Option<Transform>,
    /// Class the group belongs to.
    #[serde(rename = "Classing", default, deserialize_with = "de::opt_uuid")]
    pub class: Option<Uuid>,
    /// Objects in the group.
    #[serde(rename = "ChildList", default)]
    pub children: ChildList,
}

/// A non-fixture object with geometry: scene objects, trusses, supports, video screens,
/// projectors and focus points.
///
/// One shape covers them all, with every optional child any of them may have; [`SceneNode`]
/// records which type it was. Since MVR 1.5 most of these objects can be controllable
/// devices with a GDTF file, DMX addresses and an ID (a motor, a projector, a screen), so
/// those fields are read too. Video sources, projections and scale handling are not.
#[derive(Debug, Clone, Deserialize)]
pub struct GeometryObject {
    /// Persistent identifier.
    #[serde(rename = "@uuid", deserialize_with = "de::uuid")]
    pub uuid: Uuid,
    /// Display name.
    #[serde(rename = "@name", default)]
    pub name: String,
    /// Placement inside the parent.
    #[serde(rename = "Matrix", default, deserialize_with = "de::opt_matrix")]
    pub matrix: Option<Transform>,
    /// Class the object belongs to.
    #[serde(rename = "Classing", default, deserialize_with = "de::opt_uuid")]
    pub class: Option<Uuid>,
    /// Hanging position the object belongs to.
    #[serde(rename = "Position", default, deserialize_with = "de::opt_uuid")]
    pub position: Option<Uuid>,
    /// Purpose of the object, such as "Upstage truss".
    #[serde(rename = "Function", default, deserialize_with = "de::opt_text")]
    pub function: Option<String>,
    /// GDTF file describing the object, when it is a controllable device.
    #[serde(rename = "GDTFSpec", default, deserialize_with = "de::opt_text")]
    pub gdtf_spec: Option<String>,
    /// DMX mode of the GDTF file.
    #[serde(rename = "GDTFMode", default, deserialize_with = "de::opt_text")]
    pub gdtf_mode: Option<String>,
    /// Fixture ID as text, when the object is a controllable device.
    #[serde(rename = "FixtureID", default, deserialize_with = "de::opt_text")]
    pub fixture_id: Option<String>,
    /// Fixture ID as a number (MVR 1.5 and later).
    #[serde(rename = "FixtureIDNumeric", default, deserialize_with = "de::opt_int")]
    pub fixture_id_numeric: Option<i64>,
    /// Number of the object on its hanging position.
    #[serde(rename = "UnitNumber", default, deserialize_with = "de::opt_int")]
    pub unit_number: Option<i64>,
    /// DMX and network addresses, when the object is a controllable device.
    #[serde(rename = "Addresses", default)]
    pub address_list: Addresses,
    /// Protocols the object is controlled with.
    #[serde(rename = "Protocols", default)]
    pub protocols: Protocols,
    /// Geometry representing the object.
    #[serde(rename = "Geometries", default)]
    pub geometries: Geometries,
    /// Objects nested inside this one.
    #[serde(rename = "ChildList", default)]
    pub children: ChildList,
}

impl GeometryObject {
    /// Returns the object's fixture ID as a number, read like [`Fixture::numeric_id`].
    pub fn numeric_id(&self) -> Option<u32> {
        numeric_id(self.fixture_id_numeric, self.fixture_id.as_deref())
    }

    /// Returns the DMX address of each break, read like [`Fixture::addresses`].
    pub fn addresses(&self) -> Vec<Result<FixtureAddress, String>> {
        self.address_list.parsed()
    }
}

/// Geometry representing an object: model files and instances of symbol definitions.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct Geometries {
    /// Geometry nodes in file order.
    #[serde(rename = "$value", default)]
    pub nodes: Vec<GeometryNode>,
}

/// One piece of geometry.
#[derive(Debug, Clone, Deserialize)]
pub enum GeometryNode {
    /// A 3D model file stored in the archive.
    Geometry3D(Geometry3D),
    /// An instance of a symbol definition.
    Symbol(Symbol),
    /// A geometry node this reader does not know.
    #[serde(other)]
    Other,
}

/// A 3D model file (`.3ds`, `.gltf` or `.glb`) stored in the archive.
#[derive(Debug, Clone, Deserialize)]
pub struct Geometry3D {
    /// File name inside the archive. MVR assumes `.3ds` when it has no extension.
    #[serde(rename = "@fileName")]
    pub file_name: String,
    /// Placement of the model inside the owning object; may include scale.
    #[serde(rename = "Matrix", default, deserialize_with = "de::opt_matrix")]
    pub matrix: Option<Transform>,
}

/// An instance of a [`Symdef`].
#[derive(Debug, Clone, Deserialize)]
pub struct Symbol {
    /// Persistent identifier of the instance.
    #[serde(rename = "@uuid", deserialize_with = "de::uuid")]
    pub uuid: Uuid,
    /// The symbol definition providing the geometry.
    #[serde(rename = "@symdef", deserialize_with = "de::uuid")]
    pub symdef: Uuid,
    /// Placement of the instance inside the owning object; may include scale.
    #[serde(rename = "Matrix", default, deserialize_with = "de::opt_matrix")]
    pub matrix: Option<Transform>,
}

/// A lighting fixture or other device described by a GDTF file.
#[derive(Debug, Clone, Deserialize)]
pub struct Fixture {
    /// Persistent identifier, kept by every application the rig passes through.
    #[serde(rename = "@uuid", deserialize_with = "de::uuid")]
    pub uuid: Uuid,
    /// Display name; often the fixture type's name, and not unique.
    #[serde(rename = "@name", default)]
    pub name: String,
    /// UUID of the fixture this one is a multipatch copy of.
    #[serde(rename = "@multipatch", default, deserialize_with = "de::opt_uuid")]
    pub multipatch: Option<Uuid>,
    /// Placement inside the parent.
    #[serde(rename = "Matrix", default, deserialize_with = "de::opt_matrix")]
    pub matrix: Option<Transform>,
    /// Class the fixture belongs to.
    #[serde(rename = "Classing", default, deserialize_with = "de::opt_uuid")]
    pub class: Option<Uuid>,
    /// GDTF file in the archive; exporters sometimes leave out the `.gdtf` extension.
    #[serde(rename = "GDTFSpec", default, deserialize_with = "de::opt_text")]
    pub gdtf_spec: Option<String>,
    /// DMX mode name from the GDTF file.
    #[serde(rename = "GDTFMode", default, deserialize_with = "de::opt_text")]
    pub gdtf_mode: Option<String>,
    /// Focus point the fixture is aimed at.
    #[serde(rename = "Focus", default, deserialize_with = "de::opt_uuid")]
    pub focus: Option<Uuid>,
    /// Whether the fixture casts shadows in renderers.
    #[serde(rename = "CastShadow", default, deserialize_with = "de::opt_bool")]
    pub cast_shadow: Option<bool>,
    /// Whether every pan channel is DMX inverted.
    #[serde(rename = "DMXInvertPan", default, deserialize_with = "de::opt_bool")]
    pub dmx_invert_pan: Option<bool>,
    /// Whether every tilt channel is DMX inverted.
    #[serde(rename = "DMXInvertTilt", default, deserialize_with = "de::opt_bool")]
    pub dmx_invert_tilt: Option<bool>,
    /// Hanging position the fixture belongs to.
    #[serde(rename = "Position", default, deserialize_with = "de::opt_uuid")]
    pub position: Option<Uuid>,
    /// Purpose of the fixture, such as "Key light".
    #[serde(rename = "Function", default, deserialize_with = "de::opt_text")]
    pub function: Option<String>,
    /// Fixture ID as text; may be empty or not a number.
    #[serde(rename = "FixtureID", default, deserialize_with = "de::opt_text")]
    pub fixture_id: Option<String>,
    /// Fixture ID as a number (MVR 1.5 and later).
    #[serde(rename = "FixtureIDNumeric", default, deserialize_with = "de::opt_int")]
    pub fixture_id_numeric: Option<i64>,
    /// Number of the fixture on its hanging position.
    #[serde(rename = "UnitNumber", default, deserialize_with = "de::opt_int")]
    pub unit_number: Option<i64>,
    /// Geometry of the parent fixture's GDTF this fixture is attached to.
    #[serde(rename = "ChildPosition", default, deserialize_with = "de::opt_text")]
    pub child_position: Option<String>,
    /// DMX and network addresses.
    #[serde(rename = "Addresses", default)]
    pub address_list: Addresses,
    /// Protocols the fixture is controlled with.
    #[serde(rename = "Protocols", default)]
    pub protocols: Protocols,
    /// Color assigned to the fixture, such as a gel.
    #[serde(rename = "Color", default, deserialize_with = "de::opt_color")]
    pub color: Option<CieColor>,
    /// Type of the custom ID (fixture, channel, houselights and so on).
    #[serde(rename = "CustomIdType", default, deserialize_with = "de::opt_int")]
    pub custom_id_type: Option<i64>,
    /// Alternative ID within the custom ID type.
    #[serde(rename = "CustomId", default, deserialize_with = "de::opt_int")]
    pub custom_id: Option<i64>,
    /// Objects attached to the fixture.
    #[serde(rename = "ChildList", default)]
    pub children: ChildList,

    #[serde(rename = "Alignments", default)]
    alignments: Option<IgnoredAny>,
    #[serde(rename = "CustomCommands", default)]
    custom_commands: Option<IgnoredAny>,
    #[serde(rename = "Overwrites", default)]
    overwrites: Option<IgnoredAny>,
    #[serde(rename = "Connections", default)]
    connections: Option<IgnoredAny>,
    #[serde(rename = "Mappings", default)]
    mappings: Option<IgnoredAny>,
    #[serde(rename = "Gobo", default)]
    gobo: Option<IgnoredAny>,
}

impl Fixture {
    /// Returns the fixture ID as a number: `FixtureIDNumeric` when above zero, otherwise
    /// `FixtureID` when it is a whole number above zero.
    ///
    /// Exporters write 0 or leave the ID empty for unnumbered fixtures, so neither counts
    /// as an ID.
    pub fn numeric_id(&self) -> Option<u32> {
        numeric_id(self.fixture_id_numeric, self.fixture_id.as_deref())
    }

    /// Returns the DMX address of each break, in file order.
    ///
    /// An address of 0, or an empty one, means the break is not patched. Malformed
    /// addresses are returned as `Err` holding the text, so the caller can report them per
    /// fixture.
    pub fn addresses(&self) -> Vec<Result<FixtureAddress, String>> {
        self.address_list.parsed()
    }

    /// Lists the MVR features present on this fixture that the scene model keeps no
    /// details of, by node name.
    pub fn unmodelled_features(&self) -> Vec<&'static str> {
        [
            ("Alignments", self.alignments.is_some()),
            ("CustomCommands", self.custom_commands.is_some()),
            ("Overwrites", self.overwrites.is_some()),
            ("Connections", self.connections.is_some()),
            ("Mappings", self.mappings.is_some()),
            ("Gobo", self.gobo.is_some()),
        ]
        .into_iter()
        .filter_map(|(name, present)| present.then_some(name))
        .collect()
    }
}

/// DMX and network addresses of a fixture.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct Addresses {
    /// One DMX address per break.
    #[serde(rename = "Address", default)]
    pub addresses: Vec<AddressNode>,
    /// Network addresses of the fixture's interfaces.
    #[serde(rename = "Network", default)]
    pub networks: Vec<NetworkAddress>,
}

impl Addresses {
    /// Parses each `Address` node into its break and DMX address, in file order.
    pub fn parsed(&self) -> Vec<Result<FixtureAddress, String>> {
        self.addresses
            .iter()
            .map(|address| {
                let dmx_break = address.dmx_break.unwrap_or(0);
                DmxAddress::parse(&address.value)
                    .map(|address| FixtureAddress { dmx_break, address })
            })
            .collect()
    }
}

/// A raw `Address` node; [`Addresses::parsed`] parses it.
#[derive(Debug, Clone, Deserialize)]
pub struct AddressNode {
    /// DMX break the address belongs to; missing means 0.
    #[serde(rename = "@break", default, deserialize_with = "de::opt_int")]
    pub dmx_break: Option<u32>,
    /// Absolute address or `universe.channel` text.
    #[serde(rename = "$text", default)]
    pub value: String,
}

/// The network address of one interface of a fixture.
#[derive(Debug, Clone, Deserialize)]
pub struct NetworkAddress {
    /// Interface geometry name, such as `ethernet_1`.
    #[serde(rename = "@geometry", alias = "@Interface", default)]
    pub geometry: String,
    /// IPv4 address.
    #[serde(
        rename = "@ipv4",
        alias = "@IPv4",
        default,
        deserialize_with = "de::opt_text"
    )]
    pub ipv4: Option<String>,
    /// IPv4 subnet mask.
    #[serde(
        rename = "@subnetmask",
        alias = "@SubnetMask",
        default,
        deserialize_with = "de::opt_text"
    )]
    pub subnet_mask: Option<String>,
    /// IPv6 address.
    #[serde(
        rename = "@ipv6",
        alias = "@IPv6",
        default,
        deserialize_with = "de::opt_text"
    )]
    pub ipv6: Option<String>,
    /// Whether the interface gets its address automatically.
    #[serde(
        rename = "@dhcp",
        alias = "@DHCP",
        default,
        deserialize_with = "de::opt_bool"
    )]
    pub dhcp: Option<bool>,
    /// Host name of an automatically addressed device.
    #[serde(rename = "@hostname", default, deserialize_with = "de::opt_text")]
    pub hostname: Option<String>,
}

/// Protocols a fixture is controlled with.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct Protocols {
    /// Protocol assignments in file order.
    #[serde(rename = "Protocol", default)]
    pub protocols: Vec<Protocol>,
}

/// One protocol assignment, such as Art-Net or sACN on a network interface.
#[derive(Debug, Clone, Deserialize)]
pub struct Protocol {
    /// Interface geometry name; the spec default is `NetworkInOut_1`.
    #[serde(rename = "@geometry", default, deserialize_with = "de::opt_text")]
    pub geometry: Option<String>,
    /// Custom name identifying the protocol on this fixture.
    #[serde(rename = "@name", default, deserialize_with = "de::opt_text")]
    pub name: Option<String>,
    /// Protocol name, such as `Art-Net`, `sACN` or `RDMNet`.
    #[serde(rename = "@type", default, deserialize_with = "de::opt_text")]
    pub protocol_type: Option<String>,
    /// Protocol version.
    #[serde(rename = "@version", default, deserialize_with = "de::opt_text")]
    pub version: Option<String>,
    /// Unicast, multicast, broadcast or anycast.
    #[serde(rename = "@transmission", default, deserialize_with = "de::opt_text")]
    pub transmission: Option<String>,
}

/// Deepest element nesting a scene description may have.
///
/// Real rigs nest a few levels of groups and trusses. The cap keeps a hostile file from
/// exhausting the stack, since deserializing and walking the tree both recurse.
pub const MAX_NESTING_DEPTH: usize = 256;

/// Fails when the XML nests elements deeper than [`MAX_NESTING_DEPTH`].
fn check_nesting(xml: &str) -> Result<(), MvrError> {
    let mut reader = Reader::from_str(xml);
    let mut depth = 0usize;
    loop {
        match reader.read_event().map_err(quick_xml::DeError::from)? {
            Event::Start(_) => {
                depth += 1;
                if depth > MAX_NESTING_DEPTH {
                    return Err(MvrError::TooDeeplyNested {
                        limit: MAX_NESTING_DEPTH,
                    });
                }
            }
            Event::End(_) => depth = depth.saturating_sub(1),
            Event::Eof => return Ok(()),
            _ => {}
        }
    }
}

/// Reads a fixture ID: `numeric` when above zero, otherwise `text` when it is a whole
/// number above zero.
///
/// Exporters write 0 or leave the ID empty for unnumbered objects, so neither counts as
/// an ID.
fn numeric_id(numeric: Option<i64>, text: Option<&str>) -> Option<u32> {
    numeric
        .and_then(|id| u32::try_from(id).ok())
        .filter(|id| *id > 0)
        .or_else(|| text?.parse::<u32>().ok().filter(|id| *id > 0))
}
