// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Clip storage commands, clip playback routing, and the lifecycle of running playbacks.
//!
//! [`ClipsPlugin`] handles clip and instance commands, routes clip starts and stops to the
//! playback domain registered for each clip source, and keeps playback clocks and the clip to
//! instance index current.

use bevy_app::prelude::*;
use bevy_ecs::prelude::*;
use nightfall_engine::prelude::*;
use nightfall_instances::{
    ClipInstanceAttachment, ClipInstanceRequest, InstanceCommand, InstanceControlUpdate,
    PlaybackOperation, PlaybackReleaseOperation,
};
use nightfall_undo::prelude::UndoRegistry;

use crate::{
    ClipCommand, ClipOperation, InstanceIndex, RestoreClipSource, launch_quantize::ArmedLaunches,
    register_clip_source_routing,
};

pub mod clip_events;
pub mod clocks;
pub mod instance_events;
#[cfg(test)]
mod release_tests;

/// Installs clip commands, clip playback routing, and playback lifecycle systems.
///
/// Requires the engine and undo plugins, which provide command ingress and the undo registry.
/// Playback clocks read the show tempo when the tempo plugin is present.
pub struct ClipsPlugin;

impl Plugin for ClipsPlugin {
    /// Registers clip and instance messages, undo support, and the playback systems.
    fn build(&self, app: &mut App) {
        assert!(
            app.is_plugin_added::<nightfall_engine::EnginePlugin>(),
            "ClipsPlugin requires EnginePlugin (provides command ingress)"
        );
        assert!(
            app.is_plugin_added::<nightfall_undo::UndoPlugin>(),
            "ClipsPlugin requires UndoPlugin (provides UndoRegistry)"
        );
        nightfall_engine::protocol::dispatch_ast::register_converter::<
            crate::ast_conv::ClipAstConverter,
        >();
        app.init_resource::<clip_events::PendingClipPlaybackSpeeds>();
        app.init_resource::<ArmedLaunches>();
        app.init_resource::<InstanceIndex>();

        register_client_command::<ClipCommand>(app, Undo::Captured);
        register_engine_operation::<ClipOperation>(app);
        register_engine_operation::<RestoreClipSource>(app);
        register_clip_source_routing(app);
        crate::register_clip_actions(app);
        register_client_command::<InstanceCommand>(app, Undo::Captured);
        register_engine_operation::<PlaybackOperation>(app);
        register_engine_operation::<PlaybackReleaseOperation>(app);
        app.add_message::<InstanceControlUpdate>();
        app.add_message::<OperationResult<(), CommandError>>();
        app.add_message::<RequestEnvelope<ClipInstanceRequest>>();
        app.add_message::<EventEnvelope<ClipInstanceAttachment>>();
        {
            let mut registry = app.world_mut().resource_mut::<UndoRegistry>();
            registry.register::<ClipCommand>();
            registry.register_operation::<RestoreClipSource>();
        }

        // Keep the instance index current, then sync clip active state once both index systems
        // have run, so new instances are indexed and removed ones de-indexed before orphan checks.
        app.add_systems(
            Update,
            (
                crate::add_instances_to_index,
                crate::remove_instances_from_index,
                clocks::sync_active_state_on_instance_despawn
                    .after(crate::add_instances_to_index)
                    .after(crate::remove_instances_from_index),
            ),
        );
        app.add_systems(
            Render,
            (
                clocks::add_missing_instance_clocks,
                clocks::advance_realtime_instance_clocks,
            )
                .chain()
                .in_set(ClockUpdate)
                .after(nightfall_tempo::TempoUpdate),
        );

        app.add_systems(
            Update,
            (
                clip_events::forward_clip_ingress_actions
                    .in_set(DeskEventSet::ClipForwarding)
                    .before(clip_events::handle_clip_speed_commands)
                    .before(clip_events::route_clip_playback_actions),
                clip_events::forward_clip_playback_requests
                    .in_set(DeskEventSet::ClipForwarding)
                    .before(clip_events::route_clip_playback_actions),
                clip_events::route_clip_playback_actions
                    .in_set(DeskEventSet::ClipRouting)
                    .before(instance_events::handle_playback_commands),
                clip_events::handle_configuration_commands,
                clip_events::crud_events,
                clip_events::handle_restore_clip_source,
                instance_events::handle_events,
                instance_events::handle_playback_commands.in_set(DeskEventSet::InstancePlayback),
                clip_events::handle_clip_speed_commands
                    .before(instance_events::handle_playback_control_updates),
                instance_events::handle_playback_control_updates,
            )
                .in_set(EventHandling),
        );

        // Attachments come from input handlers and from FX module evaluation in render passes, so
        // they are applied after both, in every update.
        app.add_systems(
            PostUpdate,
            clip_events::handle_clip_playback_attachments.before(ClientFeedback),
        );

        app.add_systems(
            PostUpdate,
            (
                crate::websocket::forward_clip_commands,
                // Reads playback stops (MaterializedClip removals), which only last two updates.
                crate::websocket::send_clips_on_change,
                crate::websocket::send_armed_launches_on_change,
            )
                .in_set(ClientFeedback),
        );
        app.add_systems(
            Render,
            crate::websocket::send_clips_on_clip_change.in_set(ClientOutput),
        );
        app.add_systems(
            Update,
            crate::websocket::handle_resync_state
                .in_set(ResyncHandling)
                // The showfile identity follows the clips it describes.
                .before(nightfall_engine::ui_notification::send_pending_ui_notifications_on_resync),
        );
    }
}
