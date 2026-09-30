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
use nightfall_dmx::prelude::*;

use crate::{stages, types::*};

/// Core compositor pipeline
pub struct CompositorPipeline;

/// Composite of the bottom layers of a stack, from which compositing can resume higher up.
#[derive(Clone, Debug, Default)]
pub struct CompositedPrefix {
    /// Merged values of the layers composited so far.
    pub base: ComputedLayer,
    /// Attributed assertions of the layers composited so far.
    pub attributed: AttributedAssertionsLayer,
    /// Priority of the last layer composited, used for same-priority merging of the next layer.
    pub prev_priority: Option<Priority>,
}

/// One step of a resumed composite.
pub enum CompositeStep<'t, L> {
    /// A layer evaluated against the composite below it and merged on top.
    Layer((Entity, ObjectRef, L, bool, Option<LayerCompositingContext>)),
    /// A run of settled layers applied from its precomputed table.
    SettledRun(&'t SettledRunTable),
}

/// What a run of settled layers does to one parameter's absolute value arriving from below.
#[derive(Clone, Copy, Debug, PartialEq)]
enum SettledOp {
    /// The run replaces the value.
    Set(ParameterDmxValue),
    /// The run keeps the higher of the value and its own, like a same-priority HTP merge.
    Max(ParameterDmxValue),
}

impl SettledOp {
    /// Returns the op equivalent to applying `self` and then `upper`.
    fn then(self, upper: Self) -> Self {
        match (self, upper) {
            (_, Self::Set(value)) => Self::Set(value),
            (Self::Set(lower), Self::Max(value)) => {
                Self::Set(if value > lower { value } else { lower })
            }
            (Self::Max(lower), Self::Max(value)) => {
                Self::Max(if value > lower { value } else { lower })
            }
        }
    }
}

/// Per-parameter effect of a run of settled layers, applied in place of compositing them.
///
/// A layer is tabulable when it is settled (not releasing, every transition finished) and every
/// assertion is an absolute value that does not depend on the value below it. Such a layer's
/// output is a constant target per parameter, so a whole run of them reduces to one replace or
/// max per parameter and one attribution entry per parameter, however many layers it holds.
#[derive(Debug)]
pub struct SettledRunTable {
    absolute: ParameterMap<SettledOp>,
    attributed_absolute: ParameterOwnershipMap,
    entry_priority: Option<Priority>,
    last_priority: Option<Priority>,
}

impl SettledRunTable {
    /// Returns whether a settled layer's output can be tabulated, which requires every assertion
    /// to be an absolute value independent of the composite below it.
    pub fn is_tabulable(layer: &Layer) -> bool {
        layer.relative.is_empty()
            && layer.absolute.values().all(|(value, _)| {
                matches!(
                    value,
                    ParameterValue::Absolute { .. } | ParameterValue::AbsolutePercent { .. }
                )
            })
    }

    /// Builds the table for a run of tabulable settled layers, bottom first, merged on top of a
    /// layer with `entry_priority`. Returns the table and each layer's output layer.
    pub fn build<'l>(
        layers: impl IntoIterator<Item = (Entity, ObjectRef, &'l Layer, LayerCompositingContext)>,
        entry_priority: Option<Priority>,
        param_query: &impl ParameterLookup,
    ) -> (Self, Vec<(Entity, ComputedLayer)>) {
        let empty_base = ComputedLayer::default();
        let mut absolute = ParameterMap::<SettledOp>::new();
        let mut attributed = AttributedAssertionsLayer::default();
        let mut output_layers = Vec::new();
        let mut prev_priority = entry_priority;

        for (entity, object_ref, layer, context) in layers {
            let (computed, skipped) = stages::evaluate_transitions_with_compositing_context(
                layer,
                &empty_base,
                param_query,
                false,
                context,
            );
            let same_priority = prev_priority.is_some_and(|priority| priority == layer.priority);
            for (parameter, value) in computed.absolute.iter() {
                let uses_htp = same_priority
                    && param_query
                        .parameter_compositing_context(parameter)
                        .is_some_and(|context| context.uses_htp_merge);
                let op = if uses_htp {
                    SettledOp::Max(*value)
                } else {
                    SettledOp::Set(*value)
                };
                match absolute.get_mut(parameter) {
                    Some(existing) => *existing = existing.then(op),
                    None => {
                        absolute.insert(parameter, op);
                    }
                }
            }
            stages::merge_layer_with_attribution_skipping(
                &mut attributed,
                layer,
                object_ref,
                &skipped,
            );
            output_layers.push((entity, computed.to_effective()));
            prev_priority = Some(layer.priority);
        }

        (
            Self {
                absolute,
                attributed_absolute: attributed.absolute,
                entry_priority,
                last_priority: prev_priority,
            },
            output_layers,
        )
    }

    /// Returns the priority of the layer below the run that this table was built for.
    pub fn entry_priority(&self) -> Option<Priority> {
        self.entry_priority
    }

    /// Applies the run to the composite below it, as compositing each of its layers would.
    pub fn apply(
        &self,
        base: &mut ComputedLayer,
        attributed: &mut AttributedAssertionsLayer,
        prev_priority: &mut Option<Priority>,
    ) {
        for (parameter, op) in self.absolute.iter() {
            match *op {
                SettledOp::Set(value) => {
                    base.absolute.insert(parameter, value);
                }
                SettledOp::Max(value) => {
                    if base
                        .absolute
                        .get(parameter)
                        .is_none_or(|existing| value > *existing)
                    {
                        base.absolute.insert(parameter, value);
                    }
                }
            }
        }
        for (parameter, entry) in self.attributed_absolute.iter() {
            attributed.absolute.insert(parameter, entry.clone());
        }
        *prev_priority = self.last_priority;
    }
}

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

    /// Compose the upper steps of a stack on top of an already composited prefix.
    ///
    /// Each step is either a layer to evaluate or a run of settled layers applied from its
    /// [`SettledRunTable`]. When `snapshot_after` is set, the composite after that many steps is
    /// also returned so a later pass can resume from it. Layers without a context are evaluated at
    /// zero elapsed, as in [`Self::compose_with_layer_compositing_contexts`].
    pub fn compose_resuming<L: Borrow<Layer>>(
        prefix: CompositedPrefix,
        steps: Vec<CompositeStep<'_, L>>,
        snapshot_after: Option<usize>,
        param_query: &impl ParameterLookup,
    ) -> (
        ComputedLayer,
        AttributedAssertionsLayer,
        Vec<(Entity, ComputedLayer)>,
        Option<CompositedPrefix>,
    ) {
        let CompositedPrefix {
            mut base,
            mut attributed,
            mut prev_priority,
        } = prefix;
        let mut output_layers = Vec::with_capacity(steps.len());
        let mut snapshot = None;
        if snapshot_after == Some(0) {
            snapshot = Some(CompositedPrefix {
                base: base.clone(),
                attributed: attributed.clone(),
                prev_priority,
            });
        }

        for (index, step) in steps.into_iter().enumerate() {
            match step {
                CompositeStep::Layer((
                    entity,
                    object_ref,
                    layer,
                    is_releasing,
                    compositing_context,
                )) => Self::compose_layer(
                    &mut base,
                    &mut attributed,
                    &mut prev_priority,
                    &mut output_layers,
                    (
                        entity,
                        object_ref,
                        layer.borrow(),
                        is_releasing,
                        compositing_context,
                    ),
                    param_query,
                ),
                CompositeStep::SettledRun(table) => {
                    table.apply(&mut base, &mut attributed, &mut prev_priority);
                }
            }
            if snapshot_after == Some(index + 1) {
                snapshot = Some(CompositedPrefix {
                    base: base.clone(),
                    attributed: attributed.clone(),
                    prev_priority,
                });
            }
        }

        (base, attributed, output_layers, snapshot)
    }

    /// Evaluate one layer's transitions against the composite below it and merge it on top.
    fn compose_layer(
        base_layer: &mut ComputedLayer,
        attributed_assertions_layer: &mut AttributedAssertionsLayer,
        prev_priority: &mut Option<Priority>,
        output_layers: &mut Vec<(Entity, ComputedLayer)>,
        (entity, object_ref, layer, is_releasing, compositing_context): (
            Entity,
            ObjectRef,
            &Layer,
            bool,
            Option<LayerCompositingContext>,
        ),
        param_query: &impl ParameterLookup,
    ) {
        let compositing_context = match compositing_context {
            Some(compositing_context) => compositing_context,
            None => {
                warn_missing_compositing_context(entity, layer);
                LayerCompositingContext::default()
            }
        };
        let (computed_layer, skipped) = stages::evaluate_transitions_with_compositing_context(
            layer,
            base_layer,
            param_query,
            is_releasing,
            compositing_context,
        );

        output_layers.push((entity, computed_layer.to_effective()));
        stages::merge_layer_with_attribution_skipping(
            attributed_assertions_layer,
            layer,
            object_ref,
            &skipped,
        );
        let same_priority = prev_priority.is_some_and(|p| p == layer.priority);
        stages::merge(base_layer, &computed_layer, same_priority, param_query);
        *prev_priority = Some(layer.priority);
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
            Self::compose_layer(
                &mut base_layer,
                &mut attributed_assertions_layer,
                &mut prev_priority,
                &mut output_layers,
                (
                    entity,
                    object_ref,
                    layer.borrow(),
                    is_releasing,
                    compositing_context,
                ),
                param_query,
            );
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
