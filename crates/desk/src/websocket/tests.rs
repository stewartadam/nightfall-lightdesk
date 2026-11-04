// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::time::Duration;

use bevy_app::{App, Update};
use moonshine_kind::Instance;
use nightfall_fixture_model::prelude::*;
use nightfall_fixtures::prelude::{Parameter, ParameterValues};

use super::*;

/// Spawns a parameter with the requested attribute and merge strategy for layer tests.
fn spawn_parameter(
    app: &mut App,
    attribute: Attribute,
    merge_type: MergeStrategy,
) -> Instance<Parameter> {
    let entity = app
        .world_mut()
        .spawn(Parameter {
            metadata: ParameterMetadata {
                dmx_slots: Default::default(),
                functions: Vec::new(),
                default_dmx: None,
                highlight_dmx: None,
                resolution: DmxValueResolution::Coarse,
                native_unit: attribute.native_unit(),
                value_polarity: attribute.value_polarity(),
                attribute,
                min: 0.0,
                max: 255.0,
                offset: ParameterValue::Absolute { value: 0.0 },
                is_inverted: false,
                is_snap: false,
                merge_type,
                use_grandmaster: false,
            },
            values: ParameterValues::default(),
        })
        .id();

    unsafe { Instance::from_entity_unchecked(entity) }
}

#[test]
/// Verifies a parameter reports an active transition during its fade-in window.
fn is_transition_active_reports_active_during_fade_in() {
    let mut app = App::new();
    let parameter = spawn_parameter(&mut app, Attribute::Red, MergeStrategy::LTP);
    let mut query = app.world_mut().query::<&Parameter>();
    let parameters_query = query.query(app.world());

    let active = is_transition_active(
        &parameters_query,
        parameter.into(),
        &ParameterValue::Absolute { value: 255.0 },
        &MaterializedTransition {
            delay_in: Duration::ZERO,
            fade_in: Duration::from_secs(1),
            curve_in: FadeCurve::Linear,
            delay_out: Duration::ZERO,
            fade_out: Duration::ZERO,
            curve_out: FadeCurve::Linear,
            start_position: Duration::ZERO,
            release_position: None,
        },
        51.0,
        Some(&nightfall_compositor::types::LayerCompositingContext {
            position: Duration::from_millis(200),
            released_at: None,
        }),
    );

    assert!(active);
}

#[test]
/// Verifies a completed fade-in no longer reports an active transition.
fn is_transition_active_reports_inactive_after_fade_in_completes() {
    let mut app = App::new();
    let parameter = spawn_parameter(&mut app, Attribute::Red, MergeStrategy::LTP);
    let mut query = app.world_mut().query::<&Parameter>();
    let parameters_query = query.query(app.world());

    let active = is_transition_active(
        &parameters_query,
        parameter.into(),
        &ParameterValue::Absolute { value: 255.0 },
        &MaterializedTransition {
            delay_in: Duration::ZERO,
            fade_in: Duration::from_millis(100),
            curve_in: FadeCurve::Linear,
            delay_out: Duration::ZERO,
            fade_out: Duration::ZERO,
            curve_out: FadeCurve::Linear,
            start_position: Duration::ZERO,
            release_position: None,
        },
        255.0,
        Some(&nightfall_compositor::types::LayerCompositingContext {
            position: Duration::from_secs(1),
            released_at: None,
        }),
    );

    assert!(!active);
}

#[test]
/// Verifies negative HTP relative values use fade-out timing.
fn is_transition_active_uses_fade_out_timing_for_htp_relative_fade_down() {
    let mut app = App::new();
    let parameter = spawn_parameter(&mut app, Attribute::Red, MergeStrategy::HTP);
    let mut query = app.world_mut().query::<&Parameter>();
    let parameters_query = query.query(app.world());

    let active = is_transition_active(
        &parameters_query,
        parameter.into(),
        &ParameterValue::Relative { offset: -30.0 },
        &MaterializedTransition {
            delay_in: Duration::ZERO,
            fade_in: Duration::from_millis(100),
            curve_in: FadeCurve::Linear,
            delay_out: Duration::from_millis(500),
            fade_out: Duration::from_secs(1),
            curve_out: FadeCurve::Linear,
            start_position: Duration::ZERO,
            release_position: None,
        },
        90.0,
        Some(&nightfall_compositor::types::LayerCompositingContext {
            position: Duration::from_millis(300),
            released_at: None,
        }),
    );

    assert!(active);
}

/// Verifies transition reporting uses a supplied playback-clock elapsed duration.
#[test]
fn is_transition_active_uses_explicit_compositing_context_when_present() {
    let mut app = App::new();
    let parameter = spawn_parameter(&mut app, Attribute::Red, MergeStrategy::LTP);
    let mut query = app.world_mut().query::<&Parameter>();
    let parameters_query = query.query(app.world());

    let active = is_transition_active(
        &parameters_query,
        parameter.into(),
        &ParameterValue::Absolute { value: 255.0 },
        &MaterializedTransition {
            delay_in: Duration::ZERO,
            fade_in: Duration::from_secs(1),
            curve_in: FadeCurve::Linear,
            delay_out: Duration::ZERO,
            fade_out: Duration::ZERO,
            curve_out: FadeCurve::Linear,
            start_position: Duration::ZERO,
            release_position: None,
        },
        127.0,
        Some(&nightfall_compositor::types::LayerCompositingContext {
            position: Duration::from_millis(500),
            released_at: None,
        }),
    );

    assert!(active);
}

/// Verifies websocket transition state honors each transition's source-local start anchor.
#[test]
fn computed_transition_state_uses_compositing_context_per_transition_start_position() {
    let mut app = App::new();
    let parameter = spawn_parameter(&mut app, Attribute::Red, MergeStrategy::LTP);
    let mut query = app.world_mut().query::<&Parameter>();
    let parameters_query = query.query(app.world());
    let mut layer = Layer::new("clocked".to_owned(), Priority::default());
    layer.absolute.insert(
        parameter,
        (
            ParameterValue::Absolute { value: 255.0 },
            Some(MaterializedTransition {
                delay_in: Duration::ZERO,
                fade_in: Duration::from_secs(1),
                curve_in: FadeCurve::Linear,
                delay_out: Duration::ZERO,
                fade_out: Duration::ZERO,
                curve_out: FadeCurve::Linear,
                start_position: Duration::from_millis(900),
                release_position: None,
            }),
        ),
    );
    let mut output = ComputedLayer::default();
    output.absolute.insert(parameter, 25.0);
    let compositing_context = LayerCompositingContext {
        position: Duration::from_secs(1),
        released_at: None,
    };

    let slot_of = |candidate: ParameterRef| (candidate == parameter.into()).then_some(7);

    let transitioning = computed_transitioning_slots(
        &layer,
        &output,
        &slot_of,
        &parameters_query,
        false,
        Some(&compositing_context),
    );

    assert_eq!(transitioning, PackedBytes(7u32.to_le_bytes().to_vec()));
}

/// Refreshes the parameter layout and publishes the layer stack on every update, bypassing the
/// low-frequency rate limiter so each update is one publication attempt.
fn publish_layer_stack_each_update(
    fixture_data_provider: Res<FixtureDataProviderExt>,
    mut projection: ResMut<ParameterStateProjection>,
    parameters: Query<&Parameter>,
    layers: Query<LayerSnapshotData>,
    mut publication: ResMut<LayerStackPublication>,
    broadcaster: Res<ClientEventSink>,
) {
    projection.refresh_layout(
        &fixture_data_provider,
        &fixture_data_provider.parameter_index(),
        false,
    );
    send_layer_stack(
        &projection,
        parameters,
        layers,
        &mut publication,
        &HeldButtonEffects::default(),
        None,
        &broadcaster,
    );
}

/// Builds an app with two patched bench fixtures that attempts a layer stack publication on
/// every update, returning the patched parameters and the outbound frame receiver.
fn layer_stack_app() -> (
    App,
    Vec<nightfall_fixtures::testing::BenchParameter>,
    async_channel::Receiver<OutboundFrame>,
) {
    let mut app = App::new();
    let parameters = nightfall_fixtures::testing::patch_bench_fixtures(
        app.world_mut(),
        2,
        &nightfall_io::OutputTransport::Disabled,
    );
    let (sender, receiver) = async_channel::unbounded();
    app.insert_resource(ClientEventSink::new(sender));
    app.init_resource::<ParameterStateProjection>();
    app.init_resource::<LayerStackPublication>();
    app.add_systems(Update, publish_layer_stack_each_update);
    (app, parameters, receiver)
}

/// Drains every published frame, returning their bytes in publication order.
fn drain_frames(receiver: &async_channel::Receiver<OutboundFrame>) -> Vec<Vec<u8>> {
    std::iter::from_fn(|| receiver.try_recv().ok())
        .map(|frame| frame.bytes)
        .collect()
}

/// Verifies layer values are sent packed by parameter layout slot with no fixture ids or
/// attribute names, and that a snapshot is only sent again once it changes or a client resyncs.
#[test]
fn layer_stack_is_packed_by_layout_slot_and_sent_only_when_changed() {
    let (mut app, parameters, receiver) = layer_stack_app();
    let parameter = &parameters[BENCH_PARAMETER_COUNT_FOR_TEST];
    let value = ParameterValue::Absolute { value: 200.0 };
    let mut layer = Layer::new("test".to_owned(), Priority::default());
    layer.absolute.insert(parameter.instance, (value, None));
    let mut output = OutputLayer::default();
    output.0.absolute.insert(parameter.instance, 200.0);
    let layer_entity = app.world_mut().spawn((layer, output)).id();

    app.update();
    let projection = app.world().resource::<ParameterStateProjection>();
    let slot = projection
        .slot_of(parameter.instance)
        .expect("patched parameter has a layout slot");
    let mut asserted_absolute = PackedLayerAssertions::default();
    asserted_absolute.push(slot, &value);
    let expected = OutboundLayerStack {
        layout_id: projection.layout_id(),
        layers: vec![OutboundLayerState {
            creator: "test".to_owned(),
            object_ref: None,
            priority: Priority::default(),
            is_releasing: false,
            runtime_position: None,
            held_button: None,
            asserted_absolute,
            asserted_relative: PackedLayerAssertions::default(),
            lookahead_asserted: PackedLayerAssertions::default(),
            computed_slots: PackedBytes(slot.to_le_bytes().to_vec()),
            computed_values: PackedBytes(200.0f32.to_le_bytes().to_vec()),
            transitioning_slots: PackedBytes::default(),
        }],
    };
    let expected_bytes = EncodedClientMessage::new(
        DISCRIMINATOR_DROPPABLE,
        &DeskWsMessage::LayerStack(&expected),
    )
    .expect("layer stack encodes")
    .to_bytes();
    assert_eq!(drain_frames(&receiver), vec![expected_bytes.clone()]);

    app.update();
    assert!(drain_frames(&receiver).is_empty());

    app.world_mut()
        .resource_mut::<LayerStackPublication>()
        .invalidate();
    app.update();
    assert_eq!(drain_frames(&receiver), vec![expected_bytes.clone()]);

    app.world_mut()
        .get_mut::<Layer>(layer_entity)
        .unwrap()
        .absolute
        .insert(
            parameter.instance,
            (ParameterValue::Absolute { value: 100.0 }, None),
        );
    app.update();
    let frames = drain_frames(&receiver);
    assert_eq!(frames.len(), 1);
    assert_ne!(frames[0], expected_bytes);
}

/// Index of the second bench fixture's first parameter, so the test exercises a slot past zero.
const BENCH_PARAMETER_COUNT_FOR_TEST: usize =
    nightfall_fixtures::testing::BENCH_FIXTURE_PARAMETERS.len();
