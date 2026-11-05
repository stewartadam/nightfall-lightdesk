// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use bevy_ecs::prelude::*;
use nightfall_engine::prelude::*;
use serde::{Deserialize, Serialize};

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
    /// Import policy for input, output, and disabled routes.
    pub routes: ShowfileImportPolicy,
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
    /// Import policy for boards.
    pub boards: ShowfileImportPolicy,
    /// Import policy for macros.
    pub macros: ShowfileImportPolicy,
}

impl Default for ShowfileImportOptions {
    /// Build import options that merge show data while preserving timelines and settings.
    fn default() -> Self {
        Self {
            path: None,
            fixtures: ShowfileImportPolicy::Merge,
            variables: ShowfileImportPolicy::Merge,
            settings: ShowfileImportPolicy::Skip,
            routes: ShowfileImportPolicy::Merge,
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
            boards: ShowfileImportPolicy::Merge,
            macros: ShowfileImportPolicy::Merge,
        }
    }
}

/// Content selected when creating a named show and its initial recoverable draft.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(rename_all = "camelCase")]
pub struct NewShowfileOptions {
    /// Name of the new showfile folder.
    pub name: String,
    /// Populate built-in example fixtures and show objects before creating the draft.
    pub include_sample_data: bool,
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

/// Requests to create, save, load, import, or delete shows on disk.
#[derive(Debug, Clone, Serialize, Deserialize, EnginePayload)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
#[serde(deny_unknown_fields)]
pub enum ShowfileCommand {
    /// Create a fresh unnamed empty showfile.
    NewShowfile,
    /// Create a fresh showfile for a named `.nightfall-show` folder.
    NewNamedShowfile(NewShowfileOptions),
    /// Save showfile
    SaveShowfile,
    /// Save showfile to a named `.nightfall-show` folder.
    SaveNamedShowfile(String),
    /// Save a recoverable draft for the current showfile when it is dirty.
    SaveDraftShowfile,
    /// Save a recoverable draft for a named `.nightfall-show` folder.
    SaveNamedDraftShowfile(String),
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
    /// Move a show that is not currently loaded, with its draft and backups, into the trash.
    DeleteShowfile(String),
    /// Restore a deleted show from the trash entry with this id.
    RestoreDeletedShowfile(String),
    /// Permanently remove every deleted show from the trash.
    EmptyShowfileTrash,
    /// Import selected object collections from a showfile
    ImportShowfile(ShowfileImportOptions),
}

impl IngressCommand for ShowfileCommand {}

/// Fails every showfile command when the runtime has no disk storage.
///
/// Runs only while [`disk_storage_available`] is false, so hosts without a filesystem (such as
/// the browser demo) answer new, open, save, import, and trash commands immediately with an
/// operator-facing reason instead of leaving the caller waiting for a result that never comes.
/// A new show counts too, because creating one replaces the working show with a fresh draft
/// folder.
pub fn reject_disk_storage_commands(
    mut events: MessageReader<CommandEnvelope<ShowfileCommand>>,
    mut responder: CommandResponder,
) {
    for event in events.read() {
        if let Err(error) = responder.fail(
            event.command_id,
            CommandError::new(
                "showfile.disk_storage_unavailable",
                "This version of nightfall has no disk storage, so it cannot create, open, save, import, or delete shows.",
            ),
        ) {
            tracing::error!(command_id = %event.command_id, %error, "disk_storage_command_failure_failed");
        }
    }
}

#[cfg(test)]
mod tests {
    use bevy_app::{App, Update};

    use super::*;

    /// Creates a focused app that runs the disk storage guard under the given capabilities.
    ///
    /// A downstream spy records every showfile command still open after the guard ran,
    /// standing in for the native showfile handler.
    fn disk_storage_guard_app(capabilities: RuntimeCapabilities) -> App {
        let mut app = App::new();
        app.add_message::<CommandEnvelope<ShowfileCommand>>();
        app.add_message::<CommandResult>();
        app.add_message::<CommandReply>();
        app.add_message::<FinishedCommand>();
        app.add_message::<CommandNoticeReply>();
        app.init_resource::<CommandTracker>();
        app.insert_resource(capabilities);
        app.init_resource::<OpenShowfileCommands>();
        app.add_systems(
            Update,
            (
                reject_disk_storage_commands.run_if(not(disk_storage_available)),
                record_open_showfile_commands,
            )
                .chain(),
        );
        app
    }

    /// Showfile commands that a later handler could still answer after the guard ran.
    #[derive(Resource, Default)]
    struct OpenShowfileCommands(Vec<CommandId>);

    /// Records showfile commands whose lifecycle is still active for a later handler.
    fn record_open_showfile_commands(
        mut events: MessageReader<CommandEnvelope<ShowfileCommand>>,
        responder: CommandResponder,
        mut open: ResMut<OpenShowfileCommands>,
    ) {
        for event in events.read() {
            if responder.is_active(event.command_id) {
                open.0.push(event.command_id);
            }
        }
    }

    /// Registers and submits one showfile command as if it came from the web UI.
    fn submit_showfile_command(app: &mut App, command: ShowfileCommand) -> CommandId {
        let command_id = CommandId::new();
        app.world_mut()
            .resource_mut::<CommandTracker>()
            .register_context(
                command_id,
                command_id.into(),
                CommandOrigin::WebUi,
                ReplyTarget::ClientBroadcast,
            )
            .expect("showfile command should register");
        app.world_mut().write_message(CommandEnvelope::with_context(
            command_id,
            command_id.into(),
            CommandOrigin::WebUi,
            ReplyTarget::ClientBroadcast,
            command,
        ));
        command_id
    }

    /// Drains the terminal command results published during the last update.
    fn drain_results(app: &mut App) -> Vec<CommandResult> {
        app.world_mut()
            .resource_mut::<Messages<CommandResult>>()
            .drain()
            .collect()
    }

    /// Verifies the browser demo answers new, load and save commands with a failure in the
    /// same frame.
    #[test]
    fn storage_commands_fail_fast_without_disk_storage() {
        let mut app = disk_storage_guard_app(RuntimeCapabilities::embedded_demo());
        let commands = [
            ShowfileCommand::NewShowfile,
            ShowfileCommand::SaveShowfile,
            ShowfileCommand::LoadNamedShowfile("tour".into()),
        ]
        .map(|command| submit_showfile_command(&mut app, command));

        app.update();

        let results = drain_results(&mut app);
        for command_id in commands {
            assert!(
                results.iter().any(|result| result.command_id == command_id
                    && matches!(
                        &result.outcome,
                        CommandOutcome::Failed(CommandError { code, .. })
                            if code == "showfile.disk_storage_unavailable"
                    )),
                "expected {command_id} to fail with the disk storage error, got {results:?}",
            );
        }
        assert!(app.world().resource::<OpenShowfileCommands>().0.is_empty());
    }

    /// Verifies the guard stays out of the way when the host can store shows on disk.
    #[test]
    fn storage_commands_reach_handlers_with_disk_storage() {
        let mut app = disk_storage_guard_app(RuntimeCapabilities {
            disk_storage: true,
            ..RuntimeCapabilities::default()
        });
        let command_id = submit_showfile_command(&mut app, ShowfileCommand::SaveShowfile);

        app.update();

        assert!(drain_results(&mut app).is_empty());
        assert_eq!(
            app.world().resource::<OpenShowfileCommands>().0,
            [command_id]
        );
    }
}
