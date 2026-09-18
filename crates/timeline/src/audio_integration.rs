// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use bevy_app::prelude::*;
use bevy_ecs::prelude::*;
use bevy_ecs::schedule::ApplyDeferred;
use nightfall_cues::events::handle_events as handle_cue_events;
use nightfall_desk::systems::event_handlers::clip_events::route_clip_playback_actions;
use nightfall_engine::prelude::*;

#[cfg(feature = "audio")]
pub fn add_event_handling_systems(app: &mut App) {
    app.init_resource::<crate::systems::PendingStoppedTimelineReleaseClocks>();

    app.add_systems(
        Update,
        (
            crate::timeline_events::handle_timecode_events,
            crate::timeline_events::handle_timeline_events,
            crate::timeline_events::crud_events,
            crate::beatgrid_detection::process_detection_results_system,
            crate::diagnostics::start_timeline_seek_diagnostic,
            crate::systems::handle_timeline_seek_system,
            crate::diagnostics::finish_timeline_seek_diagnostic,
            crate::systems::mark_timeline_reconstruction_deferred_flush,
        )
            .chain()
            .in_set(EventHandling)
            .after(nightfall_timecode::events::handle_events)
            .before(nightfall_timecode::events::crud_events)
            .before(route_clip_playback_actions)
            .before(handle_cue_events),
    );

    app.add_systems(
        Update,
        ApplyDeferred
            .run_if(crate::systems::timeline_reconstruction_deferred_flush_requested)
            .in_set(EventHandling)
            .after(crate::systems::mark_timeline_reconstruction_deferred_flush)
            .before(crate::systems::clear_timeline_reconstruction_deferred_flush)
            .before(nightfall_timecode::events::crud_events)
            .before(route_clip_playback_actions)
            .before(handle_cue_events),
    );

    app.add_systems(
        Update,
        (
            crate::systems::clear_timeline_reconstruction_deferred_flush,
            crate::systems::reset_timeline_triggers_system,
            crate::systems::record_stopped_timeline_release_clocks,
            crate::systems::stop_timeline_owned_clips,
        )
            .chain()
            .in_set(EventHandling)
            .after(crate::systems::mark_timeline_reconstruction_deferred_flush)
            .before(nightfall_timecode::events::crud_events)
            .before(route_clip_playback_actions)
            .before(handle_cue_events),
    );

    app.add_systems(
        Update,
        crate::systems::cleanup_timeline_entities
            .in_set(EventHandling)
            .after(route_clip_playback_actions)
            .after(handle_cue_events)
            .before(nightfall_timecode::events::crud_events),
    );

    app.add_systems(
        Update,
        (
            ApplyDeferred,
            crate::systems::detach_stopped_timeline_release_clocks,
        )
            .chain()
            .after(EventHandling)
            .before(ClockUpdate),
    );

    app.add_systems(
        Update,
        (
            (
                crate::diagnostics::start_timeline_layer_generation_diagnostic,
                crate::diagnostics::start_timeline_update_diagnostic,
                crate::systems::update_timeline_system,
                crate::diagnostics::finish_timeline_update_diagnostic,
            )
                .chain(),
            (
                crate::diagnostics::start_timeline_audio_diagnostic,
                crate::systems::handle_timeline_audio_system,
                crate::diagnostics::finish_timeline_audio_diagnostic,
            )
                .chain()
                .run_if(resource_exists::<nightfall_audio::AudioController>),
            (
                crate::diagnostics::start_timeline_lookahead_sources_diagnostic,
                crate::systems::update_timeline_lookahead_sources_system,
                crate::diagnostics::finish_timeline_lookahead_sources_diagnostic,
                ApplyDeferred,
                crate::diagnostics::start_timeline_lookahead_assertions_diagnostic,
                crate::systems::populate_materialized_lookahead_assertions_system,
                crate::diagnostics::finish_timeline_lookahead_assertions_diagnostic,
                ApplyDeferred,
                crate::diagnostics::start_timeline_lookahead_layers_diagnostic,
                crate::systems::update_timeline_lookahead_layers_system,
                crate::diagnostics::finish_timeline_lookahead_layers_diagnostic,
            )
                .chain(),
            (
                crate::diagnostics::start_timeline_actions_diagnostic,
                crate::systems::process_actions_system,
                crate::diagnostics::finish_timeline_actions_diagnostic,
            )
                .chain(),
            (
                crate::diagnostics::start_timeline_parameters_diagnostic,
                crate::systems::process_parameters_system,
                crate::diagnostics::finish_timeline_parameters_diagnostic,
            )
                .chain(),
            crate::diagnostics::finish_timeline_layer_generation_diagnostic,
        )
            .chain()
            .in_set(LayerGeneration)
            .after(nightfall_timecode::systems::update_timecode_system),
    );

    app.add_systems(
        Update,
        crate::systems::sync_timeline_paused_instance_controls_system
            .after(ClockUpdate)
            .before(LayerGeneration),
    );
}

#[cfg(not(feature = "audio"))]
pub fn add_event_handling_systems(app: &mut App) {
    app.init_resource::<crate::systems::PendingStoppedTimelineReleaseClocks>();

    app.add_systems(
        Update,
        (
            crate::timeline_events::handle_timecode_events,
            crate::timeline_events::handle_timeline_events,
            crate::timeline_events::crud_events,
            crate::beatgrid_detection::process_detection_results_system,
            crate::diagnostics::start_timeline_seek_diagnostic,
            crate::systems::handle_timeline_seek_system,
            crate::diagnostics::finish_timeline_seek_diagnostic,
            crate::systems::mark_timeline_reconstruction_deferred_flush,
        )
            .chain()
            .in_set(EventHandling)
            .after(nightfall_timecode::events::handle_events)
            .before(nightfall_timecode::events::crud_events)
            .before(route_clip_playback_actions)
            .before(handle_cue_events),
    );

    app.add_systems(
        Update,
        ApplyDeferred
            .run_if(crate::systems::timeline_reconstruction_deferred_flush_requested)
            .in_set(EventHandling)
            .after(crate::systems::mark_timeline_reconstruction_deferred_flush)
            .before(crate::systems::clear_timeline_reconstruction_deferred_flush)
            .before(nightfall_timecode::events::crud_events)
            .before(route_clip_playback_actions)
            .before(handle_cue_events),
    );

    app.add_systems(
        Update,
        (
            crate::systems::clear_timeline_reconstruction_deferred_flush,
            crate::systems::reset_timeline_triggers_system,
            crate::systems::record_stopped_timeline_release_clocks,
            crate::systems::stop_timeline_owned_clips,
        )
            .chain()
            .in_set(EventHandling)
            .after(crate::systems::mark_timeline_reconstruction_deferred_flush)
            .before(nightfall_timecode::events::crud_events)
            .before(route_clip_playback_actions)
            .before(handle_cue_events),
    );

    app.add_systems(
        Update,
        crate::systems::cleanup_timeline_entities
            .in_set(EventHandling)
            .after(route_clip_playback_actions)
            .after(handle_cue_events)
            .before(nightfall_timecode::events::crud_events),
    );

    app.add_systems(
        Update,
        (
            ApplyDeferred,
            crate::systems::detach_stopped_timeline_release_clocks,
        )
            .chain()
            .after(EventHandling)
            .before(ClockUpdate),
    );

    app.add_systems(
        Update,
        (
            (
                crate::diagnostics::start_timeline_layer_generation_diagnostic,
                crate::diagnostics::start_timeline_update_diagnostic,
                crate::systems::update_timeline_system,
                crate::diagnostics::finish_timeline_update_diagnostic,
            )
                .chain(),
            (
                crate::diagnostics::start_timeline_lookahead_sources_diagnostic,
                crate::systems::update_timeline_lookahead_sources_system,
                crate::diagnostics::finish_timeline_lookahead_sources_diagnostic,
                ApplyDeferred,
                crate::diagnostics::start_timeline_lookahead_assertions_diagnostic,
                crate::systems::populate_materialized_lookahead_assertions_system,
                crate::diagnostics::finish_timeline_lookahead_assertions_diagnostic,
                ApplyDeferred,
                crate::diagnostics::start_timeline_lookahead_layers_diagnostic,
                crate::systems::update_timeline_lookahead_layers_system,
                crate::diagnostics::finish_timeline_lookahead_layers_diagnostic,
            )
                .chain(),
            (
                crate::diagnostics::start_timeline_actions_diagnostic,
                crate::systems::process_actions_system,
                crate::diagnostics::finish_timeline_actions_diagnostic,
            )
                .chain(),
            (
                crate::diagnostics::start_timeline_parameters_diagnostic,
                crate::systems::process_parameters_system,
                crate::diagnostics::finish_timeline_parameters_diagnostic,
            )
                .chain(),
            crate::diagnostics::finish_timeline_layer_generation_diagnostic,
        )
            .chain()
            .in_set(LayerGeneration)
            .after(nightfall_timecode::systems::update_timecode_system),
    );

    app.add_systems(
        Update,
        crate::systems::sync_timeline_paused_instance_controls_system
            .after(ClockUpdate)
            .before(LayerGeneration),
    );
}
