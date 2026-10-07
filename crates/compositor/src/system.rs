// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Compositor system that builds the layer stack and composites all layers.
use std::{ops::Range, time::Duration};

use bevy_ecs::{change_detection::Tick, entity::EntityHashMap, prelude::*, system::SystemParam};
use moonshine_kind::prelude::*;

use crate::{
    pipeline::{CompositeStep, CompositedPrefix, CompositorPipeline, SettledRunTable},
    types::*,
};

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

/// Parameter access needed to composite one parameter kind.
#[derive(SystemParam)]
pub struct CompositorParameters<'w, 's, P: CompositorParameter> {
    queries: ParamSet<'w, 's, ParameterQueries<'w, 's, P>>,
}

/// Removals since the last compositor pass that change its inputs without leaving a change tick.
///
/// Removed components leave the compositor's queries, so their removal is recorded here by the
/// observers [`add_compositor_removal_observers`](crate::add_compositor_removal_observers)
/// registers, and cleared by the next compositor pass.
#[derive(Resource)]
pub struct CompositorRemovals<P: CompositorParameter> {
    /// A parameter of kind `P` was removed.
    pub(crate) parameters: bool,
    /// A [`ReleaseMarker`] or [`LayerCompositingContext`] was removed from a layer.
    pub(crate) layer_state: bool,
    _parameter: std::marker::PhantomData<fn() -> P>,
}

impl<P: CompositorParameter> Default for CompositorRemovals<P> {
    fn default() -> Self {
        Self {
            parameters: false,
            layer_state: false,
            _parameter: std::marker::PhantomData,
        }
    }
}

/// Cached compositor input sizes used to skip stable frames.
#[derive(Default)]
pub struct CompositorRunState {
    initialized: bool,
    layer_count: usize,
    /// Composite of the bottom layers that had finished fading on the last pass.
    settled_prefix: Option<SettledPrefix>,
    /// Settle facts of each layer, keyed by the layer entity and valid while the layer's change
    /// tick matches.
    settle_facts: EntityHashMap<(Tick, LayerSettleFacts)>,
    /// Tables of the runs of settled layers above the settled prefix on the last pass.
    settled_runs: Vec<SettledRun>,
}

/// Facts about a layer's assertions that decide when and how it can be cached once settled.
#[derive(Clone, Copy)]
struct LayerSettleFacts {
    /// Playback position after which every transition in the layer has finished.
    settle_position: Duration,
    /// Whether the layer's settled output can be folded into a [`SettledRunTable`].
    tabulable: bool,
}

/// Table of a run of settled layers, with the identity of the layers it was built from.
struct SettledRun {
    /// Identity and change ticks of each layer in the run, bottom first.
    layers: Vec<SettledPrefixLayer>,
    /// Per-parameter effect of the run.
    table: SettledRunTable,
}

/// Composite of a run of bottom layers whose outputs no longer depend on playback position.
struct SettledPrefix {
    /// Identity and change ticks of each layer in the prefix, bottom first.
    layers: Vec<SettledPrefixLayer>,
    /// Composite after the last layer of the prefix.
    composited: CompositedPrefix,
}

/// Identity and change ticks of one layer in a [`SettledPrefix`].
#[derive(Clone, Copy, PartialEq, Eq)]
struct SettledPrefixLayer {
    entity: Entity,
    layer_changed: Tick,
    object_ref_changed: Tick,
}

/// Returns the playback position after which every transition in a layer has finished, so the
/// layer's non-releasing output no longer changes with playback position.
fn layer_settle_position(layer: &Layer) -> Duration {
    layer
        .absolute
        .values()
        .chain(layer.relative.values())
        .filter_map(|(_, transition)| transition.as_ref())
        .map(|transition| {
            transition.start_position
                + (transition.delay_in + transition.fade_in)
                    .max(transition.delay_out + transition.fade_out)
        })
        .max()
        .unwrap_or_default()
}

/// Returns the maximal runs of at least two tabulable layers above the settled prefix, as index
/// ranges into the sorted layer stack.
fn settled_run_ranges(tabulable: &[bool], settled_prefix_len: usize) -> Vec<Range<usize>> {
    let mut ranges = Vec::new();
    let mut index = settled_prefix_len;
    while index < tabulable.len() {
        let run_len = tabulable[index..]
            .iter()
            .take_while(|tabulable| **tabulable)
            .count();
        if run_len >= 2 {
            ranges.push(index..index + run_len);
        }
        index += run_len.max(1);
    }
    ranges
}

/// System that builds the layer stack and composites all layers into a single absolute layer.
pub fn compositor<P: CompositorParameter>(
    mut commands: Commands,
    layer_query: Query<CompositorLayerData>,
    mut parameters: CompositorParameters<P>,
    mut removals: ResMut<CompositorRemovals<P>>,
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

    // Removed optional components appear as `None` in the query, so their removals must be
    // inspected separately from the change ticks of components which are still present.
    let optional_layer_state_removed = std::mem::take(&mut removals.layer_state);

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

    let parameters_removed = std::mem::take(&mut removals.parameters);
    let parameters_added = parameters.queries.p1().iter().next().is_some();
    let parameter_set_changed = is_first_run || parameters_removed || parameters_added;
    let parameters_changed =
        parameter_set_changed || parameters.queries.p0().iter().next().is_some();

    if !layers_changed && !parameters_changed {
        return;
    }

    run_state.initialized = true;
    run_state.layer_count = layer_count;

    layer_stack.sort_by_key(|(_, _, layer, _, _)| (*layer.priority, layer.activation_time));

    let span = tracing::trace_span!("composited_layers").entered();
    tracing::trace!("Compositing {} layers", layer_stack.len());

    if layer_query_membership_changed {
        run_state
            .settle_facts
            .retain(|entity, _| layer_query.contains(*entity));
    }

    // A layer is settled once it is not releasing and all its transitions have finished, so its
    // output no longer depends on playback position. The composite of the bottom run of settled
    // layers is kept, and later passes resume from it while those layers stay unchanged. Higher
    // runs of settled layers are folded into per-parameter tables, so a fading layer below them
    // only pays for its own parameters.
    let layer_keys: Vec<_> = layer_stack
        .iter()
        .map(
            |(entity, object_ref_marker, layer, _, _)| SettledPrefixLayer {
                entity: *entity,
                layer_changed: layer.last_changed(),
                object_ref_changed: object_ref_marker.last_changed(),
            },
        )
        .collect();
    let (settled, tabulable): (Vec<bool>, Vec<bool>) = layer_stack
        .iter()
        .map(|(entity, _, layer, release_marker, compositing_context)| {
            // A layer changed since the last pass is composited as usual this pass, which avoids
            // scanning every assertion of layers that change every frame. It can be cached from
            // the next pass on if it stays unchanged.
            if release_marker.is_some() || layer.is_changed() {
                return (false, false);
            }
            let layer_changed = layer.last_changed();
            let facts = match run_state.settle_facts.get(entity) {
                Some((tick, facts)) if *tick == layer_changed => *facts,
                _ => {
                    let facts = LayerSettleFacts {
                        settle_position: layer_settle_position(layer),
                        tabulable: SettledRunTable::is_tabulable(layer),
                    };
                    run_state
                        .settle_facts
                        .insert(*entity, (layer_changed, facts));
                    facts
                }
            };
            let position = compositing_context
                .as_ref()
                .map_or(Duration::ZERO, |context| context.position);
            let is_settled = position >= facts.settle_position;
            (is_settled, is_settled && facts.tabulable)
        })
        .unzip();
    let settled_prefix_len = settled.iter().take_while(|settled| **settled).count();
    let (reused_len, prefix) = match run_state.settled_prefix.take() {
        Some(cached)
            if !parameter_set_changed
                && cached.layers.len() <= settled_prefix_len
                && cached.layers[..] == layer_keys[..cached.layers.len()] =>
        {
            (cached.layers.len(), cached.composited)
        }
        _ => (0, CompositedPrefix::default()),
    };
    let snapshot_after = (settled_prefix_len > 0).then(|| settled_prefix_len - reused_len);
    let pipeline_layers: Vec<_> = layer_stack
        .into_iter()
        .map(
            |(entity, object_ref_marker, layer, release_marker, compositing_context)| {
                let is_releasing = release_marker.is_some();
                (
                    entity,
                    object_ref_marker.0.clone(),
                    layer.into_inner(),
                    is_releasing,
                    compositing_context.map(|context| *context),
                )
            },
        )
        .collect();
    let settled_run_ranges = settled_run_ranges(&tabulable, settled_prefix_len);
    let mut previous_runs = std::mem::take(&mut run_state.settled_runs);
    if parameter_set_changed {
        previous_runs.clear();
    }
    let mut param_query = parameters.queries.p2();

    // Every layer reads the same parameters, so snapshot their compositing contexts once instead of
    // fetching each parameter component once per layer.
    let (base_layer, attributed_assertions_layer, output_layers, snapshot, settled_runs) = {
        let parameter_contexts = ParameterCompositingContextTable::new(&param_query);
        let mut output_layers = Vec::new();
        let settled_runs: Vec<SettledRun> = settled_run_ranges
            .iter()
            .map(|range| {
                let entry_priority = range
                    .start
                    .checked_sub(1)
                    .map(|below| pipeline_layers[below].2.priority);
                let keys = &layer_keys[range.clone()];
                if let Some(index) = previous_runs.iter().position(|run| {
                    run.layers[..] == keys[..] && run.table.entry_priority() == entry_priority
                }) {
                    return previous_runs.swap_remove(index);
                }
                let (table, run_output_layers) = SettledRunTable::build(
                    pipeline_layers[range.clone()].iter().map(
                        |(entity, object_ref, layer, _, context)| {
                            (
                                *entity,
                                object_ref.clone(),
                                *layer,
                                context.unwrap_or_default(),
                            )
                        },
                    ),
                    entry_priority,
                    &parameter_contexts,
                );
                output_layers.extend(run_output_layers);
                SettledRun {
                    layers: keys.to_vec(),
                    table,
                }
            })
            .collect();

        let mut steps = Vec::with_capacity(pipeline_layers.len());
        let mut runs = settled_run_ranges.iter().zip(&settled_runs).peekable();
        let mut index = reused_len;
        while index < pipeline_layers.len() {
            if let Some((range, run)) = runs.next_if(|(range, _)| range.start == index) {
                steps.push(CompositeStep::SettledRun(&run.table));
                index = range.end;
            } else {
                steps.push(CompositeStep::Layer(pipeline_layers[index].clone()));
                index += 1;
            }
        }

        let (base, attributed, composed_output_layers, snapshot) =
            CompositorPipeline::compose_resuming(
                prefix,
                steps,
                snapshot_after,
                &parameter_contexts,
            );
        output_layers.extend(composed_output_layers);
        (base, attributed, output_layers, snapshot, settled_runs)
    };
    run_state.settled_prefix = snapshot.map(|composited| SettledPrefix {
        layers: layer_keys[..settled_prefix_len].to_vec(),
        composited,
    });
    run_state.settled_runs = settled_runs;

    for (entity, output_layer) in output_layers {
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
            param.compositing_context().default_value
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

#[cfg(test)]
mod tests {
    use nightfall::prelude::*;
    use nightfall_dmx::prelude::*;

    use super::*;
    use crate::types::test_support::*;

    /// Adds the removal tracking the compositor reads to a bare test world.
    fn init_removal_tracking(world: &mut World) {
        world.init_resource::<CompositorRemovals<TestParameter>>();
    }

    /// Returns a one-second linear fade starting at the beginning of source-local playback.
    fn one_second_fade() -> MaterializedTransition {
        MaterializedTransition {
            delay_in: Duration::ZERO,
            fade_in: Duration::from_secs(1),
            curve_in: FadeCurve::Linear,
            delay_out: Duration::ZERO,
            fade_out: Duration::from_secs(1),
            curve_out: FadeCurve::Linear,
            start_position: Duration::ZERO,
            release_position: None,
        }
    }

    /// Spawns a layer asserting `value` on every parameter with a one-second fade, evaluated at
    /// `position`.
    fn spawn_fading_layer(
        world: &mut World,
        parameters: &[Instance<TestParameter>],
        priority: i8,
        value: f32,
        position: Duration,
    ) -> Entity {
        let mut layer = Layer::new(format!("layer {priority}"), Priority(priority));
        for parameter in parameters {
            layer.absolute.insert(
                *parameter,
                (ParameterValue::Absolute { value }, Some(one_second_fade())),
            );
        }
        world
            .spawn((
                ObjectRefMarker(ObjectRef::ById {
                    object_type: ObjectType::Cue,
                    id: (priority as u32 + 1) * 1000 + value as u32,
                }),
                layer,
                LayerCompositingContext {
                    position,
                    released_at: None,
                },
            ))
            .id()
    }

    /// Composites the world's layers from scratch, without any cached settled prefix.
    fn composite_from_scratch(world: &mut World) -> (ComputedLayer, AttributedAssertionsLayer) {
        let mut layers: Vec<_> = world
            .query::<(
                Entity,
                &ObjectRefMarker,
                &Layer,
                Option<&LayerCompositingContext>,
            )>()
            .iter(world)
            .map(|(entity, object_ref, layer, context)| {
                (
                    entity,
                    object_ref.0.clone(),
                    layer.clone(),
                    false,
                    context.copied(),
                )
            })
            .collect();
        layers.sort_by_key(|(_, _, layer, _, _)| (*layer.priority, layer.activation_time));
        let mut parameter_state = world.query::<InstanceMut<TestParameter>>();
        let parameters = parameter_state.query_mut(world);
        let (base, attributed, _) =
            CompositorPipeline::compose_with_layer_compositing_contexts(layers, &parameters);
        (base, attributed)
    }

    /// Asserts that the compositor system's last output matches a from-scratch composite.
    fn assert_matches_from_scratch(world: &mut World) {
        let (expected_base, expected_attributed) = composite_from_scratch(world);
        assert_eq!(world.resource::<FinalLayerOutput>().0, expected_base);
        assert_eq!(
            world.resource::<FinalLayerAttributedAssertions>().0,
            expected_attributed
        );
    }

    /// Resuming from the settled bottom layers gives the same output as compositing every layer,
    /// while the upper layer fades and after a settled layer changes.
    #[test]
    fn settled_prefix_matches_full_composite() {
        let mut world = World::new();
        world.init_resource::<FinalLayerAttributedAssertions>();
        world.init_resource::<FinalLayerOutput>();
        init_removal_tracking(&mut world);
        let parameters: Vec<_> = (0..3)
            .map(|_| {
                let entity = world
                    .spawn(TestParameter::new(TestMergeMode::Ltp, Attribute::Red))
                    .id();
                unsafe { Instance::<TestParameter>::from_entity_unchecked(entity) }
            })
            .collect();
        let settled = spawn_fading_layer(&mut world, &parameters, 0, 100.0, Duration::from_secs(5));
        spawn_fading_layer(
            &mut world,
            &parameters[..2],
            1,
            200.0,
            Duration::from_secs(5),
        );
        let fading = spawn_fading_layer(&mut world, &parameters[..1], 2, 50.0, Duration::ZERO);
        let mut schedule = Schedule::default();
        schedule.add_systems(compositor::<TestParameter>);

        for position_ms in [250, 500, 750] {
            world
                .get_mut::<LayerCompositingContext>(fading)
                .expect("fading layer context")
                .position = Duration::from_millis(position_ms);
            schedule.run(&mut world);
            assert_matches_from_scratch(&mut world);
        }

        world
            .get_mut::<Layer>(settled)
            .expect("settled layer")
            .absolute
            .insert(
                parameters[2],
                (ParameterValue::Absolute { value: 10.0 }, None),
            );
        world
            .get_mut::<LayerCompositingContext>(fading)
            .expect("fading layer context")
            .position = Duration::from_millis(900);
        schedule.run(&mut world);
        assert_matches_from_scratch(&mut world);
        assert_eq!(
            world
                .resource::<FinalLayerOutput>()
                .0
                .absolute
                .get(parameters[2]),
            Some(&10.0)
        );
    }

    /// Settled layers above a fading bottom layer, folded into a run table, give the same output
    /// and attribution as compositing every layer, including same-priority HTP merges, parameters
    /// the run leaves to the layer below, and after a layer in the run changes.
    #[test]
    fn settled_run_table_matches_full_composite() {
        let mut world = World::new();
        world.init_resource::<FinalLayerAttributedAssertions>();
        world.init_resource::<FinalLayerOutput>();
        init_removal_tracking(&mut world);
        let parameters: Vec<_> = [
            TestMergeMode::Ltp,
            TestMergeMode::Ltp,
            TestMergeMode::Htp,
            TestMergeMode::Htp,
        ]
        .into_iter()
        .map(|merge_mode| {
            let entity = world
                .spawn(TestParameter::new(merge_mode, Attribute::Red))
                .id();
            unsafe { Instance::<TestParameter>::from_entity_unchecked(entity) }
        })
        .collect();
        let fading = spawn_fading_layer(&mut world, &parameters, 1, 200.0, Duration::ZERO);
        spawn_fading_layer(
            &mut world,
            &parameters[1..],
            1,
            120.0,
            Duration::from_secs(5),
        );
        let same_priority = spawn_fading_layer(
            &mut world,
            &parameters[2..],
            1,
            80.0,
            Duration::from_secs(5),
        );
        spawn_fading_layer(
            &mut world,
            &parameters[3..],
            2,
            60.0,
            Duration::from_secs(5),
        );
        let mut schedule = Schedule::default();
        schedule.add_systems(compositor::<TestParameter>);

        for position_ms in [250, 500, 750] {
            world
                .get_mut::<LayerCompositingContext>(fading)
                .expect("fading layer context")
                .position = Duration::from_millis(position_ms);
            schedule.run(&mut world);
            assert_matches_from_scratch(&mut world);
        }

        world
            .get_mut::<Layer>(same_priority)
            .expect("settled layer")
            .absolute
            .insert(
                parameters[2],
                (ParameterValue::Absolute { value: 250.0 }, None),
            );
        world
            .get_mut::<LayerCompositingContext>(fading)
            .expect("fading layer context")
            .position = Duration::from_millis(900);
        schedule.run(&mut world);
        assert_matches_from_scratch(&mut world);
        assert_eq!(
            world
                .resource::<FinalLayerOutput>()
                .0
                .absolute
                .get(parameters[2]),
            Some(&250.0)
        );
    }
}
