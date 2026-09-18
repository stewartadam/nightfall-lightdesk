// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Module to materialize sequences and generate their layers
use std::time::Duration;

use bevy_ecs::{prelude::*, system::SystemParam};
use moonshine_kind::prelude::*;
use nightfall::prelude::*;
use nightfall_clips::{Clip, MaterializedClip};
use nightfall_compositor::prelude::*;
use nightfall_desk::prelude::{
    BlueprintDefinitionChange, BlueprintReferenceIndex, ClipReleaseAfterInstance,
};
use nightfall_dmx::{ParameterDmxValue, prelude::ParameterValue};
use nightfall_engine::prelude::*;
use nightfall_fixtures::prelude::*;
use nightfall_fixtures::selection::SpatialSelectionResolver;
use nightfall_instances::{
    InstanceClock, InstanceId, InstanceOptions, InstancePosition, InstanceSequenceCueStatus,
    InstanceStatus, activation_epoch_ms,
};
use nightfall_lookahead::{LookaheadAssertion, LookaheadAssertions, LookaheadReason};
use nightfall_playback_planner::PlaybackReconstructionTiming;
use partially::Partial;
use smart_default::SmartDefault;
use web_time::Instant;

use crate::{
    cue::{Cue, Sequence, cue_flags},
    materialized_cue::MaterializedCue,
};

/// Sequence that maintains its current sequence position
#[derive(Component, SmartDefault)]
pub struct MaterializedSequence {
    /// Sequence definition that this materialized sequence is based on
    pub sequence: Sequence,
    /// The priority of the sequence. Higher is rendered last.
    pub priority: Priority,
    /// Whether the sequence should wrap when it reaches the end
    pub wrap: bool,
    /// The steps of the sequence
    steps: Vec<Cue>,
    /// The materialized cues
    pub mcues: Vec<MaterializedCue>,
    /// Materialized built-in cue asserted before sequence step tracking begins.
    setup_cue: MaterializedCue,
    /// Materialized built-in cue used only as a source for release timing.
    release_cue: MaterializedCue,
    /// Frozen asserted layer rendered while the sequence is releasing.
    release_layer: Option<Layer>,
    /// Source-local playback position where the release layer was frozen.
    release_started_position: Option<Duration>,
    /// Minimum source-local duration the release must occupy, even with no visible transitions.
    release_duration_floor: Duration,
    /// The index of the current cue
    position_index: usize,
    /// The last rendered sequence layer used to freeze the visible look on release.
    last_rendered_layer: Option<Layer>,
    /// Stable retained cue prefix reused between renders while only the dynamic tail changes.
    render_prefix_cache: Option<RenderPrefixCache>,
    /// Step indices ordered from oldest retained assertion to newest assertion.
    composition_order: Vec<usize>,
    /// Previous visible layers keyed by retained step while replacement transitions finish.
    transition_source_layers: Vec<Option<Layer>>,
    /// Source-local playback positions where each cue step became active.
    cue_activation_positions: Vec<Option<Duration>>,
    /// UI-facing host activation timestamp for status metadata.
    #[default(_code = "Instant::now()")]
    pub activation_time: Instant,
    /// Source-local playback position where the sequence playback began.
    playback_start_position: Duration,
    /// Source-local playback position when the current cue became active.
    last_activation_position: Duration,
}

/// Lazily available ECS inputs used to extend a materialized sequence prefix.
#[derive(SystemParam)]
pub struct SequenceMaterializationParams<'w, 's> {
    color_paths: Option<Res<'w, DataProvider<ColorPath>>>,
    blueprints: Option<Res<'w, DataProvider<Blueprint>>>,
    fixtures: Option<Res<'w, FixtureDataProviderExt>>,
    selection_resolver: Option<SpatialSelectionResolver<'w>>,
    parameters: Query<'w, 's, InstanceRef<'static, Parameter>>,
}

impl SequenceMaterializationParams<'_, '_> {
    /// Extends the sequence prefix through the next navigation target when needed.
    pub(crate) fn materialize_next(
        &self,
        sequence: &mut MaterializedSequence,
    ) -> Result<(), &'static str> {
        if sequence.next_step_is_materialized() {
            return Ok(());
        }
        let (Some(fixtures), Some(selection_resolver)) = (&self.fixtures, &self.selection_resolver)
        else {
            return Err("sequence materialization resources are unavailable");
        };
        sequence.materialize_next_step_with_sources(
            self.color_paths.as_deref(),
            self.blueprints.as_deref(),
            fixtures,
            &self.parameters,
            selection_resolver,
        );
        Ok(())
    }

    /// Extends the sequence prefix through the previous navigation target when needed.
    pub(crate) fn materialize_previous(
        &self,
        sequence: &mut MaterializedSequence,
    ) -> Result<(), &'static str> {
        if sequence.previous_step_is_materialized() {
            return Ok(());
        }
        let (Some(fixtures), Some(selection_resolver)) = (&self.fixtures, &self.selection_resolver)
        else {
            return Err("sequence materialization resources are unavailable");
        };
        sequence.materialize_previous_step_with_sources(
            self.color_paths.as_deref(),
            self.blueprints.as_deref(),
            fixtures,
            &self.parameters,
            selection_resolver,
        );
        Ok(())
    }

    /// Extends the sequence prefix through a one-based position when needed.
    pub(crate) fn materialize_through(
        &self,
        sequence: &mut MaterializedSequence,
        position: u32,
    ) -> Result<(), &'static str> {
        if sequence.position_is_materialized(position) {
            return Ok(());
        }
        let (Some(fixtures), Some(selection_resolver)) = (&self.fixtures, &self.selection_resolver)
        else {
            return Err("sequence materialization resources are unavailable");
        };
        sequence.materialize_through_position_with_sources(
            position,
            self.color_paths.as_deref(),
            self.blueprints.as_deref(),
            fixtures,
            &self.parameters,
            selection_resolver,
        );
        Ok(())
    }

    /// Extends the sequence prefix through every authored cue when needed.
    pub(crate) fn materialize_all(
        &self,
        sequence: &mut MaterializedSequence,
    ) -> Result<(), &'static str> {
        if sequence.is_fully_materialized() {
            return Ok(());
        }
        let (Some(fixtures), Some(selection_resolver)) = (&self.fixtures, &self.selection_resolver)
        else {
            return Err("sequence materialization resources are unavailable");
        };
        sequence.materialize_all_steps_with_sources(
            self.color_paths.as_deref(),
            self.blueprints.as_deref(),
            fixtures,
            &self.parameters,
            selection_resolver,
        );
        Ok(())
    }

    /// Extends and advances through only autonomous cues due at a playback position.
    pub(crate) fn materialize_autonomous_through_position(
        &self,
        sequence: &mut MaterializedSequence,
        position: Duration,
    ) -> Result<(), &'static str> {
        let mut clock = InstanceClock::default();
        clock.seek_to(position);
        let mut advances = 0;
        while advances < navigation::MAX_AUTONOMOUS_SEQUENCE_ADVANCES_PER_TICK {
            let Some(next_activation_position) =
                sequence.next_autonomous_activation_position(Some(&clock))
            else {
                break;
            };
            self.materialize_next(sequence)?;
            sequence.next_at_playback_position(next_activation_position);
            advances += 1;
        }
        Ok(())
    }
}

/// Rendered state for a retained cue prefix whose visible transitions have completed.
#[derive(Clone, Debug)]
struct RenderPrefixCache {
    /// Retained composition-order prefix included in this cache.
    order: Vec<usize>,
    /// Earliest source-local playback position where this prefix is stable.
    valid_from_position: Option<Duration>,
    /// Sequence layer after visible rendering of the cached prefix, before tracking markers.
    visible_seq_layer: Layer,
    /// Visible computed base after the cached prefix.
    visible_base_layer: ComputedLayer,
    /// Completed tracking base after the cached prefix.
    completed_base_layer: ComputedLayer,
    /// Release-marker parameters from cached cues to remove after visible tail rendering.
    release_marker_parameters: Vec<ParameterRef>,
}

/// Source-local timing for a release reconstructed from timeline playback.
#[derive(Clone, Copy, Component, Debug, PartialEq, Eq)]
pub struct PlaybackReleaseTiming {
    /// Source-local playback position where release began.
    pub released_at: Duration,
}

/// Index implementation to lookup by the triggering clip's UUID
impl HasIdentifiers for MaterializedSequence {
    fn identifiers(&self) -> &Identifiers {
        self.sequence.identifiers()
    }
}

mod materialize;
mod navigation;
mod release;
mod rematerialize;
mod rendering;
mod systems;
mod tracking;

pub use rematerialize::{
    rebuild_blueprint_reference_index, rematerialize_after_blueprint_definition_change,
    rematerialize_sequences_after_cue_definition_change,
    rematerialize_sequences_after_sequence_definition_change,
};
pub(crate) use rendering::apply_color_path_samples_to_layer;
pub use rendering::{LookaheadCandidateAssertion, lookahead_assertions_for_dark_global_candidates};
pub use systems::{
    advance_sequences, despawn_materialized_sequences, paint_materialized_sequences,
    release_materialized_sequences, sync_sequence_playback_runtime_status,
};

#[cfg(test)]
mod tests;
