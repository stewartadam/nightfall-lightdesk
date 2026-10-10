// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Layer-stack projection and transition-state derivation.
//!
//! Layer values are packed by the slots of the parameter state layout, the same numbering
//! parameter state frames use, and a snapshot is only sent when it differs from the last one.

use nightfall_fixture_model::prelude::*;

use super::*;

/// Layer components projected into websocket layer snapshots.
pub type LayerSnapshotData = (
    &'static Layer,
    &'static OutputLayer,
    Option<&'static ObjectRefMarker>,
    Option<&'static ReleaseMarker>,
    Option<&'static LayerCompositingContext>,
    Option<&'static LookaheadAssertions>,
    Option<&'static InstanceStatus>,
);

/// Encoded payload of the last layer stack snapshot sent to clients.
///
/// Layer stack snapshots are droppable, so clients only ever need the newest one; an unchanged
/// snapshot carries nothing new and is not sent again.
#[derive(Resource, Default)]
pub struct LayerStackPublication {
    last_payload: Option<Vec<u8>>,
}

impl LayerStackPublication {
    /// Forgets the last snapshot so the next one is sent even when unchanged, for clients that
    /// just resynced and hold no layer stack yet.
    pub fn invalidate(&mut self) {
        self.last_payload = None;
    }
}

/// Packs a layer's assertions of one kind by layout slot, leaving out parameters the layout lacks.
fn packed_assertions<'a>(
    assertions: impl Iterator<Item = (ParameterRef, &'a ParameterValue)>,
    slot_of: &impl Fn(ParameterRef) -> Option<u32>,
) -> PackedLayerAssertions {
    let mut packed = PackedLayerAssertions::default();
    for (parameter, value) in assertions {
        if let Some(slot) = slot_of(parameter) {
            packed.push(slot, value);
        }
    }
    packed
}

/// Packs a layer's computed absolute values as parallel slot and value buffers.
fn packed_computed_values(
    output: &ComputedLayer,
    slot_of: &impl Fn(ParameterRef) -> Option<u32>,
) -> (PackedBytes, PackedBytes) {
    let mut slots = PackedBytes::default();
    let mut values = PackedBytes::default();
    for (parameter, value) in output.absolute.iter() {
        if let Some(slot) = slot_of(parameter) {
            slots.push_u32(slot);
            values.push_f32(*value);
        }
    }
    (slots, values)
}

/// Returns the layout slots of every parameter whose computed value in this layer is still
/// transitioning, because the layer is releasing, the compositor flagged it, or its fade has not
/// reached the target yet.
pub(super) fn computed_transitioning_slots(
    layer: &Layer,
    output: &ComputedLayer,
    slot_of: &impl Fn(ParameterRef) -> Option<u32>,
    parameters_query: &Query<&Parameter>,
    is_releasing: bool,
    compositing_context: Option<&LayerCompositingContext>,
) -> PackedBytes {
    let mut slots = PackedBytes::default();
    for (values, outputs) in [
        (&layer.absolute, &output.absolute),
        (&layer.relative, &output.relative),
    ] {
        for (param_instance, (value, transition)) in values.iter() {
            let Some(slot) = slot_of(param_instance) else {
                continue;
            };
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
                        outputs.get(param_instance).copied().unwrap_or_default(),
                        compositing_context,
                    )
                });
            if active {
                slots.push_u32(slot);
            }
        }
    }
    slots
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
            Some(range * clamped_percent.as_f32())
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

/// Sends the current layer stack (metadata + computed values) to websocket clients when it
/// differs from the last snapshot sent.
///
/// Run it after the parameter state layout is published in the same frame, so clients always
/// hold the layout the snapshot's slots refer to.
pub fn send_layer_stack(
    projection: &ParameterStateProjection,
    parameters_query: Query<&Parameter>,
    layers: Query<LayerSnapshotData>,
    publication: &mut LayerStackPublication,
    mut diagnostics: Option<&mut Diagnostics>,
    broadcaster: &ClientEventSink,
) {
    let _span = tracing::debug_span!("send_layer_stack").entered();
    let build_start = Instant::now();
    let mut transition_build_elapsed = Duration::ZERO;
    let slot_of = |parameter: ParameterRef| projection.slot_of(parameter);

    // Collect and sort by the same priority/activation ordering as the compositor.
    let mut stack: Vec<_> = layers
        .iter()
        .map(
            |(
                layer,
                output,
                object_ref,
                release_marker,
                compositing_context,
                lookahead_assertions,
                runtime_status,
            )| {
                let transition_start = Instant::now();
                let is_releasing = release_marker.is_some();
                let transitioning_slots = computed_transitioning_slots(
                    layer,
                    &output.0,
                    &slot_of,
                    &parameters_query,
                    is_releasing,
                    compositing_context,
                );
                transition_build_elapsed += transition_start.elapsed();
                let (computed_slots, computed_values) = packed_computed_values(&output.0, &slot_of);

                (
                    *layer.priority,
                    layer.activation_time,
                    OutboundLayerState {
                        creator: layer.creator.clone(),
                        object_ref: object_ref.map(|marker| marker.0.clone()),
                        priority: layer.priority,
                        is_releasing,
                        runtime_position: runtime_status.map(|status| status.position.clone()),
                        asserted_absolute: packed_assertions(
                            layer
                                .absolute
                                .iter()
                                .map(|(parameter, (value, _))| (parameter, value)),
                            &slot_of,
                        ),
                        asserted_relative: packed_assertions(
                            layer
                                .relative
                                .iter()
                                .map(|(parameter, (value, _))| (parameter, value)),
                            &slot_of,
                        ),
                        lookahead_asserted: packed_assertions(
                            lookahead_assertions
                                .into_iter()
                                .flat_map(|lookahead| &lookahead.assertions)
                                .map(|assertion| (assertion.parameter.into(), &assertion.value)),
                            &slot_of,
                        ),
                        computed_slots,
                        computed_values,
                        transitioning_slots,
                    },
                )
            },
        )
        .collect();

    stack.sort_by_key(|(priority, activation_time, _)| (*priority, *activation_time));
    let stack = OutboundLayerStack {
        layout_id: projection.layout_id(),
        layers: stack.into_iter().map(|(_, _, layer)| layer).collect(),
    };
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
    let Some(message) =
        EncodedClientMessage::new(DISCRIMINATOR_DROPPABLE, &DeskWsMessage::LayerStack(&stack))
    else {
        tracing::warn!("Failed to serialize layer stack");
        return;
    };
    let changed = publication.last_payload.as_ref() != Some(&message.payload);
    if changed {
        publication.last_payload = Some(message.payload.clone());
        broadcaster.send(message);
    }
    let broadcast_elapsed = broadcast_start.elapsed();
    if let Some(diagnostics) = diagnostics {
        record_elapsed_ms(diagnostics, &LAYER_STACK_BROADCAST_MS, broadcast_elapsed);
    }
    tracing::trace!(
        layer_count = stack.layers.len(),
        changed,
        build_ms = build_elapsed.as_secs_f64() * 1000.0,
        transition_build_ms = transition_build_elapsed.as_secs_f64() * 1000.0,
        broadcast_ms = broadcast_elapsed.as_secs_f64() * 1000.0,
        "LayerStack websocket baseline"
    );
}
