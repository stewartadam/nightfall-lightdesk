// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! What the client sends to shape an import and what the engine shows back before it.

use nightfall_fixtures::prelude::FixturePlacement;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// How the imported fixtures get their Nightfall fixture IDs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(tag = "type", content = "data")]
#[typeshare::typeshare]
pub enum FixtureNumbering {
    /// Keep each fixture's ID from the file. Fixtures without one, or whose ID is already
    /// used, are numbered after the highest ID in use.
    #[default]
    FromFile,
    /// Add a fixed amount to each fixture's ID from the file, numbering the rest as for
    /// `FromFile`.
    Offset {
        /// Amount added to every ID.
        by: u32,
    },
    /// Number the fixtures in file order from `start`, skipping IDs already in use.
    Sequential {
        /// First ID to use.
        start: u32,
    },
}

/// A library fixture to use for a fixture type the file does not include.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[typeshare::typeshare]
pub struct FixtureTypeMapping {
    /// `GDTFSpec` of the fixture type in the file.
    pub spec: String,
    /// Library manufacturer.
    pub make: String,
    /// Library model.
    pub model: String,
    /// Library revision, or the default one when empty.
    pub revision: Option<String>,
    /// Mode used for every fixture of the type.
    pub mode: String,
}

/// What the import groups fixtures by.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[typeshare::typeshare]
pub enum RigGroupSource {
    /// Hanging positions when the file has any, otherwise layers.
    #[default]
    Auto,
    /// Make no groups.
    None,
    /// One group per hanging position ("LX 1", "FOH truss").
    HangingPositions,
    /// One group per layer.
    Layers,
    /// One group per class.
    Classes,
}

/// Choices that shape an import.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
#[typeshare::typeshare]
pub struct RigImportOptions {
    /// How fixture IDs are chosen.
    pub numbering: FixtureNumbering,
    /// Move, repatch and rename fixtures already in the show to match the file. When off,
    /// they are left as they are.
    pub update_existing: bool,
    /// What the import makes groups from.
    pub groups: RigGroupSource,
    /// Also copy fixture types from the file into the user's fixture library, not only
    /// into the show.
    pub add_to_user_library: bool,
    /// Library fixtures standing in for types the file leaves out or that should be
    /// replaced.
    pub type_mappings: Vec<FixtureTypeMapping>,
}

impl Default for RigImportOptions {
    /// Keeps file IDs, updates fixtures already in the show and groups automatically.
    fn default() -> Self {
        Self {
            numbering: FixtureNumbering::default(),
            update_existing: true,
            groups: RigGroupSource::default(),
            add_to_user_library: false,
            type_mappings: Vec::new(),
        }
    }
}

/// Where the definition of a fixture type comes from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "data")]
#[typeshare::typeshare]
pub enum FixtureTypeStatus {
    /// The library already has exactly this GDTF.
    InLibrary,
    /// The GDTF comes from the file and is added to the show on import.
    Embedded,
    /// A library fixture chosen in the options stands in for it.
    Mapped,
    /// The file names the type but does not include it, so a library fixture must be
    /// chosen.
    Missing,
    /// The file includes the type, but it cannot be read.
    Unreadable {
        /// Why it cannot be read.
        reason: String,
    },
}

/// A fixture type in the file and how the import resolves it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[typeshare::typeshare]
pub struct FixtureTypePreview {
    /// `GDTFSpec` naming the type in the file.
    pub spec: String,
    /// Manufacturer, when known.
    pub make: Option<String>,
    /// Model, when known.
    pub model: Option<String>,
    /// Modes the type offers.
    pub modes: Vec<String>,
    /// Where its definition comes from.
    pub status: FixtureTypeStatus,
    /// Number of fixtures of this type in the file.
    pub fixture_count: u32,
}

/// What the import does with a fixture.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub enum FixtureImportStatus {
    /// The fixture is added to the show.
    New,
    /// A fixture with this UUID is in the show and is changed to match the file.
    Update,
    /// A fixture with this UUID is in the show and already matches the file.
    Unchanged,
    /// A fixture with this UUID is in the show and differs from the file, but updates are
    /// turned off, so it is left alone.
    AlreadyInShow,
    /// An earlier fixture in the file has the same UUID, so this one is skipped.
    RepeatedInFile,
    /// The fixture's type is missing or unreadable and has no stand-in.
    NeedsFixtureType,
    /// The fixture names a mode its type does not have.
    NeedsMode,
}

/// One break of a fixture's patch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[typeshare::typeshare]
pub struct PatchPreview {
    /// DMX break, starting at 1.
    pub dmx_break: u16,
    /// Console universe, starting at 1.
    pub universe: u16,
    /// Start address within the universe.
    pub address: u16,
}

/// A fixture in the file and what the import does with it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[typeshare::typeshare]
pub struct FixturePreview {
    /// MVR UUID, used as the fixture's UID.
    #[serde(with = "nightfall::serde_uuid_simple")]
    #[typeshare(serialized_as = "String")]
    pub uid: Uuid,
    /// Name in the file.
    pub name: String,
    /// `GDTFSpec` naming the fixture type, if any.
    pub spec: Option<String>,
    /// Mode the fixture is created in, when it resolves.
    pub mode: Option<String>,
    /// Fixture ID written in the file.
    pub file_id: Option<u32>,
    /// Nightfall fixture ID: the one it gets for new fixtures, or the one it has for
    /// fixtures already in the show.
    pub fixture_id: Option<u32>,
    /// Nightfall label; empty when the name only repeats the fixture type.
    pub label: String,
    /// Patched breaks.
    pub patch: Vec<PatchPreview>,
    /// Position and rotation in Nightfall space.
    pub placement: FixturePlacement,
    /// Layer in the file.
    pub layer: String,
    /// Hanging position in the file, if any.
    pub hanging_position: Option<String>,
    /// Class in the file, if any.
    pub class: Option<String>,
    /// What the import does with it.
    pub status: FixtureImportStatus,
    /// How a fixture already in the show differs from the file ("moved", "repatched").
    pub changes: Vec<String>,
    /// Details the import leaves out or adjusts.
    pub warnings: Vec<String>,
}

/// A group the import makes or refreshes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[typeshare::typeshare]
pub struct GroupPreview {
    /// Group name: the hanging position, layer or class.
    pub name: String,
    /// Nightfall group ID.
    pub group_id: u32,
    /// Whether a group with this name is already in the show; its members are replaced.
    pub existing: bool,
    /// Number of fixtures in the group.
    pub fixture_count: u32,
}

/// Everything an import would do, shown before it is applied.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[typeshare::typeshare]
pub struct RigImportPreview {
    /// Session holding the read file until it is imported or discarded.
    #[serde(with = "nightfall::serde_uuid_simple")]
    #[typeshare(serialized_as = "String")]
    pub session: Uuid,
    /// Name of the file.
    pub file_name: String,
    /// Application that wrote the file, if it says.
    pub provider: Option<String>,
    /// Fixture types the fixtures use.
    pub fixture_types: Vec<FixtureTypePreview>,
    /// Fixtures in file order.
    pub fixtures: Vec<FixturePreview>,
    /// Number of fixtures the import adds.
    pub new_fixtures: u32,
    /// Number of fixtures already in the show that the import changes.
    pub updated_fixtures: u32,
    /// What the groups are made from, with `Auto` resolved.
    pub group_source: RigGroupSource,
    /// Groups the import makes or refreshes.
    pub groups: Vec<GroupPreview>,
    /// Problems with the file as a whole.
    pub warnings: Vec<String>,
}

/// Reply to a finished upload: the session to preview and import from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[typeshare::typeshare]
pub struct RigUploadResponse {
    /// Session holding the read file.
    #[serde(with = "nightfall::serde_uuid_simple")]
    #[typeshare(serialized_as = "String")]
    pub session: Uuid,
}
