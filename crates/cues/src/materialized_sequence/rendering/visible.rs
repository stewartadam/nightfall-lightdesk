// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Visible sequence rendering with in-flight transitions preserved.

use super::super::tracking::*;
use super::super::*;
use super::cache::{VisiblePrefixSnapshot, cue_part_capacity_hint};
use super::color_path::apply_color_path_samples;
use super::stages::{CueLayerMetadata, layer_has_values};

impl MaterializedSequence {
    /// Renders the user-visible sequence output with in-flight transitions preserved.
    pub(super) fn render_visible_cue_layers(
        &mut self,
        seq_layer: &mut Layer,
        setup_base_layer: &ComputedLayer,
        composition_order: &[usize],
        cached_prefix: Option<&RenderPrefixCache>,
        param_query: &mut Query<InstanceMut<Parameter>>,
        clock: Option<&InstanceClock>,
    ) -> Option<VisiblePrefixSnapshot> {
        // Visible rendering must use the current output as its base. That lets rapid Go presses
        // and wrap replacement fades continue from what the user actually saw on the previous
        // frame, instead of restarting from completed cue targets.
        let seq_layer_activation_time = seq_layer.activation_time;
        let cached_order_len = cached_prefix.map_or(0, |cache| {
            *seq_layer = cache.visible_seq_layer.clone();
            seq_layer.priority = self.priority;
            seq_layer.activation_time = seq_layer_activation_time;
            cache.order.len()
        });
        let mut visible_base_layer = cached_prefix.map_or_else(
            || setup_base_layer.clone(),
            |cache| cache.visible_base_layer.clone(),
        );
        let mut stable_prefix_snapshot = cached_prefix.map(|cache| VisiblePrefixSnapshot {
            order_len: cache.order.len(),
            seq_layer: cache.visible_seq_layer.clone(),
            visible_base_layer: cache.visible_base_layer.clone(),
        });
        let mut can_extend_cache = true;
        let render_position = clock.map(|clock| clock.position);

        for (order_offset, index) in composition_order.iter().copied().enumerate() {
            if order_offset < cached_order_len {
                continue;
            }
            tracing::trace!(
                uid = %self.identifiers().uid,
                "Merging layer for sequence '{}' position {}",
                self.identifiers().label,
                index + 1
            );
            self.repair_cue_transition_start_position(index);
            let metadata = self.cue_layer_metadata(index);
            let compositing_context = self.cue_compositing_context_for_index(index, clock);
            let transition_source_was_present = self
                .transition_source_layers
                .get(index)
                .and_then(|source_layer| source_layer.as_ref())
                .is_some();
            self.merge_transition_source_layer(
                index,
                &metadata,
                seq_layer,
                &mut visible_base_layer,
                param_query,
                compositing_context,
            );

            let (cue_layer, rendered_base_layer) = self.render_visible_cue_part_layer(
                index,
                &metadata,
                &visible_base_layer,
                param_query,
                compositing_context,
            );
            self.clear_transition_source_if_complete(index, &cue_layer);

            if index == self.position_index {
                squash_trackable_layer_values(
                    seq_layer,
                    &cue_layer,
                    LayerTrackingPolicy::Always,
                    metadata.absolute_parameters,
                    metadata.relative_parameters,
                    param_query,
                );
            } else {
                // Transition sources follow assertion order even when the completed value will not
                // track into sequence output. This keeps skipped zero-duration cues deterministic.
                squash_trackable_layer_values(
                    &mut visible_base_layer,
                    &rendered_base_layer,
                    LayerTrackingPolicy::Always,
                    metadata.trackable_absolute_parameters.clone(),
                    metadata.trackable_relative_parameters.clone(),
                    param_query,
                );
                squash_trackable_layer_values(
                    seq_layer,
                    &cue_layer,
                    metadata.tracking_policy,
                    metadata.trackable_absolute_parameters,
                    metadata.trackable_relative_parameters,
                    param_query,
                );
            }

            let cue_transition_is_active = cue_layer.transitioning.values().any(|active| *active);
            let cue_cache_stable = !cue_transition_is_active
                && self.cue_cache_stable_at_position(index, render_position);
            if can_extend_cache && !transition_source_was_present && cue_cache_stable {
                stable_prefix_snapshot = Some(VisiblePrefixSnapshot {
                    order_len: order_offset + 1,
                    seq_layer: seq_layer.clone(),
                    visible_base_layer: visible_base_layer.clone(),
                });
            } else {
                can_extend_cache = false;
            }
        }

        stable_prefix_snapshot
    }

    /// Renders one cue for the visible pass, preserving authored cue-part order.
    fn render_visible_cue_part_layer(
        &mut self,
        index: usize,
        metadata: &CueLayerMetadata,
        visible_base_layer: &ComputedLayer,
        param_query: &mut Query<InstanceMut<Parameter>>,
        compositing_context: Option<nightfall_compositor::types::LayerCompositingContext>,
    ) -> (Layer, ComputedLayer) {
        if self.mcues[index].part_layers.is_empty() {
            return self.render_flattened_cue_layer(
                index,
                metadata,
                visible_base_layer,
                param_query,
                compositing_context,
            );
        }

        self.render_visible_cue_part_layers(
            index,
            metadata,
            visible_base_layer,
            param_query,
            compositing_context,
        )
    }

    /// Renders ordered cue part layers, feeding each part's completed intent into the next.
    fn render_visible_cue_part_layers(
        &mut self,
        index: usize,
        metadata: &CueLayerMetadata,
        visible_base_layer: &ComputedLayer,
        param_query: &mut Query<InstanceMut<Parameter>>,
        compositing_context: Option<nightfall_compositor::types::LayerCompositingContext>,
    ) -> (Layer, ComputedLayer) {
        let mcue = &self.mcues[index];
        let (absolute_capacity, relative_capacity) = cue_part_capacity_hint(mcue);
        let mut cue_layer = Layer::with_capacity(
            mcue.identifiers().label.clone(),
            mcue.priority,
            absolute_capacity,
            relative_capacity,
        );
        let mut part_base_layer = visible_base_layer.clone();
        let mut rendered_cue_base_layer = visible_base_layer.clone();

        for part_layer in &mcue.part_layers {
            let mut rendered_part_layer = part_layer.values.clone();
            let part_relative_parameters = rendered_part_layer.relative.keys().collect::<Vec<_>>();
            retarget_sequence_relative_overrides(
                &mut rendered_part_layer,
                &part_base_layer,
                param_query,
                &part_relative_parameters,
            );
            let requires_part_render = layer_has_values(&rendered_part_layer)
                || !part_layer.color_path_groups.is_empty()
                || !part_layer.color_path_scalar_groups.is_empty();
            let requires_completed_render = requires_part_render
                && (rendered_part_layer.has_transitions()
                    || !metadata.implicit_htp_assertion_timing.is_empty()
                    || !part_layer.color_path_groups.is_empty()
                    || !part_layer.color_path_scalar_groups.is_empty());
            let mut completed_part_layer =
                requires_completed_render.then(|| rendered_part_layer.clone());

            let mut rendered_part_base = if requires_part_render {
                apply_and_squash_transitions_for_sequence_context_with_computed(
                    &mut rendered_part_layer,
                    &part_base_layer,
                    param_query,
                    compositing_context,
                    &metadata.implicit_htp_assertion_timing,
                    |rendered_part_layer, rendered_part_base, param_query| {
                        apply_color_path_samples(
                            rendered_part_layer,
                            rendered_part_base,
                            &part_base_layer,
                            &part_layer.color_path_groups,
                            &part_layer.color_path_scalar_groups,
                            param_query,
                            compositing_context,
                        );
                    },
                )
            } else {
                part_base_layer.clone()
            };

            let mut completed_part_base =
                if let Some(completed_part_layer) = completed_part_layer.as_mut() {
                    let completed_context = Some(completed_sequence_compositing_context());
                    apply_and_squash_transitions_for_sequence_context_with_computed(
                        completed_part_layer,
                        &part_base_layer,
                        param_query,
                        completed_context,
                        &metadata.implicit_htp_assertion_timing,
                        |completed_part_layer, completed_part_base, param_query| {
                            apply_color_path_samples(
                                completed_part_layer,
                                completed_part_base,
                                &part_base_layer,
                                &part_layer.color_path_groups,
                                &part_layer.color_path_scalar_groups,
                                param_query,
                                completed_context,
                            );
                        },
                    )
                } else {
                    rendered_part_base.clone()
                };

            cue_layer.squash(rendered_part_layer);
            let active_release_markers =
                active_part_release_marker_parameters(part_layer, compositing_context);
            clear_release_marker_parameters_from_layer(&mut cue_layer, &active_release_markers);
            clear_release_marker_parameters_from_computed_layer(
                &mut rendered_part_base,
                &active_release_markers,
            );
            clear_release_marker_parameters_from_computed_layer(
                &mut completed_part_base,
                &active_release_markers,
            );
            rendered_cue_base_layer = rendered_part_base;
            part_base_layer = completed_part_base;
        }

        (cue_layer, rendered_cue_base_layer)
    }
}
