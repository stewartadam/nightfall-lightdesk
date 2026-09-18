// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::{
    collections::HashMap,
    time::{SystemTime, UNIX_EPOCH},
};

use nightfall::prelude::*;
use nightfall_clips::Clip;
use nightfall_cues::prelude::*;
use nightfall_desk::prelude::*;
use nightfall_fixtures::prelude::*;
use nightfall_flow::prelude::*;
use nightfall_fx::prelude::*;
#[cfg(feature = "midi")]
use nightfall_input_midi::prelude::*;
#[cfg(feature = "osc")]
use nightfall_input_osc::prelude::*;
use nightfall_io::IoRuntimeSettings;
use nightfall_scene_objects::prelude::*;
use nightfall_timecode::prelude::*;
use nightfall_timeline::prelude::*;
use serde::{Deserialize, Serialize};

use crate::CURRENT_SHOWFILE_VERSION;

/// Serializable snapshot of input, output, and disabled patch bindings.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct BindingsSnapshot {
    /// Persisted input patch bindings.
    pub input: Vec<InputBinding>,
    /// Persisted output patch bindings.
    pub output: Vec<OutputBinding>,
    /// Bindings retained in the showfile but disabled at runtime.
    pub disabled: Vec<DisabledBinding>,
}

/// Versioned, serialized representation of all data stored in a showfile.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ShowfileSnapshot {
    /// Schema and application version metadata.
    #[serde(default)]
    pub metadata: ShowfileMetadata,
    /// Patched fixture definitions including embedded parameter profiles.
    pub fixtures: Vec<Fixture>,
    /// Showfile-scoped global variables.
    pub variables: HashMap<String, VariableValue>,
    /// Operator-facing desk settings.
    #[serde(default)]
    pub settings: DeskSettings,
    /// Showfile-scoped input and output transport preferences.
    #[serde(default, rename = "ioSettings")]
    pub io_settings: IoRuntimeSettings,
    /// Input, output, and disabled patch bindings.
    pub bindings: BindingsSnapshot,
    /// MIDI action mappings when compiled with MIDI support.
    #[cfg(feature = "midi")]
    #[serde(default, rename = "midiMappings")]
    pub midi_mappings: Vec<MidiMapping>,
    /// OSC action mappings when compiled with OSC support.
    #[cfg(feature = "osc")]
    #[serde(default, rename = "oscMappings")]
    pub osc_mappings: Vec<OscMapping>,
    /// Visualizer scene objects.
    #[serde(rename = "sceneObjects")]
    pub scene_objects: Vec<SceneObject>,
    /// Stored cue definitions.
    pub cues: Vec<Cue>,
    /// Stored sequence definitions.
    pub sequences: Vec<Sequence>,
    /// Reusable fixture groups.
    pub groups: Vec<Group>,
    /// Playback and fixture masters.
    #[serde(default)]
    pub masters: Vec<Master>,
    /// Reusable attribute blueprints.
    pub blueprints: Vec<Blueprint>,
    /// Custom color interpolation paths.
    #[serde(default)]
    pub color_paths: Vec<ColorPath>,
    /// Fixture attribute defaults that select color paths.
    #[serde(default)]
    pub color_path_defaults: Vec<ColorPathDefault>,
    /// Built-in procedural FX definitions.
    pub fx: Vec<Fx>,
    /// Component FX definitions resolved by the active runtime host.
    #[serde(default, rename = "fxModule")]
    pub fx_module: Vec<StoredFxModule>,
    /// Step-based FX definitions.
    #[serde(default, rename = "stepFx")]
    pub step_fx: Vec<StepFx>,
    /// Stored flow graphs.
    pub flows: Vec<FlowDefinition>,
    /// Timecode source definitions.
    pub timecodes: Vec<Timecode>,
    /// Editable timeline definitions.
    pub timelines: Vec<Timeline>,
    /// Clip assignments referencing playable showfile objects.
    pub clips: Vec<Clip>,
}

/// Metadata written alongside show data for compatibility checks and audit context.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
#[derive(Default)]
pub struct ShowfileMetadata {
    /// Nightfall application version that last serialized the snapshot.
    pub nightfall_version: String,
    /// Canonical schema version required when loading the snapshot.
    pub showfile_version: u32,
    /// Wall-clock save time recorded as Unix seconds.
    pub last_saved_unix_sec: u64,
}

/// Build current showfile metadata for newly written snapshots.
pub fn current_showfile_metadata() -> ShowfileMetadata {
    let last_saved_unix_sec = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);

    ShowfileMetadata {
        nightfall_version: env!("CARGO_PKG_VERSION").to_string(),
        showfile_version: CURRENT_SHOWFILE_VERSION,
        last_saved_unix_sec,
    }
}

/// Validate that versioned fixture and object assets do not conflict inside a snapshot.
pub fn validate_showfile_asset_versions(
    showfile_snapshot: &ShowfileSnapshot,
) -> Result<(), String> {
    validate_unique_fixture_asset_versions(&showfile_snapshot.fixtures)?;
    validate_unique_scene_object_asset_versions(&showfile_snapshot.scene_objects)?;
    Ok(())
}

/// Reject duplicate fixture asset keys that point at different library versions.
fn validate_unique_fixture_asset_versions(fixtures: &[Fixture]) -> Result<(), String> {
    let mut versions_by_key: HashMap<(String, String, String), String> = HashMap::new();

    for fixture in fixtures {
        let Some(asset_version) = fixture.library_asset_etag.as_ref() else {
            // Built-in or legacy fixtures are not library versioned.
            continue;
        };

        let key = (
            fixture.make.clone(),
            fixture.model.clone(),
            fixture.mode.clone(),
        );
        if let Some(existing_version) = versions_by_key.get(&key) {
            if existing_version != asset_version {
                return Err(format!(
                    "showfile contains multiple versions of fixture asset {} {} ({})",
                    fixture.make, fixture.model, fixture.mode
                ));
            }
            continue;
        }
        versions_by_key.insert(key, asset_version.clone());
    }

    Ok(())
}

/// Reject duplicate scene object asset names that point at different library versions.
fn validate_unique_scene_object_asset_versions(
    scene_objects: &[SceneObject],
) -> Result<(), String> {
    let mut versions_by_name: HashMap<String, String> = HashMap::new();

    for scene_object in scene_objects {
        let SceneObjectProperties::Custom(properties) = &scene_object.properties else {
            continue;
        };
        let Some(asset_name) = properties.library_object_name.as_ref() else {
            continue;
        };
        let Some(asset_version) = properties.library_object_version.as_ref() else {
            continue;
        };

        if let Some(existing_version) = versions_by_name.get(asset_name) {
            if existing_version != asset_version {
                return Err(format!(
                    "showfile contains multiple versions of scene object asset {}",
                    asset_name
                ));
            }
            continue;
        }

        versions_by_name.insert(asset_name.clone(), asset_version.clone());
    }

    Ok(())
}
