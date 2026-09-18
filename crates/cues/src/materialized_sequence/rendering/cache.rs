// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Retained-prefix cache selection, stability, and capacity planning.

use super::super::tracking::clear_release_marker_parameters_from_layer;
use super::super::*;

/// Stable visible prefix state collected while rendering a dynamic tail.
pub(super) struct VisiblePrefixSnapshot {
    /// Number of composition-order entries included in the stable prefix.
    pub(super) order_len: usize,
    /// Sequence layer after visible rendering of the stable prefix.
    pub(super) seq_layer: Layer,
    /// Visible computed base after the stable prefix.
    pub(super) visible_base_layer: ComputedLayer,
}

/// Stable completed-tracking prefix state collected while rendering a dynamic tail.
pub(super) struct CompletedPrefixSnapshot {
    /// Completed tracking base after the stable prefix.
    pub(super) completed_base_layer: ComputedLayer,
    /// Release-marker parameters from the stable prefix.
    pub(super) release_marker_parameters: Vec<ParameterRef>,
}

impl MaterializedSequence {
    /// Returns map capacity hints for a rendered sequence layer.
    pub(super) fn sequence_layer_capacity_hint(
        &self,
        composition_order: &[usize],
    ) -> (usize, usize) {
        let mut absolute_capacity = self.setup_cue.values.absolute.len();
        let mut relative_capacity = self.setup_cue.values.relative.len();

        for index in composition_order {
            let Some(mcue) = self.mcues.get(*index) else {
                continue;
            };
            let (cue_absolute, cue_relative) = materialized_cue_capacity_hint(mcue);
            absolute_capacity += cue_absolute;
            relative_capacity += cue_relative;
            if let Some(Some(source_layer)) = self.transition_source_layers.get(*index) {
                absolute_capacity += source_layer.absolute.len();
                relative_capacity += source_layer.relative.len();
            }
        }

        (absolute_capacity, relative_capacity)
    }

    /// Returns retained step order, filtered to currently materialized cue slots.
    pub(super) fn composition_order_for_render(&self) -> Vec<usize> {
        if self.composition_order.is_empty() {
            return vec![self.position_index];
        }

        self.composition_order
            .iter()
            .copied()
            .filter(|index| *index < self.mcues.len())
            .collect()
    }

    /// Returns a cached render prefix only when it still matches the active composition order.
    pub(super) fn render_prefix_cache_for_order(
        &self,
        composition_order: &[usize],
        position: Option<Duration>,
    ) -> Option<&RenderPrefixCache> {
        let cache = self.render_prefix_cache.as_ref()?;
        if !cache.valid_at_position(position) {
            return None;
        }
        if cache.order.len() > composition_order.len() {
            return None;
        }
        if composition_order.get(..cache.order.len())? != cache.order.as_slice() {
            return None;
        }
        Some(cache)
    }

    /// Returns a fully rendered cached layer when the stable prefix covers the whole sequence.
    pub(super) fn rendered_layer_from_full_prefix_cache(
        &self,
        composition_order: &[usize],
        position: Option<Duration>,
    ) -> Option<Layer> {
        let cache = self.render_prefix_cache_for_order(composition_order, position)?;
        if cache.order.len() != composition_order.len() {
            return None;
        }

        let mut layer = cache.visible_seq_layer.clone();
        layer.priority = self.priority;
        remove_release_marker_parameters(&mut layer, &cache.release_marker_parameters);
        Some(layer)
    }

    /// Drops cached retained-prefix render state after sequence state changes.
    pub(in crate::materialized_sequence) fn invalidate_render_prefix_cache(&mut self) {
        self.render_prefix_cache = None;
    }

    /// Returns whether the setup cue is stable for reuse at the provided source position.
    pub(super) fn setup_cue_cache_stable_at_position(&self, position: Option<Duration>) -> bool {
        cue_cache_stable_at_position(&self.setup_cue, position)
    }

    /// Returns whether a retained cue is stable for reuse at the provided source position.
    pub(super) fn cue_cache_stable_at_position(
        &self,
        index: usize,
        position: Option<Duration>,
    ) -> bool {
        self.mcues
            .get(index)
            .is_some_and(|mcue| cue_cache_stable_at_position(mcue, position))
    }
}

impl RenderPrefixCache {
    /// Returns whether this cache can be reused at the requested source position.
    fn valid_at_position(&self, position: Option<Duration>) -> bool {
        match (self.valid_from_position, position) {
            (Some(valid_from), Some(position)) => position >= valid_from,
            (None, None) => true,
            _ => false,
        }
    }
}

/// Applies cached release-marker removals from completed tracking prefix rendering.
pub(super) fn remove_release_marker_parameters(seq_layer: &mut Layer, parameters: &[ParameterRef]) {
    clear_release_marker_parameters_from_layer(seq_layer, parameters);
}

/// Returns map capacity hints for all values a materialized cue may render.
fn materialized_cue_capacity_hint(mcue: &MaterializedCue) -> (usize, usize) {
    let (part_absolute, part_relative) = cue_part_capacity_hint(mcue);
    (
        mcue.values.absolute.len() + part_absolute,
        mcue.values.relative.len() + part_relative,
    )
}

/// Returns map capacity hints for ordered cue part values.
pub(super) fn cue_part_capacity_hint(mcue: &MaterializedCue) -> (usize, usize) {
    mcue.part_layers
        .iter()
        .fold((0, 0), |(absolute_capacity, relative_capacity), part| {
            (
                absolute_capacity + part.values.absolute.len(),
                relative_capacity + part.values.relative.len(),
            )
        })
}

/// Returns whether a cue has no future source-local changes at the requested position.
fn cue_cache_stable_at_position(mcue: &MaterializedCue, position: Option<Duration>) -> bool {
    let Some(position) = position else {
        return true;
    };

    let assertion_complete = mcue.start_position.saturating_add(mcue.cue_duration());
    let release_complete = mcue
        .release_position
        .map(|release_position| release_position.saturating_add(mcue.max_fade_out))
        .unwrap_or(assertion_complete);

    position >= assertion_complete.max(release_complete)
}
