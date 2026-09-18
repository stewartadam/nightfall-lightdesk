// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Runtime metrics projection for websocket clients.

use super::*;

/// Send aggregated engine metrics (active layers/universes, network stats) to UI
pub fn send_metrics(
    dmx_universes: Res<ConsoleDmxUniverses>,
    network_stats: Res<NetworkStats>,
    layer_query: Query<&Layer>,
    entities_query: Query<Entity>,
    diagnostics: Res<DiagnosticsStore>,
    framepace_stats: Res<FramePaceStats>,
    broadcaster: &Res<ClientEventSink>,
) {
    let diagnostic_value = |path: &DiagnosticPath| {
        diagnostics
            .get(path)
            .and_then(|diagnostic| diagnostic.smoothed())
    };
    let active_layers = layer_query.iter().count() as u32;
    let active_universes = dmx_universes.universe_ids().count() as u32;

    let metrics = DeskMetrics {
        fps: diagnostics
            .get(&FrameTimeDiagnosticsPlugin::FPS)
            .and_then(|d| d.smoothed()),
        frame_time_ms: diagnostics
            .get(&FrameTimeDiagnosticsPlugin::FRAME_TIME)
            .and_then(|d| d.smoothed()),
        entity_count: Some(entities_query.iter().count() as u32),
        framepace_time_ms: framepace_stats
            .frametime()
            .map(|d| d.as_secs_f64() * 1000.0),
        framepace_oversleep_ms: framepace_stats
            .oversleep()
            .map(|d| d.as_secs_f64() * 1000.0),
        active_layers,
        active_universes,
        artnet_send_time_ms: network_stats
            .artnet_send_time_ms()
            .map(|v| (v * 100.0).round() / 100.0),
        artnet_universe_count: network_stats.artnet_universe_count(),
        sacn_send_time_ms: network_stats
            .sacn_send_time_ms()
            .map(|v| (v * 100.0).round() / 100.0),
        sacn_universe_count: network_stats.sacn_universe_count(),
        parameter_state_build_ms: diagnostic_value(&PARAMETER_STATE_BUILD_MS),
        parameter_state_broadcast_ms: diagnostic_value(&PARAMETER_STATE_BROADCAST_MS),
        layer_stack_build_ms: diagnostic_value(&LAYER_STACK_BUILD_MS),
        layer_stack_transition_build_ms: diagnostic_value(&LAYER_STACK_TRANSITION_BUILD_MS),
        layer_stack_broadcast_ms: diagnostic_value(&LAYER_STACK_BROADCAST_MS),
        timeline_layer_generation_ms: diagnostic_value(&TIMELINE_LAYER_GENERATION_MS),
        timeline_update_ms: diagnostic_value(&TIMELINE_UPDATE_MS),
        timeline_audio_ms: diagnostic_value(&TIMELINE_AUDIO_MS),
        timeline_lookahead_sources_ms: diagnostic_value(&TIMELINE_LOOKAHEAD_SOURCES_MS),
        timeline_lookahead_assertions_ms: diagnostic_value(&TIMELINE_LOOKAHEAD_ASSERTIONS_MS),
        timeline_lookahead_layers_ms: diagnostic_value(&TIMELINE_LOOKAHEAD_LAYERS_MS),
        timeline_actions_ms: diagnostic_value(&TIMELINE_ACTIONS_MS),
        timeline_parameters_ms: diagnostic_value(&TIMELINE_PARAMETERS_MS),
        timeline_seek_ms: diagnostic_value(&TIMELINE_SEEK_MS),
        network_output_send_failures: network_stats.recent_send_failures().to_vec(),
    };

    broadcaster.publish(DISCRIMINATOR_DROPPABLE, &DeskWsMessage::Metrics(&metrics));
}
