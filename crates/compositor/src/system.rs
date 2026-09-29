// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Compositor system that builds the layer stack and composites all layers.
use std::time::Duration;

use bevy_ecs::{change_detection::Tick, entity::EntityHashMap, prelude::*, system::SystemParam};
use moonshine_kind::prelude::*;

use crate::{
    pipeline::{CompositedPrefix, CompositorPipeline},
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
    /// Composite of the bottom layers that had finished fading on the last pass.
    settled_prefix: Option<SettledPrefix>,
    /// Playback position at which each layer's transitions have all finished, keyed by the layer
    /// entity and valid while the layer's change tick matches.
    settle_positions: EntityHashMap<(Tick, Duration)>,
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
            .settle_positions
            .retain(|entity, _| layer_query.contains(*entity));
    }

    // A layer is settled once it is not releasing and all its transitions have finished, so its
    // output no longer depends on playback position. The composite of the bottom run of settled
    // layers is kept, and later passes resume from it while those layers stay unchanged.
    let settled_prefix_len = layer_stack
        .iter()
        .take_while(|(entity, _, layer, release_marker, compositing_context)| {
            if release_marker.is_some() {
                return false;
            }
            let layer_changed = layer.last_changed();
            let settle_position = match run_state.settle_positions.get(entity) {
                Some((tick, position)) if *tick == layer_changed => *position,
                _ => {
                    let position = layer_settle_position(layer);
                    run_state
                        .settle_positions
                        .insert(*entity, (layer_changed, position));
                    position
                }
            };
            let position = compositing_context
                .as_ref()
                .map_or(Duration::ZERO, |context| context.position);
            position >= settle_position
        })
        .count();
    let settled_layers: Vec<_> = layer_stack[..settled_prefix_len]
        .iter()
        .map(
            |(entity, object_ref_marker, layer, _, _)| SettledPrefixLayer {
                entity: *entity,
                layer_changed: layer.last_changed(),
                object_ref_changed: object_ref_marker.last_changed(),
            },
        )
        .collect();
    let (reused_len, prefix) = match run_state.settled_prefix.take() {
        Some(cached)
            if !parameter_set_changed
                && cached.layers.len() <= settled_prefix_len
                && cached.layers[..] == settled_layers[..cached.layers.len()] =>
        {
            (cached.layers.len(), cached.composited)
        }
        _ => (0, CompositedPrefix::default()),
    };
    let snapshot_after = (settled_prefix_len > 0).then(|| settled_prefix_len - reused_len);

    let layers_for_pipeline: Vec<_> = layer_stack
        .into_iter()
        .skip(reused_len)
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
    let mut param_query = parameters.queries.p2();

    // Every layer reads the same parameters, so snapshot their compositing traits once instead of
    // fetching each parameter component once per layer.
    let (base_layer, attributed_assertions_layer, output_layers, snapshot) = {
        let parameter_traits = ParameterTraitsTable::new(&param_query);
        CompositorPipeline::compose_resuming(
            prefix,
            layers_for_pipeline,
            snapshot_after,
            &parameter_traits,
        )
    };
    run_state.settled_prefix = snapshot.map(|composited| SettledPrefix {
        layers: settled_layers,
        composited,
    });

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
            param.compositing_traits().default_value
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
                    id: priority as u32 + 1,
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
}
