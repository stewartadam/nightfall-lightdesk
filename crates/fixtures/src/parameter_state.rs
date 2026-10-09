// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Client projection of every patched parameter's output and asserted values.
//!
//! Clients receive the projection as two messages. A [`ParameterLayout`] lists every patched
//! fixture element attribute in a fixed slot order and is published only when the patch changes or
//! a client resyncs. Every frame then publishes [`ParameterStateFrame`]: packed numeric buffers indexed
//! by those slots, so the per-frame message carries no attribute names, maps or fixture ids.
//!
//! Frames form a numbered stream. A keyframe carries every slot and replaces whatever the client
//! held; a delta carries only the slots whose output bits changed since the previous frame, and
//! applies only on top of the frame numbered one before it. A client that sees a gap discards
//! deltas until the next keyframe and can ask for one with [`PARAMETER_KEYFRAME_REQUEST_MODULE`].
//! Keyframes follow every layout publication and recur every [`KEYFRAME_INTERVAL`], so a client
//! never stays wrong for longer than that even if it misses a gap.

use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use bevy_ecs::prelude::*;
use moonshine_kind::Instance;
use nightfall::prelude::FixtureRef;
use nightfall_compositor::prelude::{AttributedAssertionsLayer, ParameterMap};
use nightfall_dmx::prelude::ParameterValue;
use serde::{Serialize, Serializer};
use uuid::Uuid;
use web_time::Instant;

use crate::data_provider_ext::FixtureDataProviderExt;
use crate::parameter::Parameter;
use crate::parameter_index::ParameterIndex;

/// `ParameterValue` variant named by each assertion kind code, indexed by code.
///
/// [`assertion_kind`] assigns the codes; a test pins each name to the variant's serialized tag.
pub const PARAMETER_ASSERTION_VARIANTS: [&str; 4] =
    ["Absolute", "AbsolutePercent", "Relative", "RelativePercent"];

/// Slot order of every patched fixture parameter in [`ParameterStateFrame`] frames.
#[typeshare::typeshare]
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct ParameterLayout {
    /// Identifies this layout, unique across every world in the backend process. Values frames
    /// carrying a different id belong to another layout and must be discarded.
    pub layout_id: u32,
    /// Patched fixtures in slot order.
    pub fixtures: Vec<ParameterLayoutFixture>,
    /// `ParameterValue` variant name of each assertion kind code, indexed by code.
    #[typeshare(serialized_as = "Vec<String>")]
    pub assertion_variants: &'static [&'static str],
}

/// Output slots of one fixture within a [`ParameterLayout`].
#[typeshare::typeshare]
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ParameterLayoutFixture {
    /// Unique ID of the fixture.
    #[serde(serialize_with = "nightfall::serde_uuid_simple::serialize")]
    pub fixture_uid: Uuid,
    /// Attribute keys of each element's slots, in slot order. Slots run consecutively across
    /// elements and fixtures. Elements without patched parameters keep an empty entry so element
    /// positions match the fixture definition.
    pub elements: Vec<Vec<String>>,
}

/// Update module clients send, with an empty payload, to ask for a keyframe on the next frame.
pub const PARAMETER_KEYFRAME_REQUEST_MODULE: &str = "ParameterKeyframeRequest";

/// Longest time between keyframes while deltas are being sent.
pub const KEYFRAME_INTERVAL: Duration = Duration::from_secs(2);

/// Output and asserted values of the slots in the current [`ParameterLayout`], as one numbered
/// keyframe or delta of the parameter stream.
///
/// Buffers are little-endian packed numbers rather than CBOR arrays so clients can view them as
/// typed arrays without decoding each value.
#[typeshare::typeshare]
#[derive(Debug, Serialize)]
pub struct ParameterStateFrame<'a> {
    /// Layout these values are indexed by.
    pub layout_id: u32,
    /// Position of this frame in the stream, one more than the previous frame, wrapping at
    /// `u32::MAX`. A delta applies only to state built from the frame numbered one before it.
    pub seq: u32,
    /// Whether this frame carries every slot and replaces the client's state, rather than only
    /// the slots that changed.
    pub keyframe: bool,
    /// Whether this keyframe's `changed_slots` lists every slot whose output changed since the
    /// previous frame. A client holding the previous frame can then apply just those slots from
    /// `output` and expect the result to equal the whole keyframe; any other difference is drift.
    /// Always false for a delta.
    pub verifiable: bool,
    /// Slot of each value in `output` as a `u32`, for a delta. For a verifiable keyframe, the
    /// slots that changed since the previous frame, whose values are at those slots of `output`;
    /// empty for any other keyframe.
    #[typeshare(serialized_as = "Uint8Array<ArrayBufferLike>")]
    pub changed_slots: WireBytes<'a>,
    /// Final output value as an `f32`: of every slot for a keyframe, or of each changed slot for a
    /// delta. NaN marks a slot whose parameter entity is missing.
    #[typeshare(serialized_as = "Uint8Array<ArrayBufferLike>")]
    pub output: WireBytes<'a>,
    /// Whether the assertion fields below are present. Always true for a keyframe; false on a
    /// delta means the assertions are unchanged since the previous frame.
    pub assertions_included: bool,
    /// Number of leading assertions that are absolute; the remaining assertions are relative.
    pub absolute_count: u32,
    /// Layout slot of each assertion as a `u32`.
    #[typeshare(serialized_as = "Uint8Array<ArrayBufferLike>")]
    pub assertion_slots: WireBytes<'a>,
    /// Kind code of each assertion as a `u8`, indexing [`ParameterLayout::assertion_variants`].
    #[typeshare(serialized_as = "Uint8Array<ArrayBufferLike>")]
    pub assertion_kinds: WireBytes<'a>,
    /// Value or offset of each assertion as an `f32`, the precision the engine stores it in.
    #[typeshare(serialized_as = "Uint8Array<ArrayBufferLike>")]
    pub assertion_values: WireBytes<'a>,
}

/// Serializes a byte slice as one binary string instead of an array of integers.
#[derive(Debug, Clone, Copy)]
pub struct WireBytes<'a>(pub &'a [u8]);

impl Serialize for WireBytes<'_> {
    /// Writes the bytes through `serialize_bytes`, which CBOR encodes as a single byte string.
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_bytes(self.0)
    }
}

/// Source of layout ids, shared by every world in the process.
///
/// A host can replace its world behind connected clients. Ids that are unique across worlds keep a
/// client from resolving one world's values frame against another world's layout.
static NEXT_LAYOUT_ID: AtomicU32 = AtomicU32::new(1);

/// Returns a layout id no earlier layout in this process has used. Zero is never returned.
fn next_layout_id() -> u32 {
    loop {
        let id = NEXT_LAYOUT_ID.fetch_add(1, Ordering::Relaxed);
        if id != 0 {
            return id;
        }
    }
}

/// Returns the kind code and numeric payload that encode one asserted parameter value.
pub fn assertion_kind(value: &ParameterValue) -> (u8, f32) {
    match value {
        ParameterValue::Absolute { value } => (0, *value),
        ParameterValue::AbsolutePercent { value } => (1, value.as_f32()),
        ParameterValue::Relative { offset } => (2, *offset),
        ParameterValue::RelativePercent { offset } => (3, offset.as_f32()),
    }
}

/// Packed assertion list of one frame.
#[derive(Default, PartialEq)]
struct AssertionBuffers {
    absolute_count: u32,
    slots: Vec<u8>,
    kinds: Vec<u8>,
    values: Vec<u8>,
}

impl AssertionBuffers {
    /// Empties the buffers, keeping their capacity for the next frame.
    fn clear(&mut self) {
        self.absolute_count = 0;
        self.slots.clear();
        self.kinds.clear();
        self.values.clear();
    }
}

/// Cached slot layout and reusable frame buffers for the parameter state client projection.
#[derive(Resource, Default)]
pub struct ParameterStateProjection {
    layout: ParameterLayout,
    slots: Vec<Instance<Parameter>>,
    slot_by_parameter: ParameterMap<u32>,
    index_revision: Option<u64>,
    layout_pending: bool,
    /// Output of every slot as of the last fill, which is also what clients hold once they apply
    /// the next published frame.
    output: Vec<u8>,
    /// Slots whose output bits changed in the last fill, as `u32`s.
    changed_slots: Vec<u8>,
    /// New output of each slot in `changed_slots`, as `f32`s.
    changed_values: Vec<u8>,
    assertions: AssertionBuffers,
    previous_assertions: AssertionBuffers,
    seq: u32,
    keyframe_pending: bool,
    last_keyframe: Option<Instant>,
    deltas_enabled: bool,
}

impl ParameterStateProjection {
    /// Marks the current layout for publication on the next frame, for clients that just resynced.
    /// The frame after it is a keyframe, so those clients get complete values straight away.
    pub fn request_layout(&mut self) {
        self.layout_pending = true;
        self.keyframe_pending = true;
    }

    /// Makes the next published frame a keyframe, for a client that missed part of the stream.
    pub fn request_keyframe(&mut self) {
        self.keyframe_pending = true;
    }

    /// Chooses between sending only changed slots between keyframes and sending a keyframe every
    /// frame.
    pub fn set_deltas_enabled(&mut self, enabled: bool) {
        self.deltas_enabled = enabled;
    }

    /// Rebuilds the slot layout when the patch may have changed since it was last built.
    ///
    /// `patch_changed` covers fixture definition edits seen by Bevy change detection; the
    /// parameter index revision covers parameters added or removed through its lock. An unchanged
    /// rebuild keeps the existing layout id so clients keep their layout.
    pub fn refresh_layout(
        &mut self,
        fixture_data_provider: &FixtureDataProviderExt,
        index: &ParameterIndex,
        patch_changed: bool,
    ) {
        if !patch_changed && self.index_revision == Some(index.revision()) {
            return;
        }
        self.index_revision = Some(index.revision());

        let mut fixtures = Vec::with_capacity(self.layout.fixtures.len());
        let mut slots = Vec::with_capacity(self.slots.len());
        for fixture in fixture_data_provider.inner.iter() {
            let fixture_uid = fixture.identifiers.uid;
            let mut elements = Vec::with_capacity(fixture.elements.len());
            for (index_in_fixture, element) in fixture.elements.iter().enumerate() {
                let fixture_ref = FixtureRef {
                    fixture_uid,
                    index: Some(index_in_fixture as u32 + 1),
                };
                let mut attributes = Vec::with_capacity(element.parameters.len());
                for metadata in &element.parameters {
                    let Some(parameter) = index.parameter(&fixture_ref, &metadata.attribute) else {
                        continue;
                    };
                    attributes.push(metadata.attribute.key());
                    slots.push(parameter);
                }
                elements.push(attributes);
            }
            fixtures.push(ParameterLayoutFixture {
                fixture_uid,
                elements,
            });
        }

        if self.layout.layout_id != 0 && fixtures == self.layout.fixtures && slots == self.slots {
            return;
        }

        let mut slot_by_parameter = ParameterMap::with_capacity(slots.len());
        for (slot, parameter) in slots.iter().enumerate() {
            slot_by_parameter.insert(*parameter, slot as u32);
        }
        self.layout = ParameterLayout {
            layout_id: next_layout_id(),
            fixtures,
            assertion_variants: &PARAMETER_ASSERTION_VARIANTS,
        };
        self.slots = slots;
        self.slot_by_parameter = slot_by_parameter;
        self.layout_pending = true;
        // Slots now mean different parameters, so clients need complete values for the new layout.
        self.output.clear();
        self.keyframe_pending = true;
    }

    /// Returns the layout when it still has to be published, clearing the pending flag.
    pub fn take_pending_layout(&mut self) -> Option<&ParameterLayout> {
        std::mem::take(&mut self.layout_pending).then_some(&self.layout)
    }

    /// Fills the frame buffers from current parameter outputs and the final assertion layer.
    ///
    /// Each slot's output is compared by its bits with the previous fill while it is written, so
    /// the changed slots for a delta come out of the same pass with no tolerance: any change,
    /// including between NaN payloads or signed zeros, is sent.
    pub fn fill_values(
        &mut self,
        parameters: &Query<&Parameter>,
        assertions: &AttributedAssertionsLayer,
    ) {
        let output_len = self.slots.len() * size_of::<f32>();
        if self.output.len() != output_len {
            self.output.clear();
            self.output.resize(output_len, 0);
            self.keyframe_pending = true;
        }
        self.changed_slots.clear();
        self.changed_values.clear();
        for (slot, parameter_instance) in self.slots.iter().enumerate() {
            let value = match parameters.get(parameter_instance.entity()) {
                Ok(parameter) => parameter.get_logical_value(),
                Err(_) => {
                    tracing::warn!(
                        parameter = %parameter_instance,
                        "Fixture parameter index referenced a missing entity"
                    );
                    f32::NAN
                }
            };
            let bytes = value.to_le_bytes();
            let start = slot * size_of::<f32>();
            let current = &mut self.output[start..start + size_of::<f32>()];
            if *current != bytes {
                current.copy_from_slice(&bytes);
                self.changed_slots
                    .extend_from_slice(&(slot as u32).to_le_bytes());
                self.changed_values.extend_from_slice(&bytes);
            }
        }

        std::mem::swap(&mut self.assertions, &mut self.previous_assertions);
        self.assertions.clear();
        for (map, is_absolute) in [(&assertions.absolute, true), (&assertions.relative, false)] {
            for (parameter, (_, (value, _))) in map.iter() {
                let Some(&slot) = self.slot_by_parameter.get(parameter) else {
                    continue;
                };
                let output_start = slot as usize * size_of::<f32>();
                let output = &self.output[output_start..output_start + size_of::<f32>()];
                if f32::from_le_bytes(output.try_into().unwrap()).is_nan() {
                    // A parameter without a live entity is left out of the frame entirely.
                    continue;
                }
                let (kind, number) = assertion_kind(value);
                self.assertions.slots.extend_from_slice(&slot.to_le_bytes());
                self.assertions.kinds.push(kind);
                self.assertions
                    .values
                    .extend_from_slice(&number.to_le_bytes());
                if is_absolute {
                    self.assertions.absolute_count += 1;
                }
            }
        }
    }

    /// Numbers and returns the next frame of the stream from the last [`Self::fill_values`] call,
    /// or `None` when it would be a delta with nothing in it.
    ///
    /// The frame is a keyframe when deltas are disabled, when one was requested or the layout
    /// changed, when [`KEYFRAME_INTERVAL`] has passed since the last one, or when a non-empty delta
    /// would be no smaller than a keyframe.
    pub fn publish_frame(&mut self, now: Instant) -> Option<ParameterStateFrame<'_>> {
        let delta_bytes = self.changed_slots.len() + self.changed_values.len();
        let assertions_changed = self.assertions != self.previous_assertions;
        let keyframe = !self.deltas_enabled
            || self.keyframe_pending
            || self
                .last_keyframe
                .is_none_or(|at| now.duration_since(at) >= KEYFRAME_INTERVAL)
            || (delta_bytes > 0 && delta_bytes >= self.output.len());
        if !keyframe && delta_bytes == 0 && !assertions_changed {
            return None;
        }

        self.seq = self.seq.wrapping_add(1);
        if keyframe {
            self.keyframe_pending = false;
            self.last_keyframe = Some(now);
        }
        let assertions_included = keyframe || assertions_changed;
        // Listing the changes costs a keyframe 4 bytes per changed slot, so only keyframes that
        // stand in for a small delta carry them; while deltas are off nobody could verify anyway.
        let verifiable = keyframe && self.deltas_enabled && delta_bytes < self.output.len();
        let included = |bytes| WireBytes(if assertions_included { bytes } else { &[] });
        Some(ParameterStateFrame {
            layout_id: self.layout.layout_id,
            seq: self.seq,
            keyframe,
            verifiable,
            changed_slots: WireBytes(if keyframe && !verifiable {
                &[]
            } else {
                &self.changed_slots
            }),
            output: WireBytes(if keyframe {
                &self.output
            } else {
                &self.changed_values
            }),
            assertions_included,
            absolute_count: if assertions_included {
                self.assertions.absolute_count
            } else {
                0
            },
            assertion_slots: included(&self.assertions.slots),
            assertion_kinds: included(&self.assertions.kinds),
            assertion_values: included(&self.assertions.values),
        })
    }

    /// Returns the number of slots in the current layout.
    pub fn slot_count(&self) -> usize {
        self.slots.len()
    }
}

#[cfg(test)]
mod tests {
    use async_channel::Receiver;
    use bevy_app::{App, Update};
    use bevy_diagnostic::DiagnosticsPlugin;
    use nightfall::prelude::{ObjectRef, ObjectType};
    use nightfall_compositor::prelude::FinalLayerAttributedAssertions;
    use nightfall_dmx::prelude::{Attribute, DmxValueResolution, Percentage};
    use nightfall_engine::prelude::{ClientEventSink, DISCRIMINATOR_NON_DROPPABLE, OutboundFrame};
    use nightfall_io::OutputTransport;

    use super::*;
    use crate::testing::{
        BENCH_FIXTURE_PARAMETERS, BenchParameter, patch_bench_fixtures,
        patch_bench_fixtures_with_profile,
    };
    use crate::websocket::{register_fixture_websocket_diagnostics, send_parameter_state};

    /// Builds an app publishing parameter state for `fixture_count` patched bench fixtures.
    fn projection_app(fixture_count: usize) -> (App, Vec<BenchParameter>, Receiver<OutboundFrame>) {
        let mut app = App::new();
        app.add_plugins(DiagnosticsPlugin);
        register_fixture_websocket_diagnostics(&mut app);
        app.init_resource::<FinalLayerAttributedAssertions>();
        app.init_resource::<ParameterStateProjection>();
        let (sender, receiver) = async_channel::unbounded();
        app.insert_resource(ClientEventSink::new(sender));
        app.add_systems(Update, send_parameter_state);
        let parameters = patch_bench_fixtures(
            app.world_mut(),
            fixture_count,
            &OutputTransport::Udmx {
                device: "test".to_owned(),
            },
        );
        (app, parameters, receiver)
    }

    /// Returns how many layout messages were published since the last drain.
    fn drain_layout_count(receiver: &Receiver<OutboundFrame>) -> usize {
        std::iter::from_fn(|| receiver.try_recv().ok())
            .filter(|frame| frame.bytes[0] == DISCRIMINATOR_NON_DROPPABLE)
            .count()
    }

    /// Returns the slot of `parameter` by walking the published layout.
    fn slot_of(layout: &ParameterLayout, parameter: &BenchParameter) -> usize {
        let mut slot = 0;
        for fixture in &layout.fixtures {
            for (element_index, attributes) in fixture.elements.iter().enumerate() {
                for key in attributes {
                    if fixture.fixture_uid == parameter.fixture_ref.fixture_uid
                        && Some(element_index as u32 + 1) == parameter.fixture_ref.index
                        && *key == parameter.attribute.key()
                    {
                        return slot;
                    }
                    slot += 1;
                }
            }
        }
        panic!(
            "parameter {:?} is missing from the layout",
            parameter.attribute
        );
    }

    /// Asserts `value` on `parameter` in the final assertion layer as absolute or relative.
    fn assert_value(app: &mut App, parameter: &BenchParameter, value: ParameterValue) {
        let mut assertions = app
            .world_mut()
            .resource_mut::<FinalLayerAttributedAssertions>();
        let owner = ObjectRef::ById {
            object_type: ObjectType::Cue,
            id: 1,
        };
        let map = if value.is_relative() {
            &mut assertions.0.relative
        } else {
            &mut assertions.0.absolute
        };
        map.insert(parameter.instance, (owner, (value, None)));
    }

    /// Absolute count and packed slots, kinds and values of one frame's assertions.
    type OwnedAssertions = (u32, Vec<u8>, Vec<u8>, Vec<u8>);

    /// Owned copy of one published frame, decoded into numbers so tests can keep it after the
    /// projection reuses its buffers.
    #[derive(Debug)]
    struct OwnedFrame {
        layout_id: u32,
        seq: u32,
        keyframe: bool,
        verifiable: bool,
        changed_slots: Vec<u32>,
        /// Output values as raw `f32` bits, so NaN slots compare equal.
        output: Vec<u32>,
        /// Absolute count and packed slots, kinds and values, when the frame carries assertions.
        assertions: Option<OwnedAssertions>,
    }

    impl OwnedFrame {
        /// Copies a borrowed frame into owned, decoded buffers.
        fn new(frame: &ParameterStateFrame<'_>) -> Self {
            let words = |bytes: &[u8]| -> Vec<u32> {
                bytes
                    .as_chunks::<4>()
                    .0
                    .iter()
                    .map(|chunk| u32::from_le_bytes(*chunk))
                    .collect()
            };
            Self {
                layout_id: frame.layout_id,
                seq: frame.seq,
                keyframe: frame.keyframe,
                verifiable: frame.verifiable,
                changed_slots: words(frame.changed_slots.0),
                output: words(frame.output.0),
                assertions: frame.assertions_included.then(|| {
                    (
                        frame.absolute_count,
                        frame.assertion_slots.0.to_vec(),
                        frame.assertion_kinds.0.to_vec(),
                        frame.assertion_values.0.to_vec(),
                    )
                }),
            }
        }
    }

    /// Refreshes, fills and publishes one frame of the projection as `send_parameter_state` does,
    /// but with a caller-chosen clock so tests control the keyframe interval.
    fn step(app: &mut App, now: Instant) -> Option<OwnedFrame> {
        app.world_mut()
            .resource_scope(|world, mut projection: Mut<ParameterStateProjection>| {
                let mut state = bevy_ecs::system::SystemState::<(
                    Res<FixtureDataProviderExt>,
                    Query<&Parameter>,
                    Res<FinalLayerAttributedAssertions>,
                )>::new(world);
                let (provider, parameters, assertions) = state
                    .get(world)
                    .expect("projection test resources should exist");
                projection.refresh_layout(&provider, &provider.parameter_index(), false);
                projection.fill_values(&parameters, &assertions.0);
                projection
                    .publish_frame(now)
                    .map(|frame| OwnedFrame::new(&frame))
            })
    }

    /// Sets the stored value of `parameter`, which its logical output then reflects.
    fn set_output(app: &mut App, parameter: &BenchParameter, value: f32) {
        app.world_mut()
            .get_mut::<Parameter>(parameter.instance.entity())
            .unwrap()
            .set_raw_value(value);
    }

    /// Client-side model of the stream: applies frames in order and refuses deltas after a gap.
    #[derive(Default)]
    struct StreamClient {
        layout_id: u32,
        last_seq: Option<u32>,
        output: Vec<u32>,
        assertions: Option<OwnedAssertions>,
        /// Whether the client lost a frame and is waiting for a keyframe.
        broken: bool,
        /// Keyframes the client checked against its rebuilt state.
        verified_keyframes: usize,
    }

    impl StreamClient {
        /// Applies `frame`, returning whether it was applied rather than discarded for a gap.
        fn apply(&mut self, frame: &OwnedFrame) -> bool {
            if frame.keyframe {
                let follows = self.last_seq.map(|seq| seq.wrapping_add(1)) == Some(frame.seq);
                if frame.verifiable && follows && !self.broken && frame.layout_id == self.layout_id
                {
                    for slot in &frame.changed_slots {
                        self.output[*slot as usize] = frame.output[*slot as usize];
                    }
                    assert_eq!(
                        self.output, frame.output,
                        "a verifiable keyframe matches the previous frame plus its listed changes"
                    );
                    self.verified_keyframes += 1;
                }
                self.layout_id = frame.layout_id;
                self.output = frame.output.clone();
                self.broken = false;
            } else {
                let follows = self.last_seq.map(|seq| seq.wrapping_add(1)) == Some(frame.seq);
                if self.broken || !follows || frame.layout_id != self.layout_id {
                    self.broken = true;
                    self.last_seq = Some(frame.seq);
                    return false;
                }
                for (slot, value) in frame.changed_slots.iter().zip(&frame.output) {
                    self.output[*slot as usize] = *value;
                }
            }
            if frame.assertions.is_some() {
                self.assertions = frame.assertions.clone();
            }
            self.last_seq = Some(frame.seq);
            true
        }
    }

    /// Returns the projection's current output as raw `f32` bits.
    fn projection_output(app: &App) -> Vec<u32> {
        app.world()
            .resource::<ParameterStateProjection>()
            .output
            .as_chunks::<4>()
            .0
            .iter()
            .map(|chunk| u32::from_le_bytes(*chunk))
            .collect()
    }

    /// Returns the projection's current assertions in the shape [`OwnedFrame`] carries them.
    fn projection_assertions(app: &App) -> OwnedAssertions {
        let assertions = &app
            .world()
            .resource::<ParameterStateProjection>()
            .assertions;
        (
            assertions.absolute_count,
            assertions.slots.clone(),
            assertions.kinds.clone(),
            assertions.values.clone(),
        )
    }

    /// Builds a delta-enabled projection over `fixture_count` bench fixtures and publishes its
    /// opening keyframe at `start`.
    fn delta_app(fixture_count: usize, start: Instant) -> (App, Vec<BenchParameter>, OwnedFrame) {
        let (mut app, parameters, _receiver) = projection_app(fixture_count);
        app.world_mut()
            .resource_mut::<ParameterStateProjection>()
            .set_deltas_enabled(true);
        let first = step(&mut app, start).expect("the first frame should be published");
        assert!(first.keyframe, "the stream opens with a keyframe");
        (app, parameters, first)
    }

    /// Verifies every frame is a numbered keyframe while deltas are disabled, even when nothing
    /// changed.
    #[test]
    fn disabled_deltas_send_a_keyframe_every_frame() {
        let (mut app, _, _receiver) = projection_app(2);
        let now = Instant::now();
        let frames: Vec<OwnedFrame> = (0..3)
            .map(|_| step(&mut app, now).expect("every frame should be published"))
            .collect();
        for (index, frame) in frames.iter().enumerate() {
            assert!(frame.keyframe);
            assert_eq!(frame.seq, index as u32 + 1);
            assert!(!frame.verifiable && frame.changed_slots.is_empty());
            assert_eq!(frame.output, projection_output(&app));
            assert!(frame.assertions.is_some());
        }
    }

    /// Verifies a delta carries exactly the slots whose output changed, with their new values,
    /// and leaves unchanged assertions out.
    #[test]
    fn delta_carries_only_changed_slots() {
        let start = Instant::now();
        let (mut app, parameters, first) = delta_app(2, start);
        let layout = app
            .world()
            .resource::<ParameterStateProjection>()
            .layout
            .clone();
        set_output(&mut app, &parameters[3], 42.0);
        set_output(&mut app, &parameters[12], 7.0);

        let delta = step(&mut app, start).expect("changed outputs should publish a delta");
        assert!(!delta.keyframe);
        assert_eq!(delta.seq, first.seq + 1);
        let mut expected = vec![
            (slot_of(&layout, &parameters[3]) as u32, 42.0_f32.to_bits()),
            (slot_of(&layout, &parameters[12]) as u32, 7.0_f32.to_bits()),
        ];
        expected.sort();
        let actual: Vec<(u32, u32)> = delta
            .changed_slots
            .iter()
            .copied()
            .zip(delta.output.iter().copied())
            .collect();
        assert_eq!(actual, expected);
        assert!(delta.assertions.is_none());
    }

    /// Verifies a frame with no output or assertion change is skipped without using a sequence
    /// number, and an assertion-only change publishes an empty delta that carries assertions.
    #[test]
    fn unchanged_frames_are_skipped() {
        let start = Instant::now();
        let (mut app, parameters, first) = delta_app(1, start);
        assert!(step(&mut app, start).is_none());
        assert!(step(&mut app, start).is_none());

        assert_value(
            &mut app,
            &parameters[1],
            ParameterValue::Absolute { value: 10.0 },
        );
        let frame = step(&mut app, start).expect("an assertion change should publish");
        assert!(!frame.keyframe);
        assert_eq!(frame.seq, first.seq + 1);
        assert!(frame.changed_slots.is_empty());
        assert_eq!(frame.assertions, Some(projection_assertions(&app)));
    }

    /// Verifies keyframes recur after the interval, on request, on a new layout, and when a delta
    /// would be as large as a keyframe.
    #[test]
    fn keyframes_recur_on_every_trigger() {
        let start = Instant::now();
        let (mut app, parameters, _) = delta_app(1, start);

        let late = start + KEYFRAME_INTERVAL;
        let interval = step(&mut app, late).expect("the interval should publish a keyframe");
        assert!(interval.keyframe, "a keyframe recurs after the interval");
        assert!(step(&mut app, late).is_none());

        app.world_mut()
            .resource_mut::<ParameterStateProjection>()
            .request_keyframe();
        let requested = step(&mut app, late).expect("a request should publish a keyframe");
        assert!(requested.keyframe);

        for (index, parameter) in parameters.iter().enumerate() {
            set_output(&mut app, parameter, index as f32 + 1.0);
        }
        let everything = step(&mut app, late).expect("changing every slot should publish");
        assert!(
            everything.keyframe,
            "a delta of every slot is larger than a keyframe"
        );

        let first_layout = everything.layout_id;
        patch_bench_fixtures(
            app.world_mut(),
            2,
            &OutputTransport::Udmx {
                device: "test".to_owned(),
            },
        );
        let repatched = app.world_mut().resource_scope(
            |world, mut projection: Mut<ParameterStateProjection>| {
                let provider = world.resource::<FixtureDataProviderExt>();
                projection.refresh_layout(provider, &provider.parameter_index(), true);
                projection.layout.layout_id
            },
        );
        assert_ne!(repatched, first_layout);
        let relaid = step(&mut app, late).expect("a new layout should publish a keyframe");
        assert!(relaid.keyframe);
        assert_eq!(relaid.layout_id, repatched);
    }

    /// Verifies a client applying a long random stream stays identical to the engine, and that a
    /// client which drops a delta refuses later deltas until a keyframe repairs it.
    #[test]
    fn applied_stream_reconstructs_engine_state() {
        let start = Instant::now();
        let (mut app, parameters, first) = delta_app(4, start);
        let mut client = StreamClient::default();
        let mut lossy = StreamClient::default();
        assert!(client.apply(&first));
        assert!(lossy.apply(&first));

        // Deterministic xorshift so failures reproduce without a random-number dependency.
        let mut rng = 0x2545_f491_u32;
        let mut next = move || {
            rng ^= rng << 13;
            rng ^= rng >> 17;
            rng ^= rng << 5;
            rng
        };
        let mut now = start;
        let mut lossy_refused = false;
        let mut dropped = false;
        for frame_index in 0..400 {
            now += std::time::Duration::from_millis(20);
            for _ in 0..(next() % 4) {
                let parameter = &parameters[next() as usize % parameters.len()];
                set_output(&mut app, parameter, (next() % 256) as f32);
            }
            if next() % 10 == 0 {
                let parameter = &parameters[next() as usize % parameters.len()];
                assert_value(
                    &mut app,
                    parameter,
                    ParameterValue::Absolute {
                        value: (next() % 256) as f32,
                    },
                );
            }
            let Some(frame) = step(&mut app, now) else {
                continue;
            };
            assert!(
                client.apply(&frame),
                "an unbroken client applies every frame"
            );
            assert_eq!(client.output, projection_output(&app));
            assert_eq!(client.assertions, Some(projection_assertions(&app)));

            if frame_index >= 50 && !dropped && !frame.keyframe {
                // The lossy client misses this delta.
                dropped = true;
                continue;
            }
            let applied = lossy.apply(&frame);
            lossy_refused |= !applied;
            if applied {
                assert_eq!(lossy.output, projection_output(&app));
            }
        }
        assert!(
            lossy_refused,
            "the lossy client should refuse a delta after its gap"
        );
        assert!(
            client.verified_keyframes > 0,
            "interval keyframes should be verifiable against the rebuilt state"
        );
        assert!(
            !lossy.broken,
            "a later keyframe should repair the lossy client"
        );
    }

    /// Verifies output and assertion buffers are indexed by the slots the layout names.
    #[test]
    fn values_are_indexed_by_layout_slots() {
        let (mut app, parameters, _receiver) = projection_app(3);
        let absolute = &parameters[4];
        let relative = &parameters[17];
        assert_value(
            &mut app,
            absolute,
            ParameterValue::Absolute { value: 200.0 },
        );
        assert_value(
            &mut app,
            relative,
            ParameterValue::RelativePercent {
                offset: Percentage::from(-0.25_f32),
            },
        );
        app.update();

        let projection = app.world().resource::<ParameterStateProjection>();
        let layout = &projection.layout;
        assert_eq!(layout.fixtures.len(), 3);
        for fixture in &layout.fixtures {
            let keys: Vec<String> = BENCH_FIXTURE_PARAMETERS
                .iter()
                .map(|(attribute, _)| attribute.key())
                .collect();
            assert_eq!(fixture.elements, vec![keys]);
        }

        let outputs: Vec<f32> = projection
            .output
            .as_chunks::<4>()
            .0
            .iter()
            .map(|bytes| f32::from_le_bytes(*bytes))
            .collect();
        assert_eq!(outputs.len(), parameters.len());
        for parameter in &parameters {
            let expected = app
                .world()
                .get::<Parameter>(parameter.instance.entity())
                .unwrap()
                .get_logical_value();
            assert_eq!(outputs[slot_of(layout, parameter)], expected);
        }

        assert_eq!(projection.assertions.absolute_count, 1);
        let slots: Vec<u32> = projection
            .assertions
            .slots
            .as_chunks::<4>()
            .0
            .iter()
            .map(|bytes| u32::from_le_bytes(*bytes))
            .collect();
        let numbers: Vec<f32> = projection
            .assertions
            .values
            .as_chunks::<4>()
            .0
            .iter()
            .map(|bytes| f32::from_le_bytes(*bytes))
            .collect();
        assert_eq!(
            slots,
            vec![
                slot_of(layout, absolute) as u32,
                slot_of(layout, relative) as u32
            ]
        );
        assert_eq!(projection.assertions.kinds, [0, 3]);
        assert_eq!(numbers, vec![200.0, -0.25]);
    }

    /// Verifies a parameter whose entity is gone is marked NaN and its assertions are left out.
    #[test]
    fn missing_parameter_entity_is_left_out() {
        let (mut app, parameters, _receiver) = projection_app(1);
        let missing = &parameters[2];
        assert_value(&mut app, missing, ParameterValue::Absolute { value: 9.0 });
        app.world_mut().despawn(missing.instance.entity());
        app.update();

        let projection = app.world().resource::<ParameterStateProjection>();
        let slot = slot_of(&projection.layout, missing) * 4;
        let output = &projection.output[slot..slot + 4];
        assert!(f32::from_le_bytes(output.try_into().unwrap()).is_nan());
        assert_eq!(projection.assertions.absolute_count, 0);
        assert!(projection.assertions.slots.is_empty());
    }

    /// Verifies custom attributes keep distinct slots keyed by their labels.
    #[test]
    fn layout_keys_custom_attributes_by_label() {
        let mut app = App::new();
        app.init_resource::<ParameterStateProjection>();
        let profile = [
            (
                Attribute::Custom {
                    label: "Tilt Speed".to_owned(),
                },
                DmxValueResolution::Coarse,
            ),
            (
                Attribute::Custom {
                    label: "Aux Strips Light Speed".to_owned(),
                },
                DmxValueResolution::Coarse,
            ),
        ];
        patch_bench_fixtures_with_profile(
            app.world_mut(),
            1,
            &OutputTransport::Udmx {
                device: "test".to_owned(),
            },
            &profile,
        );
        let world = app.world_mut();
        world.resource_scope(|world, mut projection: Mut<ParameterStateProjection>| {
            let provider = world.resource::<FixtureDataProviderExt>();
            projection.refresh_layout(provider, &provider.parameter_index(), true);
        });

        let projection = app.world().resource::<ParameterStateProjection>();
        assert_eq!(
            projection.layout.fixtures[0].elements,
            vec![vec![
                "Tilt Speed".to_owned(),
                "Aux Strips Light Speed".to_owned()
            ]]
        );
    }

    /// Verifies the layout is published once, again on request, and with a new id after repatching.
    #[test]
    fn layout_is_published_only_when_needed() {
        let (mut app, _, receiver) = projection_app(2);
        app.update();
        assert_eq!(drain_layout_count(&receiver), 1);
        let first_id = app
            .world()
            .resource::<ParameterStateProjection>()
            .layout
            .layout_id;

        app.update();
        app.world_mut()
            .resource_mut::<FixtureDataProviderExt>()
            .set_changed();
        app.update();
        assert_eq!(
            drain_layout_count(&receiver),
            0,
            "unchanged frames and patch writes that change no slot keep the layout"
        );

        app.world_mut()
            .resource_mut::<ParameterStateProjection>()
            .request_layout();
        app.update();
        assert_eq!(drain_layout_count(&receiver), 1);
        assert_eq!(
            app.world()
                .resource::<ParameterStateProjection>()
                .layout
                .layout_id,
            first_id
        );

        patch_bench_fixtures(
            app.world_mut(),
            3,
            &OutputTransport::Udmx {
                device: "test".to_owned(),
            },
        );
        app.update();
        assert_eq!(drain_layout_count(&receiver), 1);
        let projection = app.world().resource::<ParameterStateProjection>();
        assert_ne!(projection.layout.layout_id, first_id);
        assert_eq!(
            projection.slot_count(),
            projection
                .layout
                .fixtures
                .iter()
                .flat_map(|fixture| &fixture.elements)
                .map(Vec::len)
                .sum::<usize>()
        );
    }

    /// Verifies every assertion kind code names the variant tag `ParameterValue` serializes with.
    #[test]
    fn assertion_kind_codes_match_serialized_variant_tags() {
        let values = [
            ParameterValue::Absolute { value: 1.0 },
            ParameterValue::AbsolutePercent {
                value: Percentage::from(0.5_f32),
            },
            ParameterValue::Relative { offset: 2.0 },
            ParameterValue::RelativePercent {
                offset: Percentage::from(0.25_f32),
            },
        ];
        for value in values {
            let (kind, _) = assertion_kind(&value);
            let serialized = serde_json::to_value(value).expect("value should serialize");
            assert_eq!(
                serialized["type"],
                PARAMETER_ASSERTION_VARIANTS[kind as usize]
            );
        }
    }
}
