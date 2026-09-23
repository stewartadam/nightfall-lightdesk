// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Crate for procedural FX

#![warn(missing_docs)]
use bevy_app::prelude::*;
use bevy_ecs::prelude::*;
use bevy_state::prelude::*;
use nightfall_engine::prelude::*;
use nightfall_instances::ClipInstanceAttachment;
use nightfall_undo::prelude::*;
use serde::{Deserialize, Serialize};

pub mod ast_conv;
mod fx;
mod materialized_fx;
mod object_lookup;
mod preview_status;
mod stored_module;
mod systems;
mod undo;
pub mod websocket;

/// Step-based FX with keyframe transitions
pub mod step_fx;

/// Prelude for ergonomic imports
pub mod prelude {
    pub use crate::events::{
        FxPreviewUpdate, FxStepDraft, FxStepSequenceDraft, PreviewMaterializedFx,
        PreviewStepFxDefinition, PreviewStepFxPlayback, StepFxCommand, StepFxCommandValueSource,
        StepFxDraft, StepFxPreviewSessionId, StepFxPreviewUpdate,
    };
    pub use crate::fx::{Fx, FxWaveform, FxWaveformParams};
    pub use crate::materialized_fx::{
        MaterializedFx, MaterializedFxReconstructionHandle, spawn_reconstructed_fx_for_clip,
    };
    pub use crate::preview_status::{
        StepFxPreviewPlaybackStatus, StepFxPreviewTrackPhaseOffsets, step_fx_preview_status,
    };
    pub use crate::step_fx::{
        ActiveStepFx, Bezier, CurveType, DurationInput, FxColorLane, FxColorStep, FxDirection,
        FxLane, FxLaneSample, FxStep, FxTrack, Linear, MaterializedStepFxReconstructionHandle,
        PhaseGroups, Point2D, Snap, StepFx, StepFxCycleScale, StepFxLanePhaseOffsets, StepFxPhase,
        StepFxTiming, StepFxTrackPhaseOffsets, StepFxTransition, StepFxValidationIssue,
        TransitionCurve, calculate_phase_distribution, interpolate_parameter_values,
        phase_for_selection_index, spawn_reconstructed_step_fx_for_clip,
    };
    pub use crate::stored_module::StoredFxModule;
    pub use crate::{FxCommand, FxPlugin};
}

pub mod events;
pub use ast_conv::stepfx_commands_from_ast;

/// Plugin for handling FX
pub struct FxPlugin;
impl Plugin for FxPlugin {
    fn build(&self, app: &mut App) {
        object_lookup::register_object_lookups(app);

        tracing::debug!("Registering FxPlugin");
        app.init_resource::<DataProvider<fx::Fx>>();

        register_ingress_command::<FxCommand>(app);
        register_ingress_command::<events::StepFxCommand>(app);
        app.add_message::<events::FxPreviewUpdate>();
        app.add_message::<events::StepFxPreviewUpdate>();
        app.add_message::<events::StepFxCommandResult>();
        register_engine_action::<events::FxPlaybackAction>(app);
        app.add_message::<EventEnvelope<ClipInstanceAttachment>>();

        nightfall_engine::protocol::dispatch_ast::register_converter::<ast_conv::FxAstConverter>();

        register_command_deserializer::<FxCommand>(app, websocket::deserialize_fx_command);
        register_command_deserializer::<events::StepFxCommand>(
            app,
            websocket::deserialize_step_fx_command,
        );

        register_update_deserializer(
            app,
            "FxPreviewUpdate",
            websocket::deserialize_fx_preview_update,
        );
        register_update_deserializer(
            app,
            "StepFxPreviewUpdate",
            websocket::deserialize_step_fx_preview_update,
        );

        // Register undoable commands
        app.world_mut()
            .resource_mut::<UndoRegistry>()
            .register::<FxCommand>();
        app.world_mut()
            .resource_mut::<UndoRegistry>()
            .register::<events::StepFxCommand>();

        app.add_systems(
            Update,
            (
                events::handle_events,
                events::crud_events,
                (
                    events::handle_step_fx_commands,
                    events::handle_step_fx_playback_commands,
                    events::finish_step_fx_commands,
                )
                    .chain(),
                events::handle_preview_commands,
                events::handle_step_fx_preview_commands,
                materialized_fx::despawn_materialized_fx,
                systems::despawn_step_fx,
            )
                .in_set(EventHandling)
                .run_if(in_state(AppState::Ready)),
        );
        app.add_systems(
            Update,
            (
                systems::evaluate_step_fx,
                materialized_fx::paint_materialized_fx,
            )
                .in_set(LayerGeneration),
        );

        // WebSocket forwarding and sends owned by fx plugin
        app.add_systems(
            Update,
            (
                websocket::forward_fx_commands,
                websocket::send_fx_on_change,
                websocket::send_step_fx_on_change,
            )
                .in_set(ClientOutput),
        );

        app.add_systems(
            Update,
            websocket::handle_resync_state.in_set(ResyncHandling),
        );
    }
}

/// Commands for cue-related operations
#[derive(Debug, Clone, Serialize, Deserialize, EnginePayload)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
#[serde(deny_unknown_fields)]
pub enum FxCommand {
    /// Store a fx
    StoreFx(fx::Fx),

    /// Rename a fx
    RenameFx {
        /// ID of the fx
        id: u32,
        /// New ID for the fx
        new_id: u32,
    },

    /// Delete a fx
    DeleteFx(u32),
}

impl IngressCommand for FxCommand {}
