// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Synthetic GDTF archive builder for tests.
//!
//! Real manufacturer archives cannot be redistributed with the repository, and
//! they rarely isolate a single edge case. [`GdtfBuilder`] writes small,
//! spec-shaped `description.xml` archives so tests can express exactly the
//! structure under test: mode roots, geometry references with DMX breaks,
//! non-contiguous fine bytes, virtual channels, channel functions, sets and
//! the wheels and slots they reference.
//!
//! Enable the `test-support` feature to use this module from other crates.

use std::fmt::Write as _;
use std::io::{Cursor, Write as _};
use std::path::Path;

pub mod invariants;
pub mod reference;

/// Row-major 4x4 matrix as written to GDTF `Position` attributes.
pub type GdtfMatrix = [[f64; 4]; 4];

/// Identity matrix with no rotation or translation.
pub const IDENTITY: GdtfMatrix = [
    [1.0, 0.0, 0.0, 0.0],
    [0.0, 1.0, 0.0, 0.0],
    [0.0, 0.0, 1.0, 0.0],
    [0.0, 0.0, 0.0, 1.0],
];

/// Returns a pure translation matrix in metres.
pub fn translation(x: f64, y: f64, z: f64) -> GdtfMatrix {
    let mut matrix = IDENTITY;
    matrix[0][3] = x;
    matrix[1][3] = y;
    matrix[2][3] = z;
    matrix
}

/// Kind-specific data of a synthetic geometry node.
#[derive(Debug, Clone, PartialEq)]
pub enum GeometryKind {
    /// Plain `<Geometry>` node.
    Generic,
    /// `<Axis>` node that rotates its children.
    Axis,
    /// `<Beam>` light emitter.
    Beam {
        /// GDTF `BeamType` attribute, e.g. `Spot`, `Wash` or `Glow`.
        beam_type: String,
        /// Beam angle in degrees.
        beam_angle: f64,
        /// Field angle in degrees.
        field_angle: f64,
    },
    /// `<FilterColor>` node.
    FilterColor,
    /// `<FilterGobo>` node.
    FilterGobo,
    /// `<GeometryReference>` instancing a top-level geometry.
    Reference {
        /// Name of the referenced top-level geometry.
        geometry: String,
        /// `(DMXBreak, DMXOffset)` pairs for the referenced channels.
        breaks: Vec<(u32, u32)>,
    },
}

/// A synthetic geometry node and its children.
#[derive(Debug, Clone, PartialEq)]
pub struct GeometrySpec {
    /// Geometry name, unique within the fixture type.
    pub name: String,
    /// Node kind and kind-specific attributes.
    pub kind: GeometryKind,
    /// Optional model name.
    pub model: Option<String>,
    /// Local transform relative to the parent.
    pub position: GdtfMatrix,
    /// Child geometries.
    pub children: Vec<GeometrySpec>,
}

impl GeometrySpec {
    /// Creates a node of the given kind at the identity transform.
    fn new(name: &str, kind: GeometryKind) -> Self {
        Self {
            name: name.to_string(),
            kind,
            model: None,
            position: IDENTITY,
            children: Vec::new(),
        }
    }

    /// Creates a plain `<Geometry>` node.
    pub fn generic(name: &str) -> Self {
        Self::new(name, GeometryKind::Generic)
    }

    /// Creates an `<Axis>` node.
    pub fn axis(name: &str) -> Self {
        Self::new(name, GeometryKind::Axis)
    }

    /// Creates a `<Beam>` node with a 20°/25° spot beam.
    pub fn beam(name: &str) -> Self {
        Self::new(
            name,
            GeometryKind::Beam {
                beam_type: "Spot".to_string(),
                beam_angle: 20.0,
                field_angle: 25.0,
            },
        )
    }

    /// Creates a `<GeometryReference>` to a top-level geometry with break offsets.
    pub fn reference(name: &str, geometry: &str, breaks: &[(u32, u32)]) -> Self {
        Self::new(
            name,
            GeometryKind::Reference {
                geometry: geometry.to_string(),
                breaks: breaks.to_vec(),
            },
        )
    }

    /// Sets the local transform.
    pub fn at(mut self, position: GdtfMatrix) -> Self {
        self.position = position;
        self
    }

    /// Sets the model name.
    pub fn with_model(mut self, model: &str) -> Self {
        self.model = Some(model.to_string());
        self
    }

    /// Appends a child geometry.
    pub fn child(mut self, child: GeometrySpec) -> Self {
        self.children.push(child);
        self
    }
}

/// A `<Model>` definition.
#[derive(Debug, Clone, PartialEq)]
pub struct ModelSpec {
    /// Model name referenced by geometries.
    pub name: String,
    /// GDTF primitive type, e.g. `Cube` or `Head`.
    pub primitive_type: String,
    /// Length, width and height in metres.
    pub dimensions: [f64; 3],
}

/// A `<Slot>` on a wheel.
#[derive(Debug, Clone, PartialEq)]
pub struct SlotSpec {
    /// Slot name, unique within the wheel.
    pub name: String,
    /// CIE 1931 `(x, y, Y)` colour; always written because the parser rejects slots without one.
    pub color: [f64; 3],
    /// Optional PNG name (without extension) under `wheels/` in the archive.
    pub media: Option<String>,
}

impl SlotSpec {
    /// Creates an open (D65 white, full transmission) slot with no media.
    pub fn new(name: &str) -> Self {
        Self {
            name: name.to_string(),
            color: [0.3127, 0.329, 100.0],
            media: None,
        }
    }

    /// Sets the slot colour as CIE 1931 `x`, `y` and luminance `Y`.
    pub fn color(mut self, x: f64, y: f64, luminance: f64) -> Self {
        self.color = [x, y, luminance];
        self
    }

    /// Links a media file under `wheels/`; add the file itself with [`GdtfBuilder::file`].
    pub fn media(mut self, media: &str) -> Self {
        self.media = Some(media.to_string());
        self
    }
}

/// A `<Wheel>` definition referenced by channel functions.
#[derive(Debug, Clone, PartialEq)]
pub struct WheelSpec {
    /// Wheel name referenced by [`FunctionSpec::wheel`].
    pub name: String,
    /// Slots in order; channel sets address them by 1-based index.
    pub slots: Vec<SlotSpec>,
}

impl WheelSpec {
    /// Creates an empty wheel.
    pub fn new(name: &str) -> Self {
        Self {
            name: name.to_string(),
            slots: Vec::new(),
        }
    }

    /// Appends a slot.
    pub fn slot(mut self, slot: SlotSpec) -> Self {
        self.slots.push(slot);
        self
    }
}

/// A `<ChannelSet>` inside a channel function.
#[derive(Debug, Clone, PartialEq)]
pub struct ChannelSetSpec {
    /// Set name.
    pub name: String,
    /// DMX start value in the channel's resolution.
    pub dmx_from: u32,
    /// Optional wheel slot index (1-based).
    pub wheel_slot_index: Option<i32>,
}

/// A `<ChannelFunction>` inside a logical channel.
#[derive(Debug, Clone, PartialEq)]
pub struct FunctionSpec {
    /// Function name.
    pub name: String,
    /// GDTF attribute name.
    pub attribute: String,
    /// DMX start value in the channel's resolution.
    pub dmx_from: u32,
    /// Default DMX value in the channel's resolution.
    pub default: u32,
    /// Physical value at `dmx_from`.
    pub physical_from: f64,
    /// Physical value at the end of the function's range.
    pub physical_to: f64,
    /// Optional wheel name.
    pub wheel: Option<String>,
    /// Optional emitter name.
    pub emitter: Option<String>,
    /// Channel sets within the function.
    pub sets: Vec<ChannelSetSpec>,
}

impl FunctionSpec {
    /// Creates a function spanning the whole channel with a 0..1 physical range.
    pub fn new(attribute: &str) -> Self {
        Self {
            name: attribute.to_string(),
            attribute: attribute.to_string(),
            dmx_from: 0,
            default: 0,
            physical_from: 0.0,
            physical_to: 1.0,
            wheel: None,
            emitter: None,
            sets: Vec::new(),
        }
    }

    /// Sets the function name.
    pub fn named(mut self, name: &str) -> Self {
        self.name = name.to_string();
        self
    }

    /// Sets the DMX start value.
    pub fn from_dmx(mut self, dmx_from: u32) -> Self {
        self.dmx_from = dmx_from;
        self
    }

    /// Sets the default DMX value.
    pub fn default_dmx(mut self, default: u32) -> Self {
        self.default = default;
        self
    }

    /// Sets the physical range.
    pub fn physical(mut self, from: f64, to: f64) -> Self {
        self.physical_from = from;
        self.physical_to = to;
        self
    }

    /// Links a wheel by name.
    pub fn wheel(mut self, wheel: &str) -> Self {
        self.wheel = Some(wheel.to_string());
        self
    }

    /// Links an emitter by name.
    pub fn emitter(mut self, emitter: &str) -> Self {
        self.emitter = Some(emitter.to_string());
        self
    }

    /// Appends a channel set.
    pub fn set(mut self, name: &str, dmx_from: u32, wheel_slot_index: Option<i32>) -> Self {
        self.sets.push(ChannelSetSpec {
            name: name.to_string(),
            dmx_from,
            wheel_slot_index,
        });
        self
    }
}

/// DMX break assignment of a channel.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BreakSpec {
    /// Fixed break number.
    Value(u32),
    /// Break is supplied by each geometry reference.
    Overwrite,
}

/// A `<DMXChannel>` definition.
#[derive(Debug, Clone, PartialEq)]
pub struct ChannelSpec {
    /// Geometry the channel controls.
    pub geometry: String,
    /// DMX break.
    pub dmx_break: BreakSpec,
    /// Footprint-relative slots, most significant first. `None` marks a virtual channel.
    pub offsets: Option<Vec<i32>>,
    /// Highlight DMX value in the channel's resolution.
    pub highlight: Option<u32>,
    /// Logical channel attribute.
    pub attribute: String,
    /// Whether the logical channel snaps.
    pub snap: bool,
    /// Channel functions; a single whole-range function is used when empty.
    pub functions: Vec<FunctionSpec>,
}

impl ChannelSpec {
    /// Creates a channel on break 1 at the given slots.
    pub fn new(geometry: &str, attribute: &str, offsets: &[i32]) -> Self {
        Self {
            geometry: geometry.to_string(),
            dmx_break: BreakSpec::Value(1),
            offsets: Some(offsets.to_vec()),
            highlight: None,
            attribute: attribute.to_string(),
            snap: false,
            functions: Vec::new(),
        }
    }

    /// Creates a virtual channel that occupies no DMX slots.
    pub fn virtual_channel(geometry: &str, attribute: &str) -> Self {
        Self {
            offsets: None,
            ..Self::new(geometry, attribute, &[])
        }
    }

    /// Sets the DMX break.
    pub fn on_break(mut self, dmx_break: BreakSpec) -> Self {
        self.dmx_break = dmx_break;
        self
    }

    /// Sets the highlight value.
    pub fn highlight(mut self, value: u32) -> Self {
        self.highlight = Some(value);
        self
    }

    /// Marks the logical channel as snapping.
    pub fn snap(mut self) -> Self {
        self.snap = true;
        self
    }

    /// Appends a channel function.
    pub fn function(mut self, function: FunctionSpec) -> Self {
        self.functions.push(function);
        self
    }

    /// Returns the number of bytes the channel's values are expressed in.
    fn byte_count(&self) -> usize {
        self.offsets
            .as_ref()
            .map_or(1, |offsets| offsets.len().max(1))
    }
}

/// A `<DMXMode>` definition.
#[derive(Debug, Clone, PartialEq)]
pub struct ModeSpec {
    /// Mode name.
    pub name: String,
    /// Root geometry of the mode.
    pub geometry: String,
    /// Channels in declaration order.
    pub channels: Vec<ChannelSpec>,
}

impl ModeSpec {
    /// Creates an empty mode rooted at `geometry`.
    pub fn new(name: &str, geometry: &str) -> Self {
        Self {
            name: name.to_string(),
            geometry: geometry.to_string(),
            channels: Vec::new(),
        }
    }

    /// Appends a channel.
    pub fn channel(mut self, channel: ChannelSpec) -> Self {
        self.channels.push(channel);
        self
    }
}

/// Builder for a single-fixture-type GDTF archive.
#[derive(Debug, Clone, PartialEq)]
pub struct GdtfBuilder {
    manufacturer: String,
    name: String,
    wheels: Vec<WheelSpec>,
    long_name: Option<String>,
    models: Vec<ModelSpec>,
    geometries: Vec<GeometrySpec>,
    modes: Vec<ModeSpec>,
    extra_files: Vec<(String, Vec<u8>)>,
}

impl GdtfBuilder {
    /// Creates a builder for a fixture type with the given long name.
    pub fn new(manufacturer: &str, name: &str) -> Self {
        Self {
            manufacturer: manufacturer.to_string(),
            name: name.to_string(),
            wheels: Vec::new(),
            long_name: None,
            models: Vec::new(),
            geometries: Vec::new(),
            modes: Vec::new(),
            extra_files: Vec::new(),
        }
    }

    /// Adds a wheel definition.
    pub fn wheel(mut self, wheel: WheelSpec) -> Self {
        self.wheels.push(wheel);
        self
    }

    /// Overrides the `LongName` attribute, which otherwise repeats the name.
    pub fn long_name(mut self, long_name: &str) -> Self {
        self.long_name = Some(long_name.to_string());
        self
    }

    /// Adds a model definition.
    pub fn model(mut self, name: &str, primitive_type: &str, dimensions: [f64; 3]) -> Self {
        self.models.push(ModelSpec {
            name: name.to_string(),
            primitive_type: primitive_type.to_string(),
            dimensions,
        });
        self
    }

    /// Adds a top-level geometry.
    pub fn geometry(mut self, geometry: GeometrySpec) -> Self {
        self.geometries.push(geometry);
        self
    }

    /// Adds a DMX mode.
    pub fn mode(mut self, mode: ModeSpec) -> Self {
        self.modes.push(mode);
        self
    }

    /// Adds an arbitrary archive entry, e.g. a mesh or wheel image.
    pub fn file(mut self, path: &str, bytes: &[u8]) -> Self {
        self.extra_files.push((path.to_string(), bytes.to_vec()));
        self
    }

    /// Renders `description.xml`.
    pub fn description_xml(&self) -> String {
        let mut xml = String::new();
        xml.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<GDTF DataVersion=\"1.2\">\n");
        let _ = writeln!(
            xml,
            "<FixtureType Name=\"{name}\" ShortName=\"{name}\" LongName=\"{long_name}\" Manufacturer=\"{make}\" Description=\"Synthetic test fixture\" FixtureTypeID=\"00000000-0000-0000-0000-000000000001\" RefFT=\"\" Thumbnail=\"\">",
            name = escape(&self.name),
            long_name = escape(self.long_name.as_deref().unwrap_or(&self.name)),
            make = escape(&self.manufacturer),
        );
        self.write_attribute_definitions(&mut xml);
        self.write_wheels(&mut xml);
        xml.push_str("<PhysicalDescriptions/>\n<Models>\n");
        for model in &self.models {
            let _ = writeln!(
                xml,
                "<Model Name=\"{}\" Length=\"{}\" Width=\"{}\" Height=\"{}\" PrimitiveType=\"{}\"/>",
                escape(&model.name),
                model.dimensions[0],
                model.dimensions[1],
                model.dimensions[2],
                escape(&model.primitive_type),
            );
        }
        xml.push_str("</Models>\n<Geometries>\n");
        for geometry in &self.geometries {
            write_geometry(&mut xml, geometry);
        }
        xml.push_str("</Geometries>\n<DMXModes>\n");
        for mode in &self.modes {
            write_mode(&mut xml, mode);
        }
        xml.push_str("</DMXModes>\n</FixtureType>\n</GDTF>\n");
        xml
    }

    /// Writes the archive into memory.
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("description.xml", options)
            .expect("start description.xml");
        zip.write_all(self.description_xml().as_bytes())
            .expect("write description.xml");
        for (path, bytes) in &self.extra_files {
            zip.start_file(path.as_str(), options)
                .expect("start archive entry");
            zip.write_all(bytes).expect("write archive entry");
        }
        zip.finish().expect("finish archive").into_inner()
    }

    /// Writes the archive to `path`.
    pub fn write_to(&self, path: &Path) {
        std::fs::write(path, self.to_bytes()).expect("write synthetic GDTF archive");
    }

    /// Writes the archive as `<name>.gdtf` in `dir` and reads its library metadata.
    pub fn write_metadata(&self, dir: &Path) -> crate::GdtfMetadata {
        let path = dir.join(format!("{}.gdtf", self.name.replace(['/', '\\'], "_")));
        self.write_to(&path);
        crate::GdtfMetadata::from_file(&path).expect("synthetic GDTF metadata")
    }

    /// Parses the archive with the production parser.
    pub fn parse(&self) -> gdtf::GdtfFile {
        gdtf::GdtfFile::new(Cursor::new(self.to_bytes())).expect("synthetic GDTF parses")
    }

    /// Emits one attribute definition per distinct attribute used by any channel function.
    fn write_attribute_definitions(&self, xml: &mut String) {
        let mut names: Vec<&str> = Vec::new();
        for channel in self.modes.iter().flat_map(|mode| &mode.channels) {
            names.push(&channel.attribute);
            names.extend(channel.functions.iter().map(|f| f.attribute.as_str()));
        }
        names.sort_unstable();
        names.dedup();

        xml.push_str("<AttributeDefinitions>\n<FeatureGroups>\n<FeatureGroup Name=\"Control\" Pretty=\"Control\"><Feature Name=\"Control\"/></FeatureGroup>\n</FeatureGroups>\n<Attributes>\n");
        for name in names {
            let _ = writeln!(
                xml,
                "<Attribute Name=\"{name}\" Pretty=\"{name}\" Feature=\"Control.Control\" PhysicalUnit=\"{}\"/>",
                physical_unit(name),
                name = escape(name),
            );
        }
        xml.push_str("</Attributes>\n</AttributeDefinitions>\n");
    }

    /// Emits the `<Wheels>` collection with each wheel's slots in declaration order.
    fn write_wheels(&self, xml: &mut String) {
        xml.push_str("<Wheels>\n");
        for wheel in &self.wheels {
            let _ = writeln!(xml, "<Wheel Name=\"{}\">", escape(&wheel.name));
            for slot in &wheel.slots {
                let [x, y, luminance] = slot.color;
                let media = slot
                    .media
                    .as_ref()
                    .map(|media| format!(" MediaFileName=\"{}\"", escape(media)))
                    .unwrap_or_default();
                let _ = writeln!(
                    xml,
                    "<Slot Name=\"{}\" Color=\"{x},{y},{luminance}\"{media}/>",
                    escape(&slot.name)
                );
            }
            xml.push_str("</Wheel>\n");
        }
        xml.push_str("</Wheels>\n");
    }
}

/// Returns the GDTF physical unit conventionally used for an attribute.
fn physical_unit(attribute: &str) -> &'static str {
    match attribute {
        "Pan" | "Tilt" | "Zoom" | "Focus1" | "Gobo1Pos" | "Prism1Pos" => "Angle",
        "PanRotate" | "TiltRotate" | "Gobo1PosRotate" => "AngularSpeed",
        "CTC" => "Temperature",
        _ => "None",
    }
}

/// Writes a geometry element and its children.
fn write_geometry(xml: &mut String, geometry: &GeometrySpec) {
    let (tag, extra) = match &geometry.kind {
        GeometryKind::Generic => ("Geometry", String::new()),
        GeometryKind::Axis => ("Axis", String::new()),
        GeometryKind::Beam {
            beam_type,
            beam_angle,
            field_angle,
        } => (
            "Beam",
            format!(
                " LampType=\"LED\" BeamType=\"{}\" BeamAngle=\"{beam_angle}\" FieldAngle=\"{field_angle}\" LuminousFlux=\"1000\" ColorTemperature=\"6000\" BeamRadius=\"0.05\"",
                escape(beam_type)
            ),
        ),
        GeometryKind::FilterColor => ("FilterColor", String::new()),
        GeometryKind::FilterGobo => ("FilterGobo", String::new()),
        GeometryKind::Reference {
            geometry: target, ..
        } => (
            "GeometryReference",
            format!(" Geometry=\"{}\"", escape(target)),
        ),
    };
    let model = geometry
        .model
        .as_ref()
        .map(|model| format!(" Model=\"{}\"", escape(model)))
        .unwrap_or_default();
    let _ = write!(
        xml,
        "<{tag} Name=\"{}\"{model} Position=\"{}\"{extra}",
        escape(&geometry.name),
        format_matrix(&geometry.position),
    );

    let breaks = match &geometry.kind {
        GeometryKind::Reference { breaks, .. } => breaks.as_slice(),
        _ => &[],
    };
    if geometry.children.is_empty() && breaks.is_empty() {
        xml.push_str("/>\n");
        return;
    }
    xml.push_str(">\n");
    for (dmx_break, dmx_offset) in breaks {
        let _ = writeln!(
            xml,
            "<Break DMXBreak=\"{dmx_break}\" DMXOffset=\"{dmx_offset}\"/>"
        );
    }
    for child in &geometry.children {
        write_geometry(xml, child);
    }
    let _ = writeln!(xml, "</{tag}>");
}

/// Writes a DMX mode and its channels.
fn write_mode(xml: &mut String, mode: &ModeSpec) {
    let _ = writeln!(
        xml,
        "<DMXMode Name=\"{}\" Geometry=\"{}\">\n<DMXChannels>",
        escape(&mode.name),
        escape(&mode.geometry),
    );
    for channel in &mode.channels {
        write_channel(xml, channel);
    }
    xml.push_str("</DMXChannels>\n<Relations/>\n<FTMacros/>\n</DMXMode>\n");
}

/// Writes a DMX channel with its single logical channel and functions.
fn write_channel(xml: &mut String, channel: &ChannelSpec) {
    let bytes = channel.byte_count();
    let dmx_break = match channel.dmx_break {
        BreakSpec::Value(value) => value.to_string(),
        BreakSpec::Overwrite => "Overwrite".to_string(),
    };
    let offset = match &channel.offsets {
        Some(offsets) => offsets
            .iter()
            .map(i32::to_string)
            .collect::<Vec<_>>()
            .join(","),
        None => "None".to_string(),
    };
    let highlight = channel
        .highlight
        .map(|value| format!(" Highlight=\"{}\"", dmx_value(value, bytes)))
        .unwrap_or_else(|| " Highlight=\"None\"".to_string());
    let _ = writeln!(
        xml,
        "<DMXChannel DMXBreak=\"{dmx_break}\" Offset=\"{offset}\"{highlight} Geometry=\"{}\">",
        escape(&channel.geometry),
    );
    let _ = writeln!(
        xml,
        "<LogicalChannel Attribute=\"{}\" Snap=\"{}\" Master=\"None\">",
        escape(&channel.attribute),
        if channel.snap { "Yes" } else { "No" },
    );

    let default_function = [FunctionSpec::new(&channel.attribute)];
    let functions = if channel.functions.is_empty() {
        &default_function[..]
    } else {
        &channel.functions[..]
    };
    for function in functions {
        let wheel = function
            .wheel
            .as_ref()
            .map(|wheel| format!(" Wheel=\"{}\"", escape(wheel)))
            .unwrap_or_default();
        let emitter = function
            .emitter
            .as_ref()
            .map(|emitter| format!(" Emitter=\"{}\"", escape(emitter)))
            .unwrap_or_default();
        let _ = write!(
            xml,
            "<ChannelFunction Name=\"{}\" Attribute=\"{}\" DMXFrom=\"{}\" Default=\"{}\" PhysicalFrom=\"{}\" PhysicalTo=\"{}\"{wheel}{emitter}",
            escape(&function.name),
            escape(&function.attribute),
            dmx_value(function.dmx_from, bytes),
            dmx_value(function.default, bytes),
            function.physical_from,
            function.physical_to,
        );
        if function.sets.is_empty() {
            xml.push_str("/>\n");
            continue;
        }
        xml.push_str(">\n");
        for set in &function.sets {
            let slot = set
                .wheel_slot_index
                .map(|index| format!(" WheelSlotIndex=\"{index}\""))
                .unwrap_or_default();
            let _ = writeln!(
                xml,
                "<ChannelSet Name=\"{}\" DMXFrom=\"{}\"{slot}/>",
                escape(&set.name),
                dmx_value(set.dmx_from, bytes),
            );
        }
        xml.push_str("</ChannelFunction>\n");
    }
    xml.push_str("</LogicalChannel>\n</DMXChannel>\n");
}

/// Formats a DMX value in GDTF `value/bytes` notation.
fn dmx_value(value: u32, bytes: usize) -> String {
    format!("{value}/{bytes}")
}

/// Formats a matrix in GDTF `{a,b,c,d}{...}` notation.
fn format_matrix(matrix: &GdtfMatrix) -> String {
    matrix
        .iter()
        .map(|row| {
            format!(
                "{{{}}}",
                row.iter().map(f64::to_string).collect::<Vec<_>>().join(",")
            )
        })
        .collect()
}

/// Escapes XML attribute content.
fn escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

#[cfg(test)]
mod tests {
    use gdtf::dmx_mode::DmxBreak;
    use gdtf::geometry::{AnyGeometry, Geometry};

    use super::*;

    /// Builds a two-pixel fixture using a geometry reference template and overwrite breaks.
    fn referenced_pixels() -> GdtfBuilder {
        GdtfBuilder::new("Test", "Pixels")
            .model("Body", "Cube", [1.0, 0.2, 0.1])
            .geometry(
                GeometrySpec::generic("Body")
                    .with_model("Body")
                    .child(GeometrySpec::reference("Pixel 1", "Pixel", &[(1, 2)]))
                    .child(
                        GeometrySpec::reference("Pixel 2", "Pixel", &[(1, 5)])
                            .at(translation(0.1, 0.0, 0.0)),
                    ),
            )
            .geometry(GeometrySpec::beam("Pixel"))
            .mode(
                ModeSpec::new("Mode 1", "Body")
                    .channel(ChannelSpec::new("Body", "Dimmer", &[1]))
                    .channel(
                        ChannelSpec::new("Pixel", "ColorAdd_R", &[1])
                            .on_break(BreakSpec::Overwrite),
                    )
                    .channel(
                        ChannelSpec::new("Pixel", "ColorAdd_G", &[2])
                            .on_break(BreakSpec::Overwrite),
                    )
                    .channel(
                        ChannelSpec::new("Pixel", "ColorAdd_B", &[3])
                            .on_break(BreakSpec::Overwrite),
                    ),
            )
    }

    /// Verifies the production parser reads references, overwrite breaks and offsets from builder output.
    #[test]
    fn builder_output_parses_with_references_and_breaks() {
        let gdtf = referenced_pixels().parse();
        let fixture_type = &gdtf.description.fixture_types[0];
        assert_eq!(fixture_type.geometries.len(), 2);

        let body = &fixture_type.geometries[0];
        let Geometry::Reference(pixel_2) = &body.children()[1] else {
            panic!("expected geometry reference");
        };
        assert_eq!(pixel_2.breaks[0].dmx_offset.absolute(), 5);

        let mode = &fixture_type.dmx_modes[0];
        assert_eq!(mode.geometry.as_ref().unwrap().as_ref(), "Body");
        assert_eq!(mode.dmx_channels[1].dmx_break, DmxBreak::Overwrite);
        assert_eq!(mode.dmx_channels[3].offset, Some(vec![3]));
    }

    /// Verifies non-contiguous multi-byte offsets, virtual channels, highlight and channel sets round-trip.
    #[test]
    fn builder_output_parses_channel_details() {
        let gdtf = GdtfBuilder::new("Test", "Details")
            .geometry(GeometrySpec::generic("Base").child(GeometrySpec::axis("Arm")))
            .mode(
                ModeSpec::new("Sparse", "Base")
                    .channel(
                        ChannelSpec::new("Arm", "Tilt", &[1, 5]).function(
                            FunctionSpec::new("Tilt")
                                .physical(-135.0, 135.0)
                                .default_dmx(32768),
                        ),
                    )
                    .channel(ChannelSpec::virtual_channel("Base", "Dimmer"))
                    .channel(
                        ChannelSpec::new("Base", "Gobo1", &[3])
                            .highlight(0)
                            .function(
                                FunctionSpec::new("Gobo1")
                                    .wheel("Gobo Wheel")
                                    .set("Open", 0, Some(1))
                                    .set("Gobo 1", 10, Some(2)),
                            ),
                    ),
            )
            .parse();
        let mode = &gdtf.description.fixture_types[0].dmx_modes[0];
        assert_eq!(mode.dmx_channels[0].offset, Some(vec![1, 5]));
        let tilt = &mode.dmx_channels[0].logical_channels[0].channel_functions[0];
        assert_eq!(tilt.physical_from, -135.0);
        assert_eq!(tilt.default.value(), 32768);
        assert_eq!(mode.dmx_channels[1].offset, None);
        let gobo = &mode.dmx_channels[2];
        assert_eq!(gobo.highlight.map(|value| value.value()), Some(0));
        let sets = &gobo.logical_channels[0].channel_functions[0].channel_sets;
        assert_eq!(sets.len(), 2);
        // The parser stores wheel slot indices zero-based.
        assert_eq!(sets[1].wheel_slot_index, Some(1));
    }

    /// Verifies channel functions resolve their wheel and channel sets resolve slots, colours and media.
    #[test]
    fn builder_output_resolves_wheels_and_slots() {
        let mut gdtf = GdtfBuilder::new("Test", "Wheels")
            .wheel(
                WheelSpec::new("Gobo Wheel")
                    .slot(SlotSpec::new("Open"))
                    .slot(SlotSpec::new("Gobo 1").media("gobo1")),
            )
            .wheel(WheelSpec::new("Color Wheel").slot(SlotSpec::new("Red").color(0.64, 0.33, 21.3)))
            .file("wheels/gobo1.png", b"png-bytes")
            .geometry(GeometrySpec::generic("Base"))
            .mode(
                ModeSpec::new("Mode 1", "Base").channel(
                    ChannelSpec::new("Base", "Gobo1", &[1]).function(
                        FunctionSpec::new("Gobo1")
                            .wheel("Gobo Wheel")
                            .set("Open", 0, Some(1))
                            .set("Gobo 1", 10, Some(2)),
                    ),
                ),
            )
            .parse();

        let fixture_type = &gdtf.description.fixture_types[0];
        let function =
            &fixture_type.dmx_modes[0].dmx_channels[0].logical_channels[0].channel_functions[0];
        let wheel = function
            .wheel(fixture_type)
            .expect("function resolves its wheel");
        let slot = function.channel_sets[1]
            .wheel_slot(wheel)
            .expect("channel set resolves its slot");
        assert_eq!(slot.name.as_ref().unwrap().as_ref(), "Gobo 1");
        assert_eq!(slot.media_name.as_deref(), Some("gobo1"));

        let red = fixture_type
            .wheel("Color Wheel")
            .unwrap()
            .slot("Red")
            .unwrap();
        let gdtf::wheel::WheelSlotOptic::Color(color) = &red.optic else {
            panic!("expected colour optic");
        };
        assert_eq!((color.x, color.y, color.z), (0.64, 0.33, 21.3));

        let wheel_errors: Vec<_> = gdtf
            .validate()
            .errors
            .into_iter()
            .filter(|error| {
                use gdtf::{ValidationErrorType, ValidationObject};
                matches!(
                    error.object,
                    ValidationObject::Wheel | ValidationObject::WheelSlot
                ) || matches!(
                    error.ty,
                    ValidationErrorType::LinkNotFound(
                        ValidationObject::Wheel | ValidationObject::WheelSlot,
                        _
                    )
                )
            })
            .collect();
        assert!(wheel_errors.is_empty(), "{wheel_errors:?}");
    }

    /// Verifies extra archive entries are readable through the resource map.
    #[test]
    fn builder_writes_extra_archive_entries() {
        let mut gdtf = GdtfBuilder::new("Test", "Files")
            .geometry(GeometrySpec::generic("Base"))
            .file("wheels/gobo1.png", b"png-bytes")
            .parse();
        let resource = gdtf
            .resources
            .read_wheel_media("gobo1")
            .expect("wheel media");
        assert_eq!(resource.size(), 9);
    }

    /// Verifies geometry names and transforms survive rendering and parsing.
    #[test]
    fn builder_writes_positions() {
        let gdtf = referenced_pixels().parse();
        let body = &gdtf.description.fixture_types[0].geometries[0];
        assert_eq!(body.children()[1].name().unwrap().as_ref(), "Pixel 2");
    }
}
