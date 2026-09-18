// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Diagnostic paths and registration for websocket projection work.

use super::*;

pub const LAYER_STACK_BUILD_MS: DiagnosticPath =
    DiagnosticPath::const_new("desk/layer_stack/build_ms");
pub const LAYER_STACK_TRANSITION_BUILD_MS: DiagnosticPath =
    DiagnosticPath::const_new("desk/layer_stack/transition_build_ms");
pub const LAYER_STACK_BROADCAST_MS: DiagnosticPath =
    DiagnosticPath::const_new("desk/layer_stack/broadcast_ms");
pub const TIMELINE_LAYER_GENERATION_MS: DiagnosticPath =
    DiagnosticPath::const_new("timeline/layer_generation_ms");
pub const TIMELINE_UPDATE_MS: DiagnosticPath = DiagnosticPath::const_new("timeline/update_ms");
pub const TIMELINE_AUDIO_MS: DiagnosticPath = DiagnosticPath::const_new("timeline/audio_ms");
pub const TIMELINE_LOOKAHEAD_SOURCES_MS: DiagnosticPath =
    DiagnosticPath::const_new("timeline/lookahead_sources_ms");
pub const TIMELINE_LOOKAHEAD_ASSERTIONS_MS: DiagnosticPath =
    DiagnosticPath::const_new("timeline/lookahead_assertions_ms");
pub const TIMELINE_LOOKAHEAD_LAYERS_MS: DiagnosticPath =
    DiagnosticPath::const_new("timeline/lookahead_layers_ms");
pub const TIMELINE_ACTIONS_MS: DiagnosticPath = DiagnosticPath::const_new("timeline/actions_ms");
pub const TIMELINE_PARAMETERS_MS: DiagnosticPath =
    DiagnosticPath::const_new("timeline/parameters_ms");
pub const TIMELINE_SEEK_MS: DiagnosticPath = DiagnosticPath::const_new("timeline/seek_ms");

/// Register websocket performance diagnostics emitted by desk systems.
pub fn register_websocket_performance_diagnostics(app: &mut App) {
    app.register_diagnostic(Diagnostic::new(LAYER_STACK_BUILD_MS).with_suffix(" ms"))
        .register_diagnostic(Diagnostic::new(LAYER_STACK_TRANSITION_BUILD_MS).with_suffix(" ms"))
        .register_diagnostic(Diagnostic::new(LAYER_STACK_BROADCAST_MS).with_suffix(" ms"))
        .register_diagnostic(Diagnostic::new(TIMELINE_LAYER_GENERATION_MS).with_suffix(" ms"))
        .register_diagnostic(Diagnostic::new(TIMELINE_UPDATE_MS).with_suffix(" ms"))
        .register_diagnostic(Diagnostic::new(TIMELINE_LOOKAHEAD_SOURCES_MS).with_suffix(" ms"))
        .register_diagnostic(Diagnostic::new(TIMELINE_LOOKAHEAD_ASSERTIONS_MS).with_suffix(" ms"))
        .register_diagnostic(Diagnostic::new(TIMELINE_LOOKAHEAD_LAYERS_MS).with_suffix(" ms"))
        .register_diagnostic(Diagnostic::new(TIMELINE_ACTIONS_MS).with_suffix(" ms"))
        .register_diagnostic(Diagnostic::new(TIMELINE_PARAMETERS_MS).with_suffix(" ms"))
        .register_diagnostic(Diagnostic::new(TIMELINE_SEEK_MS).with_suffix(" ms"))
        .register_diagnostic(Diagnostic::new(TIMELINE_AUDIO_MS).with_suffix(" ms"));
}

/// Add an elapsed duration to a Bevy diagnostic as milliseconds.
pub(super) fn record_elapsed_ms(
    diagnostics: &mut Diagnostics,
    path: &DiagnosticPath,
    elapsed: Duration,
) {
    let elapsed_ms = elapsed.as_secs_f64() * 1000.0;
    diagnostics.add_measurement(path, || elapsed_ms);
}
