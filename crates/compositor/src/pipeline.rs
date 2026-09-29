// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Core compositor pipeline implementation.
use std::borrow::Borrow;

use bevy_ecs::prelude::*;
use nightfall::prelude::*;

use crate::{stages, types::*};

/// Core compositor pipeline
pub struct CompositorPipeline;

impl CompositorPipeline {
    /// Compose a stack of layers with optional source-local layer compositing contexts.
    ///
    /// Layers with transitions and no context are evaluated at zero elapsed instead of falling back
    /// to host time, so runtime playback evaluation remains deterministic.
    pub fn compose_with_layer_compositing_contexts<L: Borrow<Layer>>(
        layers: Vec<(Entity, ObjectRef, L, bool, Option<LayerCompositingContext>)>,
        param_query: &impl ParameterLookup,
    ) -> (
        ComputedLayer,
        AttributedAssertionsLayer,
        Vec<(Entity, ComputedLayer)>,
    ) {
        Self::compose_layers(layers, param_query)
    }

    /// Compose a stack of layers after each layer's compositing context has been selected.
    fn compose_layers<L: Borrow<Layer>>(
        layers: Vec<(Entity, ObjectRef, L, bool, Option<LayerCompositingContext>)>,
        param_query: &impl ParameterLookup,
    ) -> (
        ComputedLayer,
        AttributedAssertionsLayer,
        Vec<(Entity, ComputedLayer)>,
    ) {
        let absolute_capacity = layers
            .iter()
            .map(|(_, _, layer, _, _)| layer.borrow().absolute.len())
            .max()
            .unwrap_or(0);
        let relative_capacity = layers
            .iter()
            .map(|(_, _, layer, _, _)| layer.borrow().relative.len())
            .max()
            .unwrap_or(0);

        let mut base_layer = ComputedLayer::with_capacity(absolute_capacity, relative_capacity);
        let mut attributed_assertions_layer =
            AttributedAssertionsLayer::with_capacity(absolute_capacity, relative_capacity);
        let mut output_layers = Vec::with_capacity(layers.len());
        let mut prev_priority: Option<Priority> = None;

        for (entity, object_ref, layer, is_releasing, compositing_context) in layers {
            let layer = layer.borrow();
            let compositing_context = match compositing_context {
                Some(compositing_context) => compositing_context,
                None => {
                    warn_missing_compositing_context(entity, layer);
                    LayerCompositingContext::default()
                }
            };
            let (computed_layer, skipped) = stages::evaluate_transitions_with_compositing_context(
                layer,
                &base_layer,
                param_query,
                is_releasing,
                compositing_context,
            );

            output_layers.push((entity, computed_layer.to_effective()));
            stages::merge_layer_with_attribution_skipping(
                &mut attributed_assertions_layer,
                layer,
                object_ref,
                &skipped,
            );
            let same_priority = prev_priority.is_some_and(|p| p == layer.priority);
            stages::merge(&mut base_layer, &computed_layer, same_priority, param_query);
            prev_priority = Some(layer.priority);
        }

        (base_layer, attributed_assertions_layer, output_layers)
    }
}

/// Logs when a timed layer is evaluated without a layer compositing context.
fn warn_missing_compositing_context(entity: Entity, layer: &Layer) {
    if layer.has_transitions() {
        tracing::warn!(
            %entity,
            creator = %layer.creator,
            "Layer has transitions but no compositing context; evaluating at zero elapsed"
        );
    }
}
