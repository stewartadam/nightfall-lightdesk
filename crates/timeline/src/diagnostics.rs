// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Backend timing diagnostics for scheduled timeline systems.

use std::time::Duration;

use bevy_app::App;
use bevy_diagnostic::{DiagnosticPath, Diagnostics};
use bevy_ecs::prelude::*;
#[cfg(feature = "audio")]
use nightfall_desk::websocket::TIMELINE_AUDIO_MS;
use nightfall_desk::websocket::{
    TIMELINE_ACTIONS_MS, TIMELINE_LAYER_GENERATION_MS, TIMELINE_LOOKAHEAD_ASSERTIONS_MS,
    TIMELINE_LOOKAHEAD_LAYERS_MS, TIMELINE_LOOKAHEAD_SOURCES_MS, TIMELINE_PARAMETERS_MS,
    TIMELINE_SEEK_MS, TIMELINE_UPDATE_MS,
};
use web_time::Instant;

/// Holds start times for scheduled timeline diagnostic spans.
#[derive(Default, Resource)]
pub(crate) struct TimelineDiagnosticStopwatch {
    layer_generation: Option<Instant>,
    update: Option<Instant>,
    #[cfg(feature = "audio")]
    audio: Option<Instant>,
    lookahead_sources: Option<Instant>,
    lookahead_assertions: Option<Instant>,
    lookahead_layers: Option<Instant>,
    actions: Option<Instant>,
    parameters: Option<Instant>,
    seek: Option<Instant>,
}

/// Identifies one scheduled timeline span that can be timed.
#[derive(Clone, Copy)]
enum TimelineDiagnosticStage {
    LayerGeneration,
    Update,
    #[cfg(feature = "audio")]
    Audio,
    LookaheadSources,
    LookaheadAssertions,
    LookaheadLayers,
    Actions,
    Parameters,
    Seek,
}

impl TimelineDiagnosticStopwatch {
    /// Returns the mutable start slot for a diagnostic stage.
    fn stage_start_mut(&mut self, stage: TimelineDiagnosticStage) -> &mut Option<Instant> {
        match stage {
            TimelineDiagnosticStage::LayerGeneration => &mut self.layer_generation,
            TimelineDiagnosticStage::Update => &mut self.update,
            #[cfg(feature = "audio")]
            TimelineDiagnosticStage::Audio => &mut self.audio,
            TimelineDiagnosticStage::LookaheadSources => &mut self.lookahead_sources,
            TimelineDiagnosticStage::LookaheadAssertions => &mut self.lookahead_assertions,
            TimelineDiagnosticStage::LookaheadLayers => &mut self.lookahead_layers,
            TimelineDiagnosticStage::Actions => &mut self.actions,
            TimelineDiagnosticStage::Parameters => &mut self.parameters,
            TimelineDiagnosticStage::Seek => &mut self.seek,
        }
    }
}

/// Register timeline diagnostic support resources.
pub(crate) fn register_timeline_diagnostics(app: &mut App) {
    app.init_resource::<TimelineDiagnosticStopwatch>();
}

/// Stores the current instant for a diagnostic stage.
fn start_stage(timers: &mut TimelineDiagnosticStopwatch, stage: TimelineDiagnosticStage) {
    *timers.stage_start_mut(stage) = Some(Instant::now());
}

/// Records the elapsed milliseconds since a stage was started.
fn finish_stage(
    timers: &mut TimelineDiagnosticStopwatch,
    diagnostics: &mut Diagnostics,
    stage: TimelineDiagnosticStage,
    path: &DiagnosticPath,
) {
    let Some(started_at) = timers.stage_start_mut(stage).take() else {
        return;
    };

    record_elapsed_ms(diagnostics, path, started_at.elapsed());
}

/// Adds an elapsed duration to a Bevy diagnostic as milliseconds.
fn record_elapsed_ms(diagnostics: &mut Diagnostics, path: &DiagnosticPath, elapsed: Duration) {
    let elapsed_ms = elapsed.as_secs_f64() * 1000.0;
    diagnostics.add_measurement(path, || elapsed_ms);
}

/// Starts timing the timeline layer-generation group.
pub(crate) fn start_timeline_layer_generation_diagnostic(
    mut timers: ResMut<TimelineDiagnosticStopwatch>,
) {
    start_stage(&mut timers, TimelineDiagnosticStage::LayerGeneration);
}

/// Finishes timing the timeline layer-generation group.
pub(crate) fn finish_timeline_layer_generation_diagnostic(
    mut timers: ResMut<TimelineDiagnosticStopwatch>,
    mut diagnostics: Diagnostics,
) {
    finish_stage(
        &mut timers,
        &mut diagnostics,
        TimelineDiagnosticStage::LayerGeneration,
        &TIMELINE_LAYER_GENERATION_MS,
    );
}

/// Starts timing active timeline position updates.
pub(crate) fn start_timeline_update_diagnostic(mut timers: ResMut<TimelineDiagnosticStopwatch>) {
    start_stage(&mut timers, TimelineDiagnosticStage::Update);
}

/// Finishes timing active timeline position updates.
pub(crate) fn finish_timeline_update_diagnostic(
    mut timers: ResMut<TimelineDiagnosticStopwatch>,
    mut diagnostics: Diagnostics,
) {
    finish_stage(
        &mut timers,
        &mut diagnostics,
        TimelineDiagnosticStage::Update,
        &TIMELINE_UPDATE_MS,
    );
}

/// Starts timing timeline audio synchronization.
#[cfg(feature = "audio")]
pub(crate) fn start_timeline_audio_diagnostic(mut timers: ResMut<TimelineDiagnosticStopwatch>) {
    start_stage(&mut timers, TimelineDiagnosticStage::Audio);
}

/// Finishes timing timeline audio synchronization.
#[cfg(feature = "audio")]
pub(crate) fn finish_timeline_audio_diagnostic(
    mut timers: ResMut<TimelineDiagnosticStopwatch>,
    mut diagnostics: Diagnostics,
) {
    finish_stage(
        &mut timers,
        &mut diagnostics,
        TimelineDiagnosticStage::Audio,
        &TIMELINE_AUDIO_MS,
    );
}

/// Starts timing timeline lookahead source materialization.
pub(crate) fn start_timeline_lookahead_sources_diagnostic(
    mut timers: ResMut<TimelineDiagnosticStopwatch>,
) {
    start_stage(&mut timers, TimelineDiagnosticStage::LookaheadSources);
}

/// Finishes timing timeline lookahead source materialization.
pub(crate) fn finish_timeline_lookahead_sources_diagnostic(
    mut timers: ResMut<TimelineDiagnosticStopwatch>,
    mut diagnostics: Diagnostics,
) {
    finish_stage(
        &mut timers,
        &mut diagnostics,
        TimelineDiagnosticStage::LookaheadSources,
        &TIMELINE_LOOKAHEAD_SOURCES_MS,
    );
}

/// Starts timing timeline lookahead assertion population.
pub(crate) fn start_timeline_lookahead_assertions_diagnostic(
    mut timers: ResMut<TimelineDiagnosticStopwatch>,
) {
    start_stage(&mut timers, TimelineDiagnosticStage::LookaheadAssertions);
}

/// Finishes timing timeline lookahead assertion population.
pub(crate) fn finish_timeline_lookahead_assertions_diagnostic(
    mut timers: ResMut<TimelineDiagnosticStopwatch>,
    mut diagnostics: Diagnostics,
) {
    finish_stage(
        &mut timers,
        &mut diagnostics,
        TimelineDiagnosticStage::LookaheadAssertions,
        &TIMELINE_LOOKAHEAD_ASSERTIONS_MS,
    );
}

/// Starts timing timeline-owned lookahead layer updates.
pub(crate) fn start_timeline_lookahead_layers_diagnostic(
    mut timers: ResMut<TimelineDiagnosticStopwatch>,
) {
    start_stage(&mut timers, TimelineDiagnosticStage::LookaheadLayers);
}

/// Finishes timing timeline-owned lookahead layer updates.
pub(crate) fn finish_timeline_lookahead_layers_diagnostic(
    mut timers: ResMut<TimelineDiagnosticStopwatch>,
    mut diagnostics: Diagnostics,
) {
    finish_stage(
        &mut timers,
        &mut diagnostics,
        TimelineDiagnosticStage::LookaheadLayers,
        &TIMELINE_LOOKAHEAD_LAYERS_MS,
    );
}

/// Starts timing live timeline action processing.
pub(crate) fn start_timeline_actions_diagnostic(mut timers: ResMut<TimelineDiagnosticStopwatch>) {
    start_stage(&mut timers, TimelineDiagnosticStage::Actions);
}

/// Finishes timing live timeline action processing.
pub(crate) fn finish_timeline_actions_diagnostic(
    mut timers: ResMut<TimelineDiagnosticStopwatch>,
    mut diagnostics: Diagnostics,
) {
    finish_stage(
        &mut timers,
        &mut diagnostics,
        TimelineDiagnosticStage::Actions,
        &TIMELINE_ACTIONS_MS,
    );
}

/// Starts timing timeline automation-lane processing.
pub(crate) fn start_timeline_parameters_diagnostic(
    mut timers: ResMut<TimelineDiagnosticStopwatch>,
) {
    start_stage(&mut timers, TimelineDiagnosticStage::Parameters);
}

/// Finishes timing timeline automation-lane processing.
pub(crate) fn finish_timeline_parameters_diagnostic(
    mut timers: ResMut<TimelineDiagnosticStopwatch>,
    mut diagnostics: Diagnostics,
) {
    finish_stage(
        &mut timers,
        &mut diagnostics,
        TimelineDiagnosticStage::Parameters,
        &TIMELINE_PARAMETERS_MS,
    );
}

/// Starts timing timeline seek reconstruction.
pub(crate) fn start_timeline_seek_diagnostic(mut timers: ResMut<TimelineDiagnosticStopwatch>) {
    start_stage(&mut timers, TimelineDiagnosticStage::Seek);
}

/// Finishes timing timeline seek reconstruction.
pub(crate) fn finish_timeline_seek_diagnostic(
    mut timers: ResMut<TimelineDiagnosticStopwatch>,
    mut diagnostics: Diagnostics,
) {
    finish_stage(
        &mut timers,
        &mut diagnostics,
        TimelineDiagnosticStage::Seek,
        &TIMELINE_SEEK_MS,
    );
}
