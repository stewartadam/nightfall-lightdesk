// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Materialized sequence rendering pipeline and responsibility-focused rendering stages.

use web_time::Instant;

use super::*;

mod cache;
mod color_path;
mod completed;
mod footprint;
mod lookahead;
mod setup;
mod stages;
mod transition;
mod visible;

pub(crate) use color_path::apply_color_path_samples_to_layer;
pub use lookahead::{LookaheadCandidateAssertion, lookahead_assertions_for_dark_global_candidates};

impl MaterializedSequence {
    /// Creates a layer with fixture instructions from the materialized sequence.
    pub fn to_layer(&mut self, param_query: &mut Query<InstanceMut<Parameter>>) -> Layer {
        self.to_layer_at_clock(param_query, None)
    }

    /// Creates a layer evaluated at an optional source-local playback clock.
    pub fn to_layer_at_clock(
        &mut self,
        param_query: &mut Query<InstanceMut<Parameter>>,
        clock: Option<&InstanceClock>,
    ) -> Layer {
        tracing::trace!(uid = %self.identifiers().uid,
        "Creating layer for sequence '{}'", self.identifiers().label);

        if let Some(release_layer) = &self.release_layer {
            return release_layer.clone();
        }

        let composition_order = self.composition_order_for_render();
        let render_position = clock.map(|clock| clock.position);
        if let Some(cached_layer) =
            self.rendered_layer_from_full_prefix_cache(&composition_order, render_position)
        {
            let mut cached_layer = cached_layer;
            cached_layer.activation_time = Instant::now();
            self.last_rendered_layer = Some(cached_layer.clone());
            return cached_layer;
        }

        let (absolute_capacity, relative_capacity) =
            self.sequence_layer_capacity_hint(&composition_order);
        let mut seq_layer = Layer::with_capacity(
            self.identifiers().label.clone(),
            self.priority,
            absolute_capacity,
            relative_capacity,
        );
        seq_layer.priority = self.priority;

        let setup_layer = self.render_setup_layer(
            &mut seq_layer,
            param_query,
            self.setup_compositing_context(clock),
        );
        let setup_base_layer = setup_layer.base_layer;
        let setup_cache_stable =
            setup_layer.stable && self.setup_cue_cache_stable_at_position(render_position);

        if self.mcues.is_empty() {
            self.last_rendered_layer = Some(seq_layer.clone());
            return seq_layer;
        }

        if !setup_cache_stable {
            self.invalidate_render_prefix_cache();
        }

        let cached_prefix = setup_cache_stable
            .then(|| self.render_prefix_cache_for_order(&composition_order, render_position))
            .flatten()
            .cloned();
        let cached_order_len = cached_prefix.as_ref().map_or(0, |cache| cache.order.len());

        let visible_prefix_snapshot = self.render_visible_cue_layers(
            &mut seq_layer,
            &setup_base_layer,
            &composition_order,
            cached_prefix.as_ref(),
            param_query,
            clock,
        );
        let completed_prefix_snapshot = self.render_completed_tracking_base(
            &mut seq_layer,
            setup_base_layer,
            &composition_order,
            cached_prefix.as_ref(),
            visible_prefix_snapshot.as_ref(),
            param_query,
            clock,
        );
        if let (Some(visible_prefix_snapshot), Some(completed_prefix_snapshot)) =
            (visible_prefix_snapshot, completed_prefix_snapshot)
            && visible_prefix_snapshot.order_len > cached_order_len
        {
            self.render_prefix_cache = Some(RenderPrefixCache {
                order: composition_order[..visible_prefix_snapshot.order_len].to_vec(),
                valid_from_position: render_position,
                visible_seq_layer: visible_prefix_snapshot.seq_layer,
                visible_base_layer: visible_prefix_snapshot.visible_base_layer,
                completed_base_layer: completed_prefix_snapshot.completed_base_layer,
                release_marker_parameters: completed_prefix_snapshot.release_marker_parameters,
            });
        }

        self.last_rendered_layer = Some(seq_layer.clone());
        seq_layer
    }
}
