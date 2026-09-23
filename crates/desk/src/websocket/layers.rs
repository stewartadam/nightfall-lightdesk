// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Layer-stack projection and transition-state derivation.

use super::*;

/// Layer components projected into websocket layer snapshots.
pub(super) type LayerSnapshotData = (
    &'static Layer,
    &'static BaseLayer,
    &'static OutputLayer,
    Option<&'static ObjectRefMarker>,
    Option<&'static ReleaseMarker>,
    Option<&'static LayerCompositingContext>,
    Option<&'static LookaheadAssertions>,
    Option<&'static InstanceStatus>,
);

/// Converts a parameter reference into the ECS instance key used by layer maps.
fn parameter_instance(parameter: ParameterRef) -> moonshine_kind::Instance<Parameter> {
    unsafe { moonshine_kind::Instance::from_entity_unchecked(parameter.entity()) }
}

/// Transform a `Layer` into the same fixture-centric representation that `ParameterState` uses.
fn layer_absolute_fixture_state(
    layer: &Layer,
    param_map: &bimap::BiMap<(FixtureRef, Attribute), moonshine_kind::Instance<Parameter>>,
    parameters_query: &Query<&Parameter>,
) -> Vec<OutboundElementParameterValues> {
    // (fixture_id -> vec[element_index -> attribute map])
    let mut per_fixture: HashMap<Uuid, Vec<HashMap<Attribute, ParameterValue>>> = HashMap::new();

    for (param_instance, (param_value, _)) in layer.absolute.iter() {
        // Determine fixture/element and attribute information
        let typed_param = parameter_instance(param_instance);
        let Some((fixture_ref, _)) = param_map.get_by_right(&typed_param) else {
            continue;
        };
        let param = parameters_query.get(param_instance.entity()).unwrap();
        let attribute = param.metadata.attribute.clone();

        // Insert into map
        let entry = per_fixture.entry(fixture_ref.fixture_uid).or_default();
        let element_index = fixture_ref.index.unwrap_or(1) as usize - 1;
        if entry.len() <= element_index {
            // Ensure capacity
            entry.resize_with(element_index + 1, HashMap::new);
        }
        entry[element_index].insert(attribute, *param_value);
    }

    // Convert to Vec as required by the websocket schema
    per_fixture
        .into_iter()
        .map(|(fixture_uid, parameters)| OutboundElementParameterValues {
            fixture_uid,
            parameters,
        })
        .collect()
}

/// Transform a `Layer` into the same fixture-centric representation that `ParameterState` uses.
fn layer_relative_fixture_state(
    layer: &Layer,
    param_map: &bimap::BiMap<(FixtureRef, Attribute), moonshine_kind::Instance<Parameter>>,
    parameters_query: &Query<&Parameter>,
) -> Vec<OutboundElementParameterValues> {
    // (fixture_id -> vec[element_index -> attribute map])
    let mut per_fixture: HashMap<Uuid, Vec<HashMap<Attribute, ParameterValue>>> = HashMap::new();

    for (param_instance, (param_value, _)) in layer.relative.iter() {
        // Determine fixture/element and attribute information
        let typed_param = parameter_instance(param_instance);
        let Some((fixture_ref, _)) = param_map.get_by_right(&typed_param) else {
            continue;
        };
        let param = parameters_query.get(param_instance.entity()).unwrap();
        let attribute = param.metadata.attribute.clone();

        // Insert into map
        let entry = per_fixture.entry(fixture_ref.fixture_uid).or_default();
        let element_index = fixture_ref.index.unwrap_or(1) as usize - 1;
        if entry.len() <= element_index {
            // Ensure capacity
            entry.resize_with(element_index + 1, HashMap::new);
        }
        entry[element_index].insert(attribute, *param_value);
    }

    // Convert to Vec as required by the websocket schema
    per_fixture
        .into_iter()
        .map(|(fixture_uid, parameters)| OutboundElementParameterValues {
            fixture_uid,
            parameters,
        })
        .collect()
}

/// Transform lookahead assertions into a fixture-centric websocket representation.
fn lookahead_assertions_fixture_state(
    assertions: Option<&LookaheadAssertions>,
    param_map: &bimap::BiMap<(FixtureRef, Attribute), moonshine_kind::Instance<Parameter>>,
    parameters_query: &Query<&Parameter>,
) -> Vec<OutboundElementParameterValues> {
    let Some(assertions) = assertions else {
        return Vec::new();
    };

    let mut per_fixture: HashMap<Uuid, Vec<HashMap<Attribute, ParameterValue>>> = HashMap::new();

    for assertion in &assertions.assertions {
        let Some((fixture_ref, _)) = param_map.get_by_right(&assertion.parameter) else {
            continue;
        };
        let Ok(parameter) = parameters_query.get(assertion.parameter.entity()) else {
            continue;
        };
        let attribute = parameter.metadata.attribute.clone();
        let entry = per_fixture.entry(fixture_ref.fixture_uid).or_default();
        let element_index = fixture_ref.index.unwrap_or(1) as usize - 1;
        if entry.len() <= element_index {
            entry.resize_with(element_index + 1, HashMap::new);
        }
        entry[element_index].insert(attribute, assertion.value);
    }

    per_fixture
        .into_iter()
        .map(|(fixture_uid, parameters)| OutboundElementParameterValues {
            fixture_uid,
            parameters,
        })
        .collect()
}

/// Transform a `ComputedLayer` into the same fixture-centric representation that `ParameterState` uses.
fn computed_layer_fixture_state(
    output: &ComputedLayer,
    param_map: &bimap::BiMap<(FixtureRef, Attribute), moonshine_kind::Instance<Parameter>>,
    parameters_query: &Query<&Parameter>,
) -> Vec<OutboundElementComputedState> {
    // (fixture_id -> vec[element_index -> attribute map])
    let mut per_fixture: HashMap<Uuid, Vec<HashMap<Attribute, ParameterDmxValue>>> = HashMap::new();

    for (param_instance, value) in output.absolute.iter() {
        // Determine fixture/element and attribute information
        let typed_param = parameter_instance(param_instance);
        let Some((fixture_ref, _)) = param_map.get_by_right(&typed_param) else {
            continue;
        };
        let param = parameters_query.get(param_instance.entity()).unwrap();
        let attribute = param.metadata.attribute.clone();

        // Insert into map
        let entry = per_fixture.entry(fixture_ref.fixture_uid).or_default();
        let element_index = fixture_ref.index.unwrap_or(1) as usize - 1;
        if entry.len() <= element_index {
            // Ensure capacity
            entry.resize_with(element_index + 1, HashMap::new);
        }
        entry[element_index].insert(attribute, *value);
    }

    // Convert to Vec as required by the websocket schema
    per_fixture
        .into_iter()
        .map(|(fixture_uid, parameters)| OutboundElementComputedState {
            fixture_uid,
            parameters,
        })
        .collect()
}

/// Builds fixture-centric transition flags for one computed layer snapshot.
pub(super) fn computed_transition_fixture_state(
    layer: &Layer,
    output: &ComputedLayer,
    param_map: &bimap::BiMap<(FixtureRef, Attribute), moonshine_kind::Instance<Parameter>>,
    parameters_query: &Query<&Parameter>,
    is_releasing: bool,
    compositing_context: Option<&LayerCompositingContext>,
) -> Vec<OutboundElementTransitionState> {
    let mut per_fixture: HashMap<Uuid, Vec<HashMap<Attribute, bool>>> = HashMap::new();

    let mut mark_transition = |param_instance: ParameterRef, active: bool| {
        if !active {
            return;
        }

        let typed_param = parameter_instance(param_instance);
        let Some((fixture_ref, _)) = param_map.get_by_right(&typed_param) else {
            return;
        };
        let Ok(parameter) = parameters_query.get(param_instance.entity()) else {
            return;
        };

        let entry = per_fixture.entry(fixture_ref.fixture_uid).or_default();
        let element_index = fixture_ref.index.unwrap_or(1) as usize - 1;
        if entry.len() <= element_index {
            entry.resize_with(element_index + 1, HashMap::new);
        }
        entry[element_index].insert(parameter.metadata.attribute.clone(), true);
    };

    for (param_instance, (value, transition)) in layer.absolute.iter() {
        let current_output = output
            .absolute
            .get(param_instance)
            .copied()
            .unwrap_or_default();
        let active = is_releasing
            || layer
                .transitioning
                .get(param_instance)
                .copied()
                .unwrap_or(false)
            || transition.as_ref().is_some_and(|transition| {
                is_transition_active(
                    parameters_query,
                    param_instance,
                    value,
                    transition,
                    current_output,
                    compositing_context,
                )
            });
        mark_transition(param_instance, active);
    }

    for (param_instance, (value, transition)) in layer.relative.iter() {
        let current_output = output
            .relative
            .get(param_instance)
            .copied()
            .unwrap_or_default();
        let active = is_releasing
            || layer
                .transitioning
                .get(param_instance)
                .copied()
                .unwrap_or(false)
            || transition.as_ref().is_some_and(|transition| {
                is_transition_active(
                    parameters_query,
                    param_instance,
                    value,
                    transition,
                    current_output,
                    compositing_context,
                )
            });
        mark_transition(param_instance, active);
    }

    per_fixture
        .into_iter()
        .map(|(fixture_uid, parameters)| OutboundElementTransitionState {
            fixture_uid,
            parameters,
        })
        .collect()
}

/// Reports whether a materialized transition is still changing its parameter output.
pub(super) fn is_transition_active(
    parameters_query: &Query<&Parameter>,
    param_instance: ParameterRef,
    value: &ParameterValue,
    transition: &MaterializedTransition,
    current_output: ParameterDmxValue,
    compositing_context: Option<&LayerCompositingContext>,
) -> bool {
    let elapsed = compositing_context
        .map(|context| transition.elapsed_from_start(context.position))
        .unwrap_or_default();

    if elapsed < transition.delay_in {
        return true;
    }

    if let Some(released_at) = transition
        .release_position
        .or_else(|| compositing_context.and_then(|context| context.released_at))
    {
        return if let Some(context) = compositing_context {
            let elapsed_since_release = context.position.saturating_sub(released_at);
            transition.transition_release_parameter_ratio_at_elapsed(elapsed_since_release) < 1.0
        } else {
            transition.transition_release_parameter_ratio_at_elapsed(Duration::ZERO) < 1.0
        };
    }

    let Ok(parameter) = parameters_query.get(param_instance.entity()) else {
        return elapsed < transition.delay_in + transition.fade_in;
    };

    let maybe_target = match value {
        ParameterValue::Absolute { value } => Some(*value),
        ParameterValue::AbsolutePercent { value } => {
            let clamped_percent = (*value).clamp(0.0.into(), 1.0.into());
            let range = parameter.metadata.max - parameter.metadata.min;
            Some(range * clamped_percent.as_f64())
        }
        ParameterValue::Relative { .. } | ParameterValue::RelativePercent { .. } => None,
    };
    let uses_fade_out_timing = matches!(parameter.metadata.merge_type, MergeStrategy::HTP)
        && match value {
            ParameterValue::Relative { offset } => *offset < 0.0,
            ParameterValue::RelativePercent { offset } => *offset < 0.0.into(),
            _ => false,
        };

    let ratio = if let Some(target) = maybe_target {
        if matches!(parameter.metadata.merge_type, MergeStrategy::HTP) && current_output > target {
            transition.transition_out_parameter_ratio_at_elapsed(elapsed)
        } else {
            transition.transition_in_parameter_ratio_at_elapsed(elapsed)
        }
    } else if uses_fade_out_timing {
        transition.transition_out_parameter_ratio_at_elapsed(elapsed)
    } else {
        if transition.fade_in.is_zero() {
            1.0
        } else {
            (elapsed.saturating_sub(transition.delay_in).as_secs_f32()
                / transition.fade_in.as_secs_f32())
            .clamp(0.0, 1.0)
        }
    };

    ratio < 1.0
}

/// Sends the current layer stack (metadata + computed values) to websocket clients
pub fn send_layer_stack(
    fixture_data_provider: &Res<FixtureDataProviderExt>,
    parameters_query: Query<&Parameter>,
    layers: Query<LayerSnapshotData>,
    mut diagnostics: Option<&mut Diagnostics>,
    broadcaster: &Res<ClientEventSink>,
) {
    let _span = tracing::debug_span!("send_layer_stack").entered();
    let build_start = Instant::now();
    let mut transition_build_elapsed = Duration::ZERO;
    // Acquire parameter map lock once for all layers
    let param_map = fixture_data_provider.parameter_attribute_map_guard();

    // Collect and sort by the same priority/activation ordering as the compositor.
    let mut stack: Vec<_> = layers
        .iter()
        .map(
            |(
                layer,
                _base,
                output,
                object_ref,
                release_marker,
                compositing_context,
                lookahead_assertions,
                runtime_status,
            )| {
                let transition_start = Instant::now();
                let is_releasing = release_marker.is_some();
                let computed_transitioning = computed_transition_fixture_state(
                    layer,
                    &output.0,
                    &param_map,
                    &parameters_query,
                    is_releasing,
                    compositing_context,
                );
                transition_build_elapsed += transition_start.elapsed();

                (
                    *layer.priority,
                    layer.activation_time,
                    OutboundLayerState {
                        creator: layer.creator.clone(),
                        object_ref: object_ref.map(|marker| marker.0.clone()),
                        priority: layer.priority,
                        is_releasing: release_marker.is_some(),
                        runtime_position: runtime_status.map(|status| status.position.clone()),
                        asserted_absolute_values: layer_absolute_fixture_state(
                            layer,
                            &param_map,
                            &parameters_query,
                        ),
                        asserted_relative_values: layer_relative_fixture_state(
                            layer,
                            &param_map,
                            &parameters_query,
                        ),
                        lookahead_asserted_values: lookahead_assertions_fixture_state(
                            lookahead_assertions,
                            &param_map,
                            &parameters_query,
                        ),
                        computed_values: computed_layer_fixture_state(
                            &output.0,
                            &param_map,
                            &parameters_query,
                        ),
                        computed_transitioning,
                    },
                )
            },
        )
        .collect();

    stack.sort_by_key(|(priority, activation_time, _)| (*priority, *activation_time));
    let stack: Vec<_> = stack.into_iter().map(|(_, _, layer)| layer).collect();
    let build_elapsed = build_start.elapsed();
    if let Some(diagnostics) = diagnostics.as_deref_mut() {
        record_elapsed_ms(diagnostics, &LAYER_STACK_BUILD_MS, build_elapsed);
        record_elapsed_ms(
            diagnostics,
            &LAYER_STACK_TRANSITION_BUILD_MS,
            transition_build_elapsed,
        );
    }

    let broadcast_start = Instant::now();
    broadcaster.publish(DISCRIMINATOR_DROPPABLE, &DeskWsMessage::LayerStack(&stack));
    let broadcast_elapsed = broadcast_start.elapsed();
    if let Some(diagnostics) = diagnostics {
        record_elapsed_ms(diagnostics, &LAYER_STACK_BROADCAST_MS, broadcast_elapsed);
    }
    tracing::trace!(
        layer_count = stack.len(),
        build_ms = build_elapsed.as_secs_f64() * 1000.0,
        transition_build_ms = transition_build_elapsed.as_secs_f64() * 1000.0,
        broadcast_ms = broadcast_elapsed.as_secs_f64() * 1000.0,
        "LayerStack websocket baseline"
    );
}
