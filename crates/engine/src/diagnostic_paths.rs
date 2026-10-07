// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Diagnostic paths recorded by one domain and reported by another.
//!
//! Timeline systems record these timings and the desk metrics projection reports them, so the
//! paths live below both crates.

use bevy_diagnostic::DiagnosticPath;

/// Time spent generating layers from timeline playback.
pub const TIMELINE_LAYER_GENERATION_MS: DiagnosticPath =
    DiagnosticPath::const_new("timeline/layer_generation_ms");
/// Time spent in the main timeline update.
pub const TIMELINE_UPDATE_MS: DiagnosticPath = DiagnosticPath::const_new("timeline/update_ms");
/// Time spent synchronizing timeline audio.
pub const TIMELINE_AUDIO_MS: DiagnosticPath = DiagnosticPath::const_new("timeline/audio_ms");
/// Time spent resolving lookahead sources.
pub const TIMELINE_LOOKAHEAD_SOURCES_MS: DiagnosticPath =
    DiagnosticPath::const_new("timeline/lookahead_sources_ms");
/// Time spent building lookahead assertions.
pub const TIMELINE_LOOKAHEAD_ASSERTIONS_MS: DiagnosticPath =
    DiagnosticPath::const_new("timeline/lookahead_assertions_ms");
/// Time spent building lookahead layers.
pub const TIMELINE_LOOKAHEAD_LAYERS_MS: DiagnosticPath =
    DiagnosticPath::const_new("timeline/lookahead_layers_ms");
/// Time spent dispatching timeline actions.
pub const TIMELINE_ACTIONS_MS: DiagnosticPath = DiagnosticPath::const_new("timeline/actions_ms");
/// Time spent applying timeline parameter automation.
pub const TIMELINE_PARAMETERS_MS: DiagnosticPath =
    DiagnosticPath::const_new("timeline/parameters_ms");
/// Time spent seeking timelines.
pub const TIMELINE_SEEK_MS: DiagnosticPath = DiagnosticPath::const_new("timeline/seek_ms");
