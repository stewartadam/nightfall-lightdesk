// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Transition-anchor repair and retained replacement-source merging.

use std::collections::HashSet;

use super::super::tracking::*;
use super::super::*;
use super::stages::CueLayerMetadata;

impl MaterializedSequence {
    /// Mirrors sequence activation anchors into the materialized cue before rendering it.
    pub(super) fn repair_cue_transition_start_position(&mut self, index: usize) {
        let Some(start_position) = self
            .cue_activation_positions
            .get(index)
            .and_then(|position| *position)
        else {
            return;
        };
        let Some(mcue) = self.mcues.get_mut(index) else {
            return;
        };

        mcue.set_start_position(start_position);
    }

    /// Merges a captured pre-replacement output layer before rendering a retained step.
    pub(super) fn merge_transition_source_layer(
        &self,
        index: usize,
        metadata: &CueLayerMetadata,
        seq_layer: &mut Layer,
        visible_base_layer: &mut ComputedLayer,
        param_query: &mut Query<InstanceMut<Parameter>>,
        compositing_context: Option<nightfall_compositor::types::LayerCompositingContext>,
    ) {
        let Some(transition_source_layer) = self
            .transition_source_layers
            .get(index)
            .and_then(|source_layer| source_layer.as_ref())
        else {
            return;
        };

        let mut transition_source_layer = transition_source_layer.clone();
        retain_layer_parameters(
            &mut transition_source_layer,
            &metadata.trackable_absolute_parameters,
            &metadata.trackable_relative_parameters,
        );
        let source_absolute_parameters: Vec<_> = transition_source_layer.absolute.keys().collect();
        let source_relative_parameters: Vec<_> = transition_source_layer.relative.keys().collect();
        let source_computed = apply_and_squash_transitions_for_sequence_context(
            &mut transition_source_layer,
            visible_base_layer,
            param_query,
            compositing_context,
            &HashSet::new(),
        );
        squash_trackable_layer_values(
            seq_layer,
            &transition_source_layer,
            LayerTrackingPolicy::Always,
            source_absolute_parameters.clone(),
            source_relative_parameters.clone(),
            param_query,
        );
        squash_trackable_layer_values(
            visible_base_layer,
            &source_computed,
            LayerTrackingPolicy::Always,
            source_absolute_parameters,
            source_relative_parameters,
            param_query,
        );
    }

    /// Clears a retained transition source once its replacement cue has completed its fade.
    pub(super) fn clear_transition_source_if_complete(&mut self, index: usize, cue_layer: &Layer) {
        let cue_transition_is_active = cue_layer.transitioning.values().any(|active| *active);
        if cue_transition_is_active {
            return;
        }

        if let Some(source_layer) = self.transition_source_layers.get_mut(index) {
            *source_layer = None;
        }
    }
}
