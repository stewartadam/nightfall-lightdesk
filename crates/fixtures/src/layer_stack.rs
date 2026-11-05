// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! The layer stack feed: every layer's assertions and computed values, with what is still
//! transitioning.
//!
//! Layer values are packed by the slots of the parameter state layout, the same numbering
//! parameter state frames use, and a snapshot is only sent when it differs from the last one.

use std::time::Duration;

use bevy_app::App;
use bevy_diagnostic::{Diagnostic, DiagnosticPath, Diagnostics, RegisterDiagnostic};
use bevy_ecs::prelude::*;
use bevy_ecs::system::SystemParam;
use nightfall::prelude::{MaterializedTransition, ObjectRef, Priority};
use nightfall_compositor::prelude::*;
use nightfall_dmx::prelude::*;
use nightfall_engine::prelude::*;
use nightfall_fixture_model::prelude::*;
use nightfall_instances::{HeldButtonEffect, InstancePosition, InstanceStatus};
use serde::Serialize;
use web_time::Instant;

use crate::lookahead_assertions::LookaheadAssertions;
use crate::parameter::Parameter;
use crate::parameter_state::{ParameterStateProjection, assertion_kind};
use crate::websocket::record_elapsed_ms;

#[cfg(test)]
mod tests;

/// How often the layer stack is rebuilt and, when it changed, sent.
const SEND_INTERVAL: Duration = Duration::from_millis(100);

/// Time spent building the outbound layer stack snapshot.
pub const LAYER_STACK_BUILD_MS: DiagnosticPath =
    DiagnosticPath::const_new("fixtures/layer_stack/build_ms");
/// Time spent deriving which layer parameters are still transitioning.
pub const LAYER_STACK_TRANSITION_BUILD_MS: DiagnosticPath =
    DiagnosticPath::const_new("fixtures/layer_stack/transition_build_ms");
/// Time spent encoding and publishing the layer stack snapshot.
pub const LAYER_STACK_BROADCAST_MS: DiagnosticPath =
    DiagnosticPath::const_new("fixtures/layer_stack/broadcast_ms");

/// Registers the layer stack timings.
pub(crate) fn register_diagnostics(app: &mut App) {
    app.register_diagnostic(Diagnostic::new(LAYER_STACK_BUILD_MS).with_suffix(" ms"))
        .register_diagnostic(Diagnostic::new(LAYER_STACK_TRANSITION_BUILD_MS).with_suffix(" ms"))
        .register_diagnostic(Diagnostic::new(LAYER_STACK_BROADCAST_MS).with_suffix(" ms"));
}

/// Layer stack messages sent to clients.
#[derive(Serialize)]
#[serde(tag = "type", content = "data")]
#[typeshare::typeshare]
pub(crate) enum LayerStackWsMessage<'a> {
    /// Layer stack with computed values (sorted by priority)
    LayerStack(&'a OutboundLayerStack),
}

/// Layer components projected into websocket layer snapshots.
pub type LayerSnapshotData = (
    &'static Layer,
    &'static OutputLayer,
    Option<&'static ObjectRefMarker>,
    Option<&'static ReleaseMarker>,
    Option<&'static LayerCompositingContext>,
    Option<&'static LookaheadAssertions>,
    Option<&'static InstanceStatus>,
    Option<&'static HeldButtonEffect>,
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
pub(crate) fn computed_transitioning_slots(
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
pub(crate) fn is_transition_active(
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
                held_button,
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
                        held_button: held_button.copied(),
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
    let Some(message) = EncodedClientMessage::new(
        DISCRIMINATOR_DROPPABLE,
        &LayerStackWsMessage::LayerStack(&stack),
    ) else {
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

/// Layer stack snapshot whose parameter values are indexed by the slots of a
/// [`ParameterLayout`](nightfall_fixtures::parameter_state::ParameterLayout).
///
/// Clients resolve each slot to its fixture, element and attribute with the layout they already
/// hold for parameter state frames, so the snapshot carries no fixture ids or attribute names.
#[derive(Debug, Default, Serialize)]
#[typeshare::typeshare]
pub(crate) struct OutboundLayerStack {
    /// Layout the slots are indexed by. Clients holding a different layout discard the snapshot;
    /// the backend sends a new one after every layout change.
    pub layout_id: u32,
    /// Layers in compositing order, lowest priority first.
    pub layers: Vec<OutboundLayerState>,
}

/// Wire representation of a single layer's computation information sent to the UI
#[derive(Debug, Serialize)]
#[typeshare::typeshare]
pub(crate) struct OutboundLayerState {
    /// Creator name of the layer (cue / programmer / etc.)
    pub creator: String,
    /// Source object that created the layer, if available
    pub object_ref: Option<ObjectRef>,
    /// Numeric priority – lower values are merged first
    pub priority: Priority,
    /// Whether this layer is fading out before removal
    pub is_releasing: bool,
    /// Current source-specific playback position for playback-backed layers.
    pub runtime_position: Option<InstancePosition>,
    /// How a held fader Flash or Swop changes this layer's playback; a playback a Swop
    /// takes out asserts nothing while the Swop is held.
    pub held_button: Option<HeldButtonEffect>,
    /// Asserted absolute parameter values for this layer.
    pub asserted_absolute: PackedLayerAssertions,
    /// Asserted relative parameter values for this layer.
    pub asserted_relative: PackedLayerAssertions,
    /// Backend-owned lookahead assertions, such as lookahead values.
    pub lookahead_asserted: PackedLayerAssertions,
    /// Layout slot of each computed absolute value as a `u32`.
    #[typeshare(serialized_as = "Uint8Array<ArrayBufferLike>")]
    pub computed_slots: PackedBytes,
    /// Computed absolute value of each slot in `computed_slots` as an `f32`.
    #[typeshare(serialized_as = "Uint8Array<ArrayBufferLike>")]
    pub computed_values: PackedBytes,
    /// Layout slot of each parameter whose computed value is still transitioning, as a `u32`.
    #[typeshare(serialized_as = "Uint8Array<ArrayBufferLike>")]
    pub transitioning_slots: PackedBytes,
}

/// Asserted parameter values of one layer, packed like parameter state frame assertions.
#[derive(Debug, Default, Serialize)]
#[typeshare::typeshare]
pub(crate) struct PackedLayerAssertions {
    /// Layout slot of each assertion as a `u32`.
    #[typeshare(serialized_as = "Uint8Array<ArrayBufferLike>")]
    pub slots: PackedBytes,
    /// Kind code of each assertion as a `u8`, indexing the layout's `assertion_variants`.
    #[typeshare(serialized_as = "Uint8Array<ArrayBufferLike>")]
    pub kinds: PackedBytes,
    /// Value or offset of each assertion as an `f32`.
    #[typeshare(serialized_as = "Uint8Array<ArrayBufferLike>")]
    pub values: PackedBytes,
}

impl PackedLayerAssertions {
    /// Appends one assertion for `slot`, encoded with the parameter state assertion kind codes.
    pub(crate) fn push(&mut self, slot: u32, value: &ParameterValue) {
        let (kind, number) = assertion_kind(value);
        self.slots.push_u32(slot);
        self.kinds.0.push(kind);
        self.values.push_f32(number);
    }
}

/// Little-endian packed numbers serialized as one binary string, so clients can view them as a
/// typed array instead of decoding each value.
#[derive(Debug, Default, Clone, PartialEq)]
pub(crate) struct PackedBytes(pub Vec<u8>);

impl PackedBytes {
    /// Appends a `u32` in little-endian order.
    pub(crate) fn push_u32(&mut self, value: u32) {
        self.0.extend_from_slice(&value.to_le_bytes());
    }

    /// Appends an `f32` in little-endian order.
    pub(crate) fn push_f32(&mut self, value: f32) {
        self.0.extend_from_slice(&value.to_le_bytes());
    }
}

impl Serialize for PackedBytes {
    /// Writes the bytes through `serialize_bytes`, which CBOR encodes as a single byte string.
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_bytes(&self.0)
    }
}

/// State the layer stack snapshot is built from and change-checked against.
#[derive(SystemParam)]
pub(crate) struct LayerStackParams<'w, 's> {
    projection: Res<'w, ParameterStateProjection>,
    parameters: Query<'w, 's, &'static Parameter>,
    layers: Query<'w, 's, LayerSnapshotData>,
    publication: ResMut<'w, LayerStackPublication>,
}

/// Sends the layer stack every [`SEND_INTERVAL`] when it changed, timing each pass.
pub(crate) fn send_layer_stack_at_interval(
    mut layer_stack: LayerStackParams,
    mut diagnostics: Diagnostics,
    mut last_sent: Local<Option<Instant>>,
    broadcaster: Res<ClientEventSink>,
) {
    if last_sent.is_some_and(|sent_at| sent_at.elapsed() < SEND_INTERVAL) {
        return;
    }
    *last_sent = Some(Instant::now());
    send_layer_stack(
        &layer_stack.projection,
        layer_stack.parameters,
        layer_stack.layers,
        &mut layer_stack.publication,
        Some(&mut diagnostics),
        &broadcaster,
    );
}

/// Makes the next layer stack pass send its snapshot to a client that asked for a full resync,
/// after the parameter layout its slots refer to.
pub(crate) fn handle_resync_state(
    mut resync: ResyncReplies,
    mut publication: ResMut<LayerStackPublication>,
) {
    if resync.sink().is_some() {
        publication.invalidate();
    }
}
