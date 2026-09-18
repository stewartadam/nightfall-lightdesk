// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::time::Duration;

use nightfall::prelude::*;
use nightfall_dmx::prelude::*;
use nightfall_engine::prelude::*;
use serde::{Deserialize, Serialize};

use crate::settings::ActivePanelLayout;

/// Conflict policy used when importing one showfile object collection into another.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub enum ShowfileImportPolicy {
    /// Leave the current collection unchanged.
    Skip,
    /// Add incoming objects that do not already exist in the current collection.
    Merge,
    /// Replace current objects that match incoming objects while retaining unrelated current objects.
    Replace,
    /// Replace the current collection with the incoming collection.
    Overwrite,
}

impl Default for ShowfileImportPolicy {
    /// Use merge as the default import policy.
    fn default() -> Self {
        Self::Merge
    }
}

/// Per-object-type options for importing data from a showfile snapshot.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(default)]
pub struct ShowfileImportOptions {
    /// Optional source showfile path; when omitted, the canonical showfile path is used.
    pub path: Option<String>,
    /// Import policy for fixture definitions and patch data.
    pub fixtures: ShowfileImportPolicy,
    /// Import policy for global variables.
    pub variables: ShowfileImportPolicy,
    /// Import policy for desk settings.
    pub settings: ShowfileImportPolicy,
    /// Import policy for input, output, and disabled bindings.
    pub bindings: ShowfileImportPolicy,
    /// Import policy for MIDI mappings.
    pub midi_mappings: ShowfileImportPolicy,
    /// Import policy for OSC mappings.
    pub osc_mappings: ShowfileImportPolicy,
    /// Import policy for scene objects.
    pub scene_objects: ShowfileImportPolicy,
    /// Import policy for cues.
    pub cues: ShowfileImportPolicy,
    /// Import policy for sequences.
    pub sequences: ShowfileImportPolicy,
    /// Import policy for groups.
    pub groups: ShowfileImportPolicy,
    /// Import policy for masters.
    pub masters: ShowfileImportPolicy,
    /// Import policy for blueprints.
    pub blueprints: ShowfileImportPolicy,
    /// Import policy for color path definitions.
    pub color_paths: ShowfileImportPolicy,
    /// Import policy for FX definitions.
    pub fx: ShowfileImportPolicy,
    /// Import policy for stored FX modules.
    pub fx_module: ShowfileImportPolicy,
    /// Import policy for step FX.
    pub step_fx: ShowfileImportPolicy,
    /// Import policy for flow definitions.
    pub flows: ShowfileImportPolicy,
    /// Import policy for timecodes.
    pub timecodes: ShowfileImportPolicy,
    /// Import policy for timelines.
    pub timelines: ShowfileImportPolicy,
    /// Import policy for clips.
    pub clips: ShowfileImportPolicy,
}

impl Default for ShowfileImportOptions {
    /// Build import options that merge show data while preserving timelines and settings.
    fn default() -> Self {
        Self {
            path: None,
            fixtures: ShowfileImportPolicy::Merge,
            variables: ShowfileImportPolicy::Merge,
            settings: ShowfileImportPolicy::Skip,
            bindings: ShowfileImportPolicy::Merge,
            midi_mappings: ShowfileImportPolicy::Merge,
            osc_mappings: ShowfileImportPolicy::Merge,
            scene_objects: ShowfileImportPolicy::Merge,
            cues: ShowfileImportPolicy::Merge,
            sequences: ShowfileImportPolicy::Merge,
            groups: ShowfileImportPolicy::Merge,
            masters: ShowfileImportPolicy::Merge,
            blueprints: ShowfileImportPolicy::Merge,
            color_paths: ShowfileImportPolicy::Merge,
            fx: ShowfileImportPolicy::Merge,
            fx_module: ShowfileImportPolicy::Overwrite,
            step_fx: ShowfileImportPolicy::Merge,
            flows: ShowfileImportPolicy::Merge,
            timecodes: ShowfileImportPolicy::Skip,
            timelines: ShowfileImportPolicy::Skip,
            clips: ShowfileImportPolicy::Merge,
        }
    }
}

/// Options captured at the moment a showfile save is requested.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(default, rename_all = "camelCase")]
pub struct ShowfileSaveOptions {
    /// Dockview active layout snapshot to write into the saved showfile.
    pub active_panel_layout: Option<ActivePanelLayout>,
}

/// Identifies one timestamped backup revision and its owning showfile.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(rename_all = "camelCase")]
pub struct ShowfileRevisionSelection {
    /// Logical showfile name that owns the backup revision.
    pub showfile_name: String,
    /// Timestamped backup folder name selected for loading.
    pub revision_name: String,
}

impl ShowfileRevisionSelection {
    /// Derive an explicit revision selection from a timestamped backup folder name.
    pub fn from_revision_name(revision_name: impl Into<String>) -> Result<Self, String> {
        let revision_name = revision_name.into();
        let trimmed_revision_name = revision_name.trim();
        let stem = trimmed_revision_name
            .strip_suffix(".nightfall-show")
            .unwrap_or(trimmed_revision_name);
        let showfile_name = showfile_name_from_revision_stem(stem)
            .ok_or_else(|| format!("invalid showfile revision name: {revision_name}"))?;
        Ok(Self {
            showfile_name: showfile_name.to_string(),
            revision_name: trimmed_revision_name.to_string(),
        })
    }
}

/// Return the showfile name preceding a timestamp and optional collision sequence.
fn showfile_name_from_revision_stem(stem: &str) -> Option<&str> {
    if let Some(showfile_name) = strip_revision_timestamp_suffix(stem) {
        return Some(showfile_name);
    }
    let (stem_without_sequence, sequence) = stem.rsplit_once('-')?;
    if sequence.is_empty() || !sequence.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    strip_revision_timestamp_suffix(stem_without_sequence)
}

/// Remove a valid timestamp suffix from a backup revision stem.
fn strip_revision_timestamp_suffix(stem: &str) -> Option<&str> {
    let timestamp_len = "YYYYMMDD-HHMMSS".len();
    if stem.len() <= timestamp_len + 1 {
        return None;
    }
    let separator_index = stem.len() - timestamp_len - 1;
    if stem.as_bytes()[separator_index] != b'-' {
        return None;
    }
    let showfile_name = &stem[..separator_index];
    if showfile_name.is_empty() || !is_revision_timestamp(&stem[separator_index + 1..]) {
        return None;
    }
    Some(showfile_name)
}

/// Return whether text follows the timestamp format used for backup folders.
fn is_revision_timestamp(timestamp: &str) -> bool {
    let bytes = timestamp.as_bytes();
    bytes.len() == "YYYYMMDD-HHMMSS".len()
        && bytes[..8].iter().all(|byte| byte.is_ascii_digit())
        && bytes[8] == b'-'
        && bytes[9..].iter().all(|byte| byte.is_ascii_digit())
}

/// Events representing commands for the engine
// FIXME: DeskCommand != UserCommand. User command use uids, desk commands use objectrefs.
// some intermediate layer needs to mediate between the two.
/// Desk-level commands accepted from the UI and command parser.
#[allow(missing_docs)]
#[derive(Debug, Clone, Serialize, Deserialize, EnginePayload)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
#[serde(deny_unknown_fields)]
pub enum DeskCommand {
    /// Quit the application
    Quit,

    /// Create a fresh showfile from the default sample world
    NewShowfile,
    /// Create a fresh showfile for a named `.nightfall-show` folder.
    NewNamedShowfile(String),
    /// Save showfile
    SaveShowfile(ShowfileSaveOptions),
    /// Save showfile to a named `.nightfall-show` folder.
    SaveNamedShowfile {
        /// Target showfile folder name.
        name: String,
        /// Save-time options captured by the caller.
        #[serde(default)]
        options: ShowfileSaveOptions,
    },
    /// Save a recoverable draft for the current showfile when it is dirty.
    SaveDraftShowfile(ShowfileSaveOptions),
    /// Save a recoverable draft for a named `.nightfall-show` folder.
    SaveNamedDraftShowfile {
        /// Target showfile folder name.
        name: String,
        /// Save-time options captured by the caller.
        #[serde(default)]
        options: ShowfileSaveOptions,
    },
    /// Load showfile
    LoadShowfile,
    /// Load a named `.nightfall-show` folder.
    LoadNamedShowfile(String),
    /// Load a draft from the app data drafts folder.
    LoadDraftShowfile(String),
    /// Load a backup revision into working state without replacing the saved showfile.
    LoadShowfileRevision(ShowfileRevisionSelection),
    /// Delete a draft from the app data drafts folder.
    DiscardDraftShowfile(String),
    /// Import selected object collections from a showfile
    ImportShowfile(ShowfileImportOptions),

    /// Set log level filter (e.g. "debug", "nightfall=trace")
    SetLogLevel(String),

    /// Trace outputs related to a specific fixture attribute
    TraceFixture {
        fixture_ref: UnresolvedFixtureRef,
        attribute: Attribute,
    },

    /// Set a log tracing filters (filter uses same format as those of RUST_LOG)
    SetTracingFilter {
        field: String,
        value: Option<String>, // None means "match any value"
    },

    /// Clear all existing log tracing filters
    ClearTracingFilter,

    /// Clear transport input assertions whose source universes are stale.
    ReleaseStaleInputs,

    /// Parse a command and generate domain-owned commands.
    Eval(String),

    /// Sleep for a duration before processing subsequent commands
    Sleep(Duration),

    /// Release an active object
    Release(ObjectRef),
}

impl IngressCommand for DeskCommand {}

/// Concrete internal desk work initiated by automation or timeline playback.
#[derive(Debug, Clone, EnginePayload)]
pub enum DeskAction {
    /// Parse and dispatch one command-language statement without a user reply lifecycle.
    Eval(String),
}

impl EngineAction for DeskAction {}
