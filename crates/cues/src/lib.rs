// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! This crate provides cues and sequences
#![warn(missing_docs)]

use bevy_app::prelude::*;
use bevy_ecs::prelude::*;
use bevy_ecs::schedule::ApplyDeferred;
use nightfall::prelude::{ColorPath, ColorPathId, builtin_color_paths};
use nightfall_engine::prelude::*;
use nightfall_instances::InstanceId;
use nightfall_playback_planner::PlaybackReconstructionTiming;
use nightfall_undo::prelude::*;
use serde::{Deserialize, Serialize};

/// Internal actions owned by cue materialization lifecycle management.
#[derive(Debug, Clone, PartialEq)]
pub enum CueLifecycleAction {
    /// Release materialized cue instances by uid.
    ReleaseCueInstances {
        /// Cue instance ids.
        uids: Vec<uuid::Uuid>,
    },
}

impl EnginePayload for CueLifecycleAction {}
impl EngineAction for CueLifecycleAction {}

mod object_lookup;

pub mod ast_conv;
pub mod cue;
pub mod data_provider_ext;
pub mod duration;
pub mod events;
pub mod lookahead_projection;
pub mod materialized_cue;
pub mod materialized_sequence;
pub mod sequence_planning;
pub mod undo;
pub mod websocket;

/// Prelude for ergonomic imports
pub mod prelude {
    pub use nightfall::prelude::CueTriggerType;

    pub use crate::CueAction;
    pub use crate::CueCommand;
    pub use crate::CueLifecycleAction;
    pub use crate::CuePartStoreTarget;
    pub use crate::CuePlugin;
    pub use crate::CueStoreError;
    pub use crate::CueStoreOperation;
    pub use crate::CueStoreSuccess;
    pub use crate::CueStoreTarget;
    pub use crate::SequencePlaybackAction;
    pub use crate::cue::cue_flags::TrackingFlags;
    pub use crate::cue::{
        BoundCueInstruction, Cue, CueInstruction, CuePart, Sequence, TrackingMode,
    };
    pub use crate::data_provider_ext::CueDataProviderExt;
    pub use crate::duration::{CueDurationProfile, CueDurationResolver};
    pub use crate::events::{
        MaterializedSequenceReconstructionHandle, spawn_reconstructed_sequence_for_clip,
        spawn_released_reconstructed_sequence_for_clip,
    };
    pub use crate::lookahead_projection::{
        project_authored_sequence_lookahead, sequence_lookahead_projection_request,
    };
    pub use crate::materialized_cue::MaterializedCue;
    pub use crate::materialized_sequence::{
        LookaheadCandidateAssertion, MaterializedSequence, PlaybackReleaseTiming,
        lookahead_assertions_for_dark_global_candidates,
    };
    pub use crate::sequence_planning::{
        SequenceTimelineSeekPlayback, SequenceTimelineSeekTarget,
        sequence_playback_duration_profile, sequence_release_duration_for_clip,
    };
}

/// Plugin for adding websocket output to the app
pub struct CuePlugin;
impl Plugin for CuePlugin {
    fn build(&self, app: &mut App) {
        object_lookup::register_object_lookups(app);

        tracing::debug!("Registering CuePlugin");
        register_engine_action::<CueAction>(app);
        register_engine_action::<CueLifecycleAction>(app);
        register_ingress_command::<CueCommand>(app);
        register_engine_action::<SequencePlaybackAction>(app);
        register_engine_action::<undo::RestoreSequencePosition>(app);
        register_ingress_command::<events::CuePreviewCommand>(app);
        nightfall_engine::protocol::dispatch_ast::register_converter::<ast_conv::CueAstConverter>();

        app.init_resource::<DataProvider<cue::Cue>>();
        app.init_resource::<DataProvider<cue::Sequence>>();
        app.init_resource::<DataProvider<ColorPath>>();
        app.init_resource::<websocket::SequenceLookaheadStateDirty>();
        app.add_message::<websocket::CueDefinitionChange>();
        app.add_message::<websocket::SequenceDefinitionChange>();
        app.add_message::<EngineActionEnvelope<CueStoreOperation>>();
        app.add_message::<OperationResult<CueStoreSuccess, CueStoreError>>();
        app.add_message::<OperationResult<(), CommandError>>();
        {
            let mut color_paths = app.world_mut().resource_mut::<DataProvider<ColorPath>>();
            color_paths.extend(builtin_color_paths());
        }

        // Register undoable commands
        {
            let mut registry = app.world_mut().resource_mut::<UndoRegistry>();
            registry.register_action::<CueAction>();
            registry.register::<CueCommand>();
            registry.register_action::<SequencePlaybackAction>();
            registry.register_action::<undo::RestoreSequencePosition>();
        }

        register_command_deserializer::<CueCommand>(app, crate::websocket::deserialize_cue_command);
        register_command_deserializer::<events::CuePreviewCommand>(
            app,
            crate::websocket::deserialize_cue_preview_command,
        );

        app.add_systems(
            Update,
            (
                websocket::forward_commands,
                websocket::send_cue_definition_changes,
                websocket::send_sequence_definition_changes,
                websocket::send_cues_on_change,
                websocket::send_color_paths_on_change,
                websocket::send_sequence_lookahead_states_on_change,
                websocket::send_sequence_lookahead_states_after_cue_commands,
            )
                .in_set(ClientOutput),
        );

        app.add_systems(
            Update,
            websocket::handle_resync_state.in_set(ResyncHandling),
        );

        events::register_event_systems(app);
        app.add_systems(
            Update,
            (
                (
                    materialized_cue::release_materialized_cues,
                    materialized_cue::despawn_materialized_cues,
                )
                    .chain(), // chained so we don't despawn before we can set release timing metadata
                (
                    materialized_sequence::release_materialized_sequences,
                    materialized_sequence::despawn_materialized_sequences,
                )
                    .chain(), // chained so we don't despawn before we can set release timing metadata
            )
                .in_set(EventHandling)
                .after(events::handle_events)
                .after(events::handle_cue_preview_commands)
                .after(events::handle_sequence_playback_actions),
        );
        app.add_systems(
            Update,
            (
                (
                    materialized_sequence::advance_sequences,
                    ApplyDeferred,
                    materialized_sequence::release_materialized_sequences,
                    materialized_sequence::paint_materialized_sequences,
                )
                    .chain(),
                events::sync_sequence_instance_metadata,
                materialized_sequence::sync_sequence_playback_runtime_status,
                materialized_cue::sync_cue_playback_runtime_status,
                materialized_cue::paint_materialized_cues,
            )
                .in_set(LayerGeneration),
        );
    }
}

/// Commands for cue-related operations
#[derive(Debug, Clone, Serialize, Deserialize, EnginePayload)]
pub enum CueAction {
    /// Store a cue payload prepared by a planner/runtime command handler.
    StoreCue(Box<cue::Cue>),
    /// Store a sequence payload prepared by a planner/runtime command handler.
    StoreSequence(Box<cue::Sequence>),
    /// Store a cue into a sequence, resolving append targets at mutation time.
    StoreCueInSequence {
        /// Sequence ID that should contain the cue after storing.
        sequence_id: u32,
        /// Cue ID target to store into.
        cue_id: CueStoreTarget,
        /// Cue part target to store into. Part 0 is the parent cue.
        part_id: CuePartStoreTarget,
        /// Cue part payload with instructions prepared by the caller.
        part: Box<cue::CuePart>,
        /// User-facing undo stack description for this operation.
        undo_label: String,
    },
    /// Restore a cue and its containing sequence to a captured state.
    RestoreCueStoreState {
        /// Sequence ID whose step list should be restored.
        sequence_id: u32,
        /// Cue UID whose definition should be restored or removed.
        cue_uid: uuid::Uuid,
        /// Cue definition before the store, or none if it did not exist.
        previous_cue: Option<Box<cue::Cue>>,
        /// Sequence definition before the store, or none if it did not exist.
        previous_sequence: Option<Box<cue::Sequence>>,
        /// User-facing undo stack description for this operation.
        undo_label: String,
    },
}

impl EngineAction for CueAction {}

/// Cue store target that may defer append ID allocation until mutation time.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CueStoreTarget {
    /// Store into an exact cue ID.
    Exact(u32),
    /// Allocate the next available cue ID in the target sequence.
    Next,
}

/// Cue part store target that may defer append ID allocation until mutation time.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CuePartStoreTarget {
    /// Store into an exact part ID.
    Exact(u32),
    /// Allocate the next available part ID in the target cue.
    Next,
}

/// Atomic cues-domain persistence requested by a command workflow.
#[derive(Debug, Clone)]
pub enum CueStoreOperation {
    /// Stores a complete sequence, including its setup cue.
    StoreSequence {
        /// Prepared sequence definition to validate and persist.
        sequence: Box<cue::Sequence>,
        /// User-facing undo stack description for this operation.
        undo_label: String,
    },
    /// Stores one prepared cue part and ensures its cue belongs to a sequence.
    StoreCueInSequence {
        /// Sequence ID that should contain the cue after storing.
        sequence_id: u32,
        /// Cue ID target to resolve at commit time.
        cue_id: CueStoreTarget,
        /// Cue part target to resolve at commit time.
        part_id: CuePartStoreTarget,
        /// Prepared cue part containing programmer assertions.
        part: Box<cue::CuePart>,
        /// User-facing undo stack description for this operation.
        undo_label: String,
    },
}

/// Identifies the cue data committed by one store operation.
#[derive(Debug, Clone, Eq, PartialEq, Serialize, Deserialize)]
pub struct CueStoreSuccess {
    /// Sequence containing the stored cue.
    pub sequence_id: u32,
    /// Stored cue number, including zero for a setup cue.
    pub cue_id: u32,
    /// Stored part number, including zero for the parent cue.
    pub part_id: u32,
}

/// Domain-owned failure returned to the workflow that requested cue persistence.
#[derive(Debug, Clone, Eq, PartialEq)]
pub struct CueStoreError {
    /// Stable machine-readable code mapped into the eventual command error.
    pub code: &'static str,
    /// Operator-facing explanation of the rejected store.
    pub message: String,
}

impl CueStoreError {
    /// Creates a cue-store failure with stable code and display message.
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

/// Commands for cue-related operations
#[derive(Debug, Clone, Serialize, Deserialize, EnginePayload)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
#[serde(deny_unknown_fields)]
pub enum CueCommand {
    /// Store a cue definition
    StoreCue(Box<cue::Cue>),

    /// Store a sequence definition
    StoreSequence(Box<cue::Sequence>),

    /// Rename a cue (within the same or different sequence)
    RenameCue {
        /// Sequence ID of the cue to rename
        sequence_id: u32,
        /// Cue ID within the sequence
        cue_id: u32,
        /// New sequence ID for the cue
        new_sequence_id: u32,
        /// New cue ID for the cue
        new_cue_id: u32,
    },

    /// Delete a cue from a sequence
    DeleteCue {
        /// Sequence ID containing the cue
        sequence_id: u32,
        /// Cue ID to delete
        cue_id: u32,
    },

    /// Assert values tracked into a cue or cue part.
    BlockCue {
        /// Sequence ID containing the target cue.
        sequence_id: u32,
        /// Cue ID to block.
        cue_id: u32,
        /// Optional cue part ID to block instead of the main cue.
        part_id: Option<u32>,
        /// Whether existing target-cue assertions should be replaced by tracked values.
        overwrite: bool,
    },

    /// Remove assertions that still match values tracked into a cue or cue part.
    UnblockCue {
        /// Sequence ID containing the target cue.
        sequence_id: u32,
        /// Cue ID to unblock.
        cue_id: u32,
        /// Optional cue part ID to unblock instead of the main cue.
        part_id: Option<u32>,
    },

    /// Set or clear the color path for supported color-vector instructions in a cue.
    SetCueColorPath {
        /// Sequence ID containing the cue.
        sequence_id: u32,
        /// Cue ID within the sequence.
        cue_id: u32,
        /// Color path ID to assign, or none to clear the assignment.
        color_path_id: Option<ColorPathId>,
    },

    /// Store a color path definition.
    StoreColorPath(ColorPath),

    /// Update a color path label by numeric ID.
    LabelColorPath {
        /// ID of the color path to update.
        id: u32,
        /// New label for the color path.
        label: String,
    },

    /// Duplicate a color path definition into a new numeric ID.
    DuplicateColorPath {
        /// ID of the source color path.
        id: u32,
        /// ID to assign to the duplicated color path.
        new_id: u32,
    },

    /// Rename a color path definition to a new numeric ID.
    RenameColorPath {
        /// ID of the color path to rename.
        id: u32,
        /// New ID for the color path.
        new_id: u32,
    },

    /// List known color path definitions.
    ListColorPaths,

    /// Delete a color path definition by numeric ID.
    DeleteColorPath(u32),

    /// Rename a sequence
    RenameSequence {
        /// ID of the sequence
        id: u32,
        /// New ID for the sequence
        new_id: u32,
    },

    /// Delete a sequence
    DeleteSequence(u32),
}

impl IngressCommand for CueCommand {}

/// Engine actions for sequence playback operations.
///
/// These actions operate on running sequence instances (`MaterializedSequence`).
/// They are typically delegated from ClipCommand to enable proper undo
/// with shared undo identity; the sequence owns its position state and undo logic.
#[derive(Debug, Clone, Serialize, Deserialize, EnginePayload)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
#[serde(deny_unknown_fields)]
pub enum SequencePlaybackAction {
    /// Advance the sequence to the next cue.
    Go {
        /// The playback to advance
        instance_id: InstanceId,
    },
    /// Move the sequence to the previous cue.
    Back {
        /// The playback to move backward
        instance_id: InstanceId,
    },

    /// Jump to a specific position in the sequence.
    Goto {
        /// The playback to modify
        instance_id: InstanceId,
        /// The position (1-based cue number) to jump to
        position: u32,
        /// Optional reconstruction timing to apply to the entered cue's transition.
        timing: Option<PlaybackReconstructionTiming>,
    },
    /// Render the sequence at a planner-derived source-local position.
    RenderAt {
        /// The playback to render
        instance_id: InstanceId,
        /// The position (1-based cue number) to render
        position: u32,
        /// Reconstruction timing to apply to the active cue and playback clock.
        timing: PlaybackReconstructionTiming,
    },

    /// Stop and release the sequence playback.
    Stop {
        /// The playback to stop
        instance_id: InstanceId,
    },
}

impl EngineAction for SequencePlaybackAction {}
#[cfg(test)]
mod tests {
    use bevy_app::App;
    use nightfall::prelude::{ColorInterpolationSpace, ColorPath};
    use nightfall_engine::prelude::{DataProvider, EnginePlugin};
    use nightfall_undo::prelude::UndoPlugin;

    use super::{
        CueCommand, CuePlugin,
        cue::{Cue, Sequence},
    };

    /// Verifies boxed store payloads preserve the public command JSON envelope.
    #[test]
    fn store_commands_preserve_definition_payloads() {
        let cue = Cue::default();
        let sequence = Sequence::default();
        let cases = [
            (
                CueCommand::StoreCue(Box::new(cue.clone())),
                serde_json::json!({"type": "StoreCue", "data": cue}),
            ),
            (
                CueCommand::StoreSequence(Box::new(sequence.clone())),
                serde_json::json!({"type": "StoreSequence", "data": sequence}),
            ),
        ];
        for (command, expected) in cases {
            assert_eq!(serde_json::to_value(&command).unwrap(), expected);
            let decoded: CueCommand = serde_json::from_value(expected.clone()).unwrap();
            assert_eq!(serde_json::to_value(decoded).unwrap(), expected);
        }
    }

    /// Verifies editor preview snapshots retain their JSON fields when boxed internally.
    #[test]
    fn preview_commands_preserve_snapshot_payloads() {
        use crate::events::{CuePreviewCommand, SequencePreview};

        let cue = Cue::default();
        let preview = SequencePreview {
            sequence: Sequence::default(),
            cues: vec![cue.clone()],
            position: 1,
        };
        let cases = [
            (
                CuePreviewCommand::PreviewCue {
                    instance_id: None,
                    cue: Box::new(cue.clone()),
                },
                serde_json::json!({"type": "PreviewCue", "data": {"instance_id": null, "cue": cue}}),
            ),
            (
                CuePreviewCommand::PreviewSequence {
                    instance_id: None,
                    preview: Box::new(preview.clone()),
                },
                serde_json::json!({"type": "PreviewSequence", "data": {"instance_id": null, "preview": preview}}),
            ),
        ];
        for (command, expected) in cases {
            assert_eq!(serde_json::to_value(&command).unwrap(), expected);
            let decoded: CuePreviewCommand = serde_json::from_value(expected.clone()).unwrap();
            assert_eq!(serde_json::to_value(decoded).unwrap(), expected);
        }
    }

    /// Verifies the cue plugin exposes built-in color path definitions as showfile objects.
    #[test]
    fn cue_plugin_registers_builtin_color_paths() {
        let mut app = App::new();
        app.add_plugins(EnginePlugin);
        app.add_plugins(UndoPlugin);
        app.add_plugins(CuePlugin);

        let color_paths = app.world().resource::<DataProvider<ColorPath>>();
        let hsv = color_paths
            .from_id(2)
            .expect("HSV built-in color path should be registered");
        assert_eq!(hsv.interpolation_space, ColorInterpolationSpace::Hsv);
        assert_eq!(hsv.identifiers.label, "HSV");
    }
}
