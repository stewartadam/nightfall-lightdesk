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

use std::sync::atomic::{AtomicU32, Ordering};

use bevy_ecs::prelude::*;
use moonshine_kind::Instance;
use nightfall::prelude::FixtureRef;
use nightfall_compositor::prelude::{AttributedAssertionsLayer, ParameterMap};
use nightfall_dmx::prelude::ParameterValue;
use serde::{Serialize, Serializer};
use uuid::Uuid;

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

/// Output and asserted values of every slot in the current [`ParameterLayout`].
///
/// Buffers are little-endian packed numbers rather than CBOR arrays so clients can view them as
/// typed arrays without decoding each value.
#[typeshare::typeshare]
#[derive(Debug, Serialize)]
pub struct ParameterStateFrame<'a> {
    /// Layout these values are indexed by.
    pub layout_id: u32,
    /// Final output value of each layout slot as an `f32`. NaN marks a slot whose parameter entity
    /// is missing this frame.
    #[typeshare(serialized_as = "Uint8Array<ArrayBufferLike>")]
    pub output: WireBytes<'a>,
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

/// Cached slot layout and reusable frame buffers for the parameter state client projection.
#[derive(Resource, Default)]
pub struct ParameterStateProjection {
    layout: ParameterLayout,
    slots: Vec<Instance<Parameter>>,
    slot_by_parameter: ParameterMap<u32>,
    index_revision: Option<u64>,
    layout_pending: bool,
    output: Vec<u8>,
    absolute_count: u32,
    assertion_slots: Vec<u8>,
    assertion_kinds: Vec<u8>,
    assertion_values: Vec<u8>,
}

impl ParameterStateProjection {
    /// Marks the current layout for publication on the next frame, for clients that just resynced.
    pub fn request_layout(&mut self) {
        self.layout_pending = true;
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
    }

    /// Returns the layout when it still has to be published, clearing the pending flag.
    pub fn take_pending_layout(&mut self) -> Option<&ParameterLayout> {
        std::mem::take(&mut self.layout_pending).then_some(&self.layout)
    }

    /// Fills the frame buffers from current parameter outputs and the final assertion layer.
    pub fn fill_values(
        &mut self,
        parameters: &Query<&Parameter>,
        assertions: &AttributedAssertionsLayer,
    ) {
        self.output.clear();
        self.output.reserve(self.slots.len() * size_of::<f32>());
        for parameter_instance in &self.slots {
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
            self.output.extend_from_slice(&value.to_le_bytes());
        }

        self.assertion_slots.clear();
        self.assertion_kinds.clear();
        self.assertion_values.clear();
        self.absolute_count = 0;
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
                self.assertion_slots.extend_from_slice(&slot.to_le_bytes());
                self.assertion_kinds.push(kind);
                self.assertion_values
                    .extend_from_slice(&number.to_le_bytes());
                if is_absolute {
                    self.absolute_count += 1;
                }
            }
        }
    }

    /// Returns the values filled by the last [`Self::fill_values`] call.
    pub fn values(&self) -> ParameterStateFrame<'_> {
        ParameterStateFrame {
            layout_id: self.layout.layout_id,
            output: WireBytes(&self.output),
            absolute_count: self.absolute_count,
            assertion_slots: WireBytes(&self.assertion_slots),
            assertion_kinds: WireBytes(&self.assertion_kinds),
            assertion_values: WireBytes(&self.assertion_values),
        }
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

        let values = projection.values();
        assert_eq!(values.layout_id, layout.layout_id);
        let outputs: Vec<f32> = values
            .output
            .0
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

        assert_eq!(values.absolute_count, 1);
        let slots: Vec<u32> = values
            .assertion_slots
            .0
            .as_chunks::<4>()
            .0
            .iter()
            .map(|bytes| u32::from_le_bytes(*bytes))
            .collect();
        let numbers: Vec<f32> = values
            .assertion_values
            .0
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
        assert_eq!(values.assertion_kinds.0, &[0, 3]);
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
        let output = &projection.values().output.0[slot..slot + 4];
        assert!(f32::from_le_bytes(output.try_into().unwrap()).is_nan());
        assert_eq!(projection.values().absolute_count, 0);
        assert!(projection.values().assertion_slots.0.is_empty());
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
