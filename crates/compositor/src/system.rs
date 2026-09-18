// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Compositor system that builds the layer stack and composites all layers.
use bevy_ecs::{prelude::*, system::SystemParam};
use moonshine_kind::prelude::*;

use crate::{pipeline::CompositorPipeline, types::*};

/// Layer values and change ticks used to decide whether compositing is necessary.
type CompositorLayerData = (
    Entity,
    Ref<'static, ObjectRefMarker>,
    Ref<'static, Layer>,
    Option<Ref<'static, ReleaseMarker>>,
    Option<Ref<'static, LayerCompositingContext>>,
);

/// Mutually exclusive parameter queries used for change detection and compositing.
type ParameterQueries<'w, 's, P> = (
    Query<'w, 's, InstanceRef<'static, P>, Changed<P>>,
    Query<'w, 's, InstanceRef<'static, P>, Added<P>>,
    Query<'w, 's, InstanceMut<'static, P>>,
);

/// Parameter access and removal tracking needed to composite one parameter kind.
#[derive(SystemParam)]
pub struct CompositorParameters<'w, 's, P: CompositorParameter> {
    queries: ParamSet<'w, 's, ParameterQueries<'w, 's, P>>,
    removed: RemovedComponents<'w, 's, P>,
}

/// Cached compositor input sizes used to skip stable frames.
#[derive(Default)]
pub struct CompositorRunState {
    initialized: bool,
    layer_count: usize,
}

/// System that builds the layer stack and composites all layers into a single absolute layer.
pub fn compositor<P: CompositorParameter>(
    mut commands: Commands,
    layer_query: Query<CompositorLayerData>,
    mut parameters: CompositorParameters<P>,
    mut removed_release_markers: RemovedComponents<ReleaseMarker>,
    mut removed_compositing_contexts: RemovedComponents<LayerCompositingContext>,
    mut final_layer_attributed_assertions: ResMut<FinalLayerAttributedAssertions>,
    mut final_layer_output: Option<ResMut<FinalLayerOutput>>,
    mut run_state: Local<CompositorRunState>,
) {
    // Obtain and sort the layer stack from all active entities
    // Sort by priority first, then by activation time (latest activated last)
    let mut layer_stack: Vec<_> = layer_query.iter().collect();
    let layer_count = layer_stack.len();
    let is_first_run = !run_state.initialized;

    // Components which leave the query no longer have change ticks to inspect. A count change
    // catches pure removals; equal-count replacements have change ticks on their new query member.
    let layer_query_membership_changed = run_state.layer_count != layer_count;

    // Removed optional components appear as `None` in the query, so their removal events must be
    // inspected separately from the change ticks of components which are still present.
    let release_marker_removed = removed_release_markers.read().count() > 0;
    let compositing_context_removed = removed_compositing_contexts.read().count() > 0;
    let optional_layer_state_removed = release_marker_removed || compositing_context_removed;

    // Change ticks cover mutations to existing layer state and newly added query members.
    let queried_layer_state_changed = layer_stack.iter().any(
        |(_, object_ref_marker, layer, release_marker, compositing_context)| {
            object_ref_marker.is_changed()
                || layer.is_changed()
                || release_marker
                    .as_ref()
                    .is_some_and(|release_marker| release_marker.is_changed())
                || compositing_context
                    .as_ref()
                    .is_some_and(|compositing_context| compositing_context.is_changed())
        },
    );
    let layers_changed = is_first_run
        || layer_query_membership_changed
        || optional_layer_state_removed
        || queried_layer_state_changed;

    let parameters_removed = parameters.removed.read().next().is_some();
    let parameters_changed = is_first_run
        || parameters_removed
        || parameters.queries.p0().iter().next().is_some()
        || parameters.queries.p1().iter().next().is_some();

    if !layers_changed && !parameters_changed {
        return;
    }

    run_state.initialized = true;
    run_state.layer_count = layer_count;

    layer_stack.sort_by_key(|(_, _, layer, _, _)| (*layer.priority, layer.activation_time));

    let span = tracing::trace_span!("composited_layers").entered();
    tracing::trace!("Compositing {} layers", layer_stack.len());

    // Convert to format expected by pipeline
    let layers_for_pipeline: Vec<_> = layer_stack
        .into_iter()
        .map(
            |(entity, object_ref_marker, layer, release_marker, compositing_context)| {
                let is_releasing = release_marker.is_some();
                (
                    entity,
                    object_ref_marker.0.clone(),
                    (*layer).clone(),
                    is_releasing,
                    compositing_context.map(|context| *context),
                )
            },
        )
        .collect();
    let mut param_query = parameters.queries.p2();

    // Run compositing pipeline
    let (base_layer, attributed_assertions_layer, output_layers) =
        CompositorPipeline::compose_with_layer_compositing_contexts(
            layers_for_pipeline,
            &param_query,
        );

    // Write BaseLayer and OutputLayer components to entities
    for (entity, output_layer) in output_layers {
        commands
            .entity(entity)
            .insert(BaseLayer(base_layer.clone()));
        commands.entity(entity).insert(OutputLayer(output_layer));
    }

    span.exit();

    // Update every parameter so released or cleared assertions fall back to defaults.
    for mut param in &mut param_query {
        let parameter = param.instance();
        let final_value = if base_layer.absolute.contains_key(parameter)
            || base_layer.relative.contains_key(parameter)
        {
            base_layer.get_effective_value(parameter)
        } else {
            param.default_value()
        };
        if param.current_value() != final_value {
            param.set_raw_value(final_value);
        }
    }
    if let Some(ref mut final_layer_output) = final_layer_output {
        if final_layer_output.0 != base_layer {
            final_layer_output.0 = base_layer.clone();
        }
    }

    if tracing::enabled!(tracing::Level::TRACE) {
        let span = tracing::trace_span!("final_layer_values").entered();
        tracing::trace!("Final layer output {}", base_layer);
        tracing::trace!(
            "Final layer attributed assertions {}",
            attributed_assertions_layer
        );
        span.exit();
    }

    final_layer_attributed_assertions.0 = attributed_assertions_layer;
}
