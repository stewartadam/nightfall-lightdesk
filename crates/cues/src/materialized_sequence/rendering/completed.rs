// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Completed-target rendering used to calculate deterministic sequence tracking.

use super::super::tracking::*;
use super::super::*;
use super::cache::{
    CompletedPrefixSnapshot, VisiblePrefixSnapshot, cue_part_capacity_hint,
    remove_release_marker_parameters,
};
use super::color_path::apply_color_path_samples;
use super::stages::{CueLayerMetadata, layer_has_values};

impl MaterializedSequence {
    /// Renders one cue for completed sequence tracking with authored cue-part order.
    fn render_completed_cue_part_layer(
        &mut self,
        index: usize,
        metadata: &CueLayerMetadata,
        completed_base_layer: &ComputedLayer,
        param_query: &mut Query<InstanceMut<Parameter>>,
    ) -> (Layer, ComputedLayer) {
        let completed_compositing_context = Some(completed_sequence_compositing_context());
        if self.mcues[index].part_layers.is_empty() {
            return self.render_flattened_cue_layer(
                index,
                metadata,
                completed_base_layer,
                param_query,
                completed_compositing_context,
            );
        }

        self.render_completed_cue_part_layers(
            index,
            metadata,
            completed_base_layer,
            param_query,
            completed_compositing_context,
        )
    }

    /// Renders ordered cue part layers at completed transition positions.
    fn render_completed_cue_part_layers(
        &mut self,
        index: usize,
        metadata: &CueLayerMetadata,
        completed_base_layer: &ComputedLayer,
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
        let mut part_base_layer = completed_base_layer.clone();

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

            cue_layer.squash(rendered_part_layer);
            let active_release_markers =
                active_part_release_marker_parameters(part_layer, compositing_context);
            clear_release_marker_parameters_from_layer(&mut cue_layer, &active_release_markers);
            clear_release_marker_parameters_from_computed_layer(
                &mut rendered_part_base,
                &active_release_markers,
            );
            part_base_layer = rendered_part_base;
        }

        (cue_layer, part_base_layer)
    }

    /// Computes completed cue targets separately from the visible in-flight rendering pass.
    pub(super) fn render_completed_tracking_base(
        &mut self,
        seq_layer: &mut Layer,
        setup_base_layer: ComputedLayer,
        composition_order: &[usize],
        cached_prefix: Option<&RenderPrefixCache>,
        visible_prefix_snapshot: Option<&VisiblePrefixSnapshot>,
        param_query: &mut Query<InstanceMut<Parameter>>,
        clock: Option<&InstanceClock>,
    ) -> Option<CompletedPrefixSnapshot> {
        // This pass intentionally completes cue transitions before applying tracking rules. Relative
        // cues need to track against cue intent, not against a half-faded visible sample.
        let cached_order_len = cached_prefix.map_or(0, |cache| cache.order.len());
        let mut completed_base_layer =
            cached_prefix.map_or(setup_base_layer, |cache| cache.completed_base_layer.clone());
        let mut release_marker_parameters =
            cached_prefix.map_or_else(Vec::new, |cache| cache.release_marker_parameters.clone());
        remove_release_marker_parameters(seq_layer, &release_marker_parameters);
        let visible_prefix_order_len =
            visible_prefix_snapshot.map_or(0, |snapshot| snapshot.order_len);
        let mut completed_prefix_snapshot = cached_prefix.map(|cache| CompletedPrefixSnapshot {
            completed_base_layer: cache.completed_base_layer.clone(),
            release_marker_parameters: cache.release_marker_parameters.clone(),
        });

        for (order_offset, index) in composition_order.iter().copied().enumerate() {
            if order_offset < cached_order_len {
                continue;
            }
            tracing::trace!(
                uid = %self.identifiers().uid,
                "Tracking layer for sequence '{}' position {}",
                self.identifiers().label,
                index + 1
            );
            let metadata = self.cue_layer_metadata(index);
            let compositing_context = self.cue_compositing_context_for_index(index, clock);
            let mut marker_layer = self.mcues[index].to_layer(None);
            retarget_sequence_relative_overrides(
                &mut marker_layer,
                &completed_base_layer,
                param_query,
                &metadata.relative_overrides,
            );
            let mut tracking_marker_layer = marker_layer.clone();
            apply_sequence_tracking_markers(
                &self.mcues[index],
                seq_layer,
                &mut marker_layer,
                &mut tracking_marker_layer,
                &mut completed_base_layer,
                compositing_context,
            );
            let (_tracking_cue_layer, tracking_rendered_layer) = self
                .render_completed_cue_part_layer(
                    index,
                    &metadata,
                    &completed_base_layer,
                    param_query,
                );

            if index == self.position_index {
                completed_base_layer = tracking_rendered_layer;
            } else {
                squash_trackable_layer_values(
                    &mut completed_base_layer,
                    &tracking_rendered_layer,
                    metadata.tracking_policy,
                    metadata.trackable_absolute_parameters,
                    metadata.trackable_relative_parameters,
                    param_query,
                );
            }

            if order_offset < visible_prefix_order_len {
                release_marker_parameters.extend(active_sequence_release_marker_parameters(
                    &self.mcues[index],
                    compositing_context,
                ));
                completed_prefix_snapshot = Some(CompletedPrefixSnapshot {
                    completed_base_layer: completed_base_layer.clone(),
                    release_marker_parameters: release_marker_parameters.clone(),
                });
            }
        }

        completed_prefix_snapshot
    }
}
