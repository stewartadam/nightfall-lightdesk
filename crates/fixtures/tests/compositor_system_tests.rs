// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Integration tests for the compositor system with Bevy ECS.
//!
//! These tests verify that the compositor system correctly integrates with Bevy's
//! ECS and writes computed values back to Parameter entities.

use std::time::Duration;

use bevy_app::prelude::*;
use bevy_ecs::prelude::*;
use moonshine_kind::Instance;
use nightfall::command_types::{DmxChannelExpr, DmxChannelRef};
use nightfall::data::Priority;
use nightfall::prelude::*;
use nightfall_compositor::prelude::*;
use nightfall_dmx::prelude::*;
use nightfall_engine::prelude::{
    CommandEnvelope, CommandNotice, CommandOrigin, CommandReply, CommandResult, CommandTracker,
    EngineActionEnvelope, FinishedCommand, ReplyTarget,
};
use nightfall_fixtures::prelude::*;
use nightfall_fixtures::undo::{
    ClearDmxChannels, DmxChannelSnapshot, FixtureSnapshot, ParameterSnapshot,
    RestoreFixtureSnapshot,
};
use nightfall_instances::{PlaybackAction, PlaybackScope};
use nightfall_io::prelude::*;

/// Installs the command lifecycle resources required by action handlers.
fn init_command_lifecycle(app: &mut App) {
    app.init_resource::<CommandTracker>();
    app.add_message::<CommandResult>();
    app.add_message::<CommandReply>();
    app.add_message::<FinishedCommand>();
    app.add_message::<CommandNotice>();
}

/// Registers and writes one fixture command through its semantic test envelope.
fn write_tracked_fixture_command(app: &mut App, command: FixtureCommand) {
    let envelope = CommandEnvelope::new(command, CommandOrigin::Cli, ReplyTarget::Detached);
    app.world_mut()
        .resource_mut::<CommandTracker>()
        .register(&envelope)
        .expect("fixture command should register");
    app.world_mut().write_message(envelope);
}

/// Helper function to create a test layer.
fn create_test_layer(priority: i8, param_entity: Entity, value: f32) -> Layer {
    let mut layer = Layer::new("test".to_owned(), Priority(priority));

    // Create a mock Instance<Parameter>
    // In a real test, we'd use the proper Instance type, but for testing we can use Entity
    layer.absolute.insert(
        unsafe {
            std::mem::transmute::<
                bevy_ecs::entity::Entity,
                moonshine_kind::Instance<nightfall_fixtures::parameter::Parameter>,
            >(param_entity)
        },
        (ParameterValue::Absolute { value }, None),
    );
    layer
}

/// Spawns an intensity parameter with LTP merge semantics for compositor tests.
fn spawn_test_parameter(app: &mut App, default_value: f32, current_value: f32) -> Entity {
    app.world_mut()
        .spawn(Parameter {
            metadata: ParameterMetadata {
                resolution: DmxValueResolution::Coarse,
                attribute: Attribute::Intensity,
                native_unit: Attribute::Intensity.native_unit(),
                value_polarity: Attribute::Intensity.value_polarity(),
                min: 0.0,
                max: 255.0,
                offset: ParameterValue::Absolute { value: 0.0 },
                is_inverted: false,
                is_snap: false,
                merge_type: MergeStrategy::LTP,
                use_grandmaster: true,
            },
            values: ParameterValues {
                default_value,
                highlight_value: 255.0,
                current_value,
            },
        })
        .id()
}

#[derive(Component)]
struct RunningFixtureEffect {
    fixture_uid: uuid::Uuid,
    value: f32,
}

#[derive(Resource, Default)]
struct ChangedParameterCount(usize);

/// Records how many parameter components were changed in the current update.
fn count_changed_parameters(
    mut changed_count: ResMut<ChangedParameterCount>,
    changed_parameters: Query<(), Changed<Parameter>>,
) {
    changed_count.0 = changed_parameters.iter().count();
}

/// Verifies the compositor publishes computed output values for downstream semantic invalidation.
#[test]
fn compositor_publishes_final_computed_output_layer() {
    let mut app = App::new();
    app.init_resource::<FinalLayerAttributedAssertions>();
    app.init_resource::<FinalLayerOutput>();
    app.add_systems(Update, compositor::<Parameter>);

    let parameter_entity = spawn_test_parameter(&mut app, 7.0, 7.0);

    app.world_mut().spawn((
        ObjectRefMarker(ObjectRef::ById {
            object_type: ObjectType::Cue,
            id: 1,
        }),
        create_test_layer(1, parameter_entity, 120.0),
    ));

    app.update();

    let parameter = unsafe { Instance::<Parameter>::from_entity_unchecked(parameter_entity) };
    let output_layer = app.world().resource::<FinalLayerOutput>();
    assert_eq!(output_layer.0.get_effective_value(parameter), 120.0);
}

/// Updates a running test effect layer against the current fixture parameter entity.
fn update_running_fixture_effect_layers(
    data_provider: Res<FixtureDataProviderExt>,
    mut layers: Query<(&RunningFixtureEffect, &mut Layer)>,
) {
    for (effect, mut layer) in &mut layers {
        let existing_parameters: Vec<_> = layer.absolute.keys().collect();
        for parameter in existing_parameters {
            layer.absolute.remove(&parameter);
        }
        let element_ref = FixtureRef {
            fixture_uid: effect.fixture_uid,
            index: Some(1),
        };
        let Some(parameter) =
            data_provider.try_parameter_for_element_attribute(&element_ref, &Attribute::Intensity)
        else {
            continue;
        };

        layer.absolute.insert(
            parameter,
            (
                ParameterValue::Absolute {
                    value: effect.value,
                },
                None,
            ),
        );
    }
}

/// Verifies stable compositor output does not dirty parameter components every frame.
#[test]
fn compositor_skips_unchanged_parameter_writes() {
    let mut app = App::new();
    app.init_resource::<FinalLayerAttributedAssertions>();
    app.init_resource::<ChangedParameterCount>();
    app.add_systems(
        Update,
        (compositor::<Parameter>, count_changed_parameters).chain(),
    );

    spawn_test_parameter(&mut app, 7.0, 7.0);

    app.update();
    app.world_mut().resource_mut::<ChangedParameterCount>().0 = 0;
    app.update();

    assert_eq!(
        app.world().resource::<ChangedParameterCount>().0,
        0,
        "unchanged compositor output should not dirty parameter components"
    );
}

/// Verifies mutating an existing layer assertion still updates the asserted parameter.
#[test]
fn compositor_recomputes_when_layer_assertion_changes() {
    let mut app = App::new();
    app.init_resource::<FinalLayerAttributedAssertions>();
    app.init_resource::<ChangedParameterCount>();
    app.add_systems(
        Update,
        (compositor::<Parameter>, count_changed_parameters).chain(),
    );

    let parameter_entity = spawn_test_parameter(&mut app, 7.0, 7.0);
    let layer_entity = app
        .world_mut()
        .spawn((
            ObjectRefMarker(ObjectRef::ById {
                object_type: ObjectType::Cue,
                id: 1,
            }),
            create_test_layer(1, parameter_entity, 120.0),
        ))
        .id();

    app.update();
    let param = app.world().get::<Parameter>(parameter_entity).unwrap();
    assert_eq!(param.values.current_value, 120.0);

    app.world_mut().resource_mut::<ChangedParameterCount>().0 = 0;
    let parameter = unsafe { Instance::<Parameter>::from_entity_unchecked(parameter_entity) };
    let mut layer = app.world_mut().get_mut::<Layer>(layer_entity).unwrap();
    let (value, _) = layer.absolute.get_mut(&parameter).unwrap();
    *value = ParameterValue::Absolute { value: 140.0 };
    drop(layer);

    app.update();

    let param = app.world().get::<Parameter>(parameter_entity).unwrap();
    assert_eq!(param.values.current_value, 140.0);
    assert_eq!(
        app.world().resource::<ChangedParameterCount>().0,
        1,
        "changed layer assertions should dirty their affected parameters"
    );

    app.world_mut().resource_mut::<ChangedParameterCount>().0 = 0;
    app.update();

    let param = app.world().get::<Parameter>(parameter_entity).unwrap();
    assert_eq!(param.values.current_value, 140.0);
    assert_eq!(
        app.world().resource::<ChangedParameterCount>().0,
        0,
        "stable assertions should not dirty parameters after recomputing once"
    );
}

/// Verifies adding and removing layers recomputes output before returning to a stable frame.
#[test]
fn compositor_recomputes_when_layer_count_changes() {
    let mut app = App::new();
    app.init_resource::<FinalLayerAttributedAssertions>();
    app.init_resource::<ChangedParameterCount>();
    app.add_systems(
        Update,
        (compositor::<Parameter>, count_changed_parameters).chain(),
    );

    let parameter_entity = spawn_test_parameter(&mut app, 7.0, 7.0);
    app.world_mut().spawn((
        ObjectRefMarker(ObjectRef::ById {
            object_type: ObjectType::Cue,
            id: 1,
        }),
        create_test_layer(1, parameter_entity, 50.0),
    ));

    app.update();
    let param = app.world().get::<Parameter>(parameter_entity).unwrap();
    assert_eq!(param.values.current_value, 50.0);

    app.world_mut().resource_mut::<ChangedParameterCount>().0 = 0;
    let high_priority_layer_entity = app
        .world_mut()
        .spawn((
            ObjectRefMarker(ObjectRef::ById {
                object_type: ObjectType::Cue,
                id: 2,
            }),
            create_test_layer(2, parameter_entity, 180.0),
        ))
        .id();
    app.update();

    let param = app.world().get::<Parameter>(parameter_entity).unwrap();
    assert_eq!(param.values.current_value, 180.0);
    assert_eq!(
        app.world().resource::<ChangedParameterCount>().0,
        1,
        "added layers should dirty recomputed parameters"
    );

    app.world_mut().resource_mut::<ChangedParameterCount>().0 = 0;
    app.world_mut().despawn(high_priority_layer_entity);
    app.update();

    let param = app.world().get::<Parameter>(parameter_entity).unwrap();
    assert_eq!(param.values.current_value, 50.0);
    assert_eq!(
        app.world().resource::<ChangedParameterCount>().0,
        1,
        "removed layers should dirty recomputed parameters"
    );

    app.world_mut().resource_mut::<ChangedParameterCount>().0 = 0;
    app.update();

    let param = app.world().get::<Parameter>(parameter_entity).unwrap();
    assert_eq!(param.values.current_value, 50.0);
    assert_eq!(
        app.world().resource::<ChangedParameterCount>().0,
        0,
        "stable layer stacks should not dirty parameters after recomputing once"
    );
}

/// Verifies replacing a layer recomputes output when the active layer count stays constant.
#[test]
fn compositor_recomputes_when_layer_is_replaced_at_same_count() {
    let mut app = App::new();
    app.init_resource::<FinalLayerAttributedAssertions>();
    app.init_resource::<ChangedParameterCount>();
    app.add_systems(
        Update,
        (compositor::<Parameter>, count_changed_parameters).chain(),
    );

    let parameter_entity = spawn_test_parameter(&mut app, 7.0, 7.0);
    let original_layer_entity = app
        .world_mut()
        .spawn((
            ObjectRefMarker(ObjectRef::ById {
                object_type: ObjectType::Cue,
                id: 1,
            }),
            create_test_layer(1, parameter_entity, 50.0),
        ))
        .id();
    app.update();

    app.world_mut().resource_mut::<ChangedParameterCount>().0 = 0;
    app.world_mut().despawn(original_layer_entity);
    app.world_mut().spawn((
        ObjectRefMarker(ObjectRef::ById {
            object_type: ObjectType::Cue,
            id: 2,
        }),
        create_test_layer(2, parameter_entity, 180.0),
    ));
    app.update();

    let param = app.world().get::<Parameter>(parameter_entity).unwrap();
    assert_eq!(param.values.current_value, 180.0);
    assert_eq!(
        app.world().resource::<ChangedParameterCount>().0,
        1,
        "a newly added layer should trigger recomposition when replacing a removed layer"
    );
}

/// Verifies changing layer compositing context recomputes transition output.
#[test]
fn compositor_recomputes_when_layer_compositing_context_changes() {
    let mut app = App::new();
    app.insert_resource(FixtureDataProviderExt::default());
    app.init_resource::<FinalLayerAttributedAssertions>();
    app.init_resource::<ChangedParameterCount>();
    app.add_systems(
        Update,
        (compositor::<Parameter>, count_changed_parameters).chain(),
    );

    let parameter_entity = spawn_test_parameter(&mut app, 0.0, 0.0);
    let parameter = unsafe { Instance::<Parameter>::from_entity_unchecked(parameter_entity) };
    let mut layer = Layer::new("release".to_owned(), Priority(1));
    layer.absolute.insert(
        parameter,
        (
            ParameterValue::Absolute { value: 100.0 },
            Some(MaterializedTransition {
                delay_in: Duration::ZERO,
                fade_in: Duration::ZERO,
                curve_in: FadeCurve::Linear,
                delay_out: Duration::ZERO,
                fade_out: Duration::from_secs(1),
                curve_out: FadeCurve::Linear,
                start_position: Duration::ZERO,
                release_position: None,
            }),
        ),
    );

    let layer_entity = app
        .world_mut()
        .spawn((
            ObjectRefMarker(ObjectRef::ById {
                object_type: ObjectType::Cue,
                id: 1,
            }),
            ReleaseMarker::default(),
            LayerCompositingContext {
                position: Duration::from_millis(1500),
                released_at: Some(Duration::from_secs(1)),
            },
            layer,
        ))
        .id();

    app.update();
    let param = app.world().get::<Parameter>(parameter_entity).unwrap();
    assert_eq!(param.values.current_value, 50.0);

    app.world_mut().resource_mut::<ChangedParameterCount>().0 = 0;
    app.world_mut()
        .get_mut::<LayerCompositingContext>(layer_entity)
        .unwrap()
        .position = Duration::from_millis(1750);
    app.update();

    let param = app.world().get::<Parameter>(parameter_entity).unwrap();
    assert_eq!(param.values.current_value, 25.0);
    assert_eq!(
        app.world().resource::<ChangedParameterCount>().0,
        1,
        "changed compositing context should dirty transitioned parameters"
    );

    app.world_mut().resource_mut::<ChangedParameterCount>().0 = 0;
    app.update();

    let param = app.world().get::<Parameter>(parameter_entity).unwrap();
    assert_eq!(param.values.current_value, 25.0);
    assert_eq!(
        app.world().resource::<ChangedParameterCount>().0,
        0,
        "stable compositing context should not dirty parameters after recomputing once"
    );
}

/// Verifies removing a release marker restores the layer's assertion immediately.
#[test]
fn compositor_recomputes_when_release_marker_is_removed() {
    let mut app = App::new();
    app.init_resource::<FinalLayerAttributedAssertions>();
    app.init_resource::<FinalLayerOutput>();
    app.add_systems(Update, compositor::<Parameter>);

    let parameter_entity = spawn_test_parameter(&mut app, 7.0, 7.0);
    let layer_entity = app
        .world_mut()
        .spawn((
            ObjectRefMarker(ObjectRef::ById {
                object_type: ObjectType::Cue,
                id: 1,
            }),
            ReleaseMarker::default(),
            create_test_layer(1, parameter_entity, 120.0),
        ))
        .id();

    app.update();
    let parameter = unsafe { Instance::<Parameter>::from_entity_unchecked(parameter_entity) };
    assert_eq!(
        app.world()
            .resource::<FinalLayerOutput>()
            .0
            .get_effective_value(parameter),
        0.0
    );

    app.world_mut()
        .entity_mut(layer_entity)
        .remove::<ReleaseMarker>();
    app.update();

    let param = app.world().get::<Parameter>(parameter_entity).unwrap();
    assert_eq!(param.values.current_value, 120.0);
    assert_eq!(
        app.world()
            .resource::<FinalLayerOutput>()
            .0
            .get_effective_value(parameter),
        120.0
    );
}

/// Verifies removing a compositing context reevaluates transitions at zero elapsed.
#[test]
fn compositor_recomputes_when_layer_compositing_context_is_removed() {
    let mut app = App::new();
    app.init_resource::<FinalLayerAttributedAssertions>();
    app.init_resource::<FinalLayerOutput>();
    app.add_systems(Update, compositor::<Parameter>);

    let parameter_entity = spawn_test_parameter(&mut app, 0.0, 0.0);
    let parameter = unsafe { Instance::<Parameter>::from_entity_unchecked(parameter_entity) };
    let mut layer = Layer::new("transition".to_owned(), Priority(1));
    layer.absolute.insert(
        parameter,
        (
            ParameterValue::Absolute { value: 100.0 },
            Some(MaterializedTransition {
                delay_in: Duration::ZERO,
                fade_in: Duration::from_secs(1),
                curve_in: FadeCurve::Linear,
                delay_out: Duration::ZERO,
                fade_out: Duration::ZERO,
                curve_out: FadeCurve::Linear,
                start_position: Duration::ZERO,
                release_position: None,
            }),
        ),
    );
    let layer_entity = app
        .world_mut()
        .spawn((
            ObjectRefMarker(ObjectRef::ById {
                object_type: ObjectType::Cue,
                id: 1,
            }),
            LayerCompositingContext {
                position: Duration::from_millis(500),
                released_at: None,
            },
            layer,
        ))
        .id();

    app.update();
    let param = app.world().get::<Parameter>(parameter_entity).unwrap();
    assert_eq!(param.values.current_value, 50.0);

    app.world_mut()
        .entity_mut(layer_entity)
        .remove::<LayerCompositingContext>();
    app.update();

    let param = app.world().get::<Parameter>(parameter_entity).unwrap();
    assert_eq!(param.values.current_value, 0.0);
    assert_eq!(
        app.world()
            .resource::<FinalLayerOutput>()
            .0
            .get_effective_value(parameter),
        0.0
    );
}

/// RestoreFixtureSnapshot lets a running effect continue asserting restored parameters.
#[test]
fn restore_fixture_snapshot_allows_running_effect_to_assert_restored_parameters() {
    let mut app = App::new();
    init_command_lifecycle(&mut app);
    app.add_message::<EngineActionEnvelope<RestoreFixtureSnapshot>>();
    app.init_resource::<FixtureDataProviderExt>();
    app.init_resource::<FinalLayerAttributedAssertions>();
    app.add_systems(
        Update,
        (
            nightfall_fixtures::events::handle_restore_fixture_snapshot,
            update_running_fixture_effect_layers,
            compositor::<Parameter>,
        )
            .chain(),
    );

    let fixture_uid = uuid::Uuid::new_v4();
    let metadata = ParameterMetadata {
        resolution: DmxValueResolution::Coarse,
        attribute: Attribute::Intensity,
        native_unit: Attribute::Intensity.native_unit(),
        value_polarity: Attribute::Intensity.value_polarity(),
        min: 0.0,
        max: 255.0,
        offset: ParameterValue::Absolute { value: 0.0 },
        is_inverted: false,
        is_snap: false,
        merge_type: MergeStrategy::LTP,
        use_grandmaster: true,
    };
    let fixture = Fixture {
        identifiers: Identifiers {
            id: 101,
            uid: fixture_uid,
            label: "restored fixture".to_owned(),
        },
        make: "test".to_owned(),
        model: "test".to_owned(),
        mode: "default".to_owned(),
        elements: vec![FixtureElement {
            label: "main".to_owned(),
            parameters: vec![metadata.clone()],
        }],
        ..Default::default()
    };
    let restored_values = ParameterValues {
        default_value: 7.0,
        highlight_value: 255.0,
        current_value: 77.0,
    };

    app.world_mut().spawn((
        RunningFixtureEffect {
            fixture_uid,
            value: 222.0,
        },
        Layer::new("running effect".to_owned(), Priority(10)),
        ObjectRefMarker(ObjectRef::ById {
            object_type: ObjectType::Fx,
            id: 1,
        }),
    ));
    app.world_mut()
        .write_message(EngineActionEnvelope::detached(RestoreFixtureSnapshot(
            FixtureSnapshot {
                fixture,
                parameters: vec![ParameterSnapshot {
                    element_index: 1,
                    metadata,
                    values: restored_values.clone(),
                }],
                color_path_defaults: vec![],
            },
        )));

    app.update();

    let parameter = {
        let data_provider = app.world().resource::<FixtureDataProviderExt>();
        data_provider.try_parameter_for_element_attribute(
            &FixtureRef {
                fixture_uid,
                index: Some(1),
            },
            &Attribute::Intensity,
        )
    }
    .expect("restored fixture should register its parameter entity");
    let parameter_component = app
        .world()
        .get::<Parameter>(parameter.entity())
        .expect("restored parameter should exist");
    assert_eq!(
        parameter_component.values.default_value,
        restored_values.default_value
    );
    assert_eq!(
        parameter_component.values.highlight_value,
        restored_values.highlight_value
    );
    assert_eq!(parameter_component.values.current_value, 222.0);

    app.update();

    assert_eq!(
        app.world()
            .get::<Parameter>(parameter.entity())
            .expect("restored parameter should still exist")
            .values
            .current_value,
        222.0
    );
}

#[test]
fn test_compositor_merges_layers_by_priority() {
    // Initialize a new Bevy app with the compositor system
    let mut app = App::new();
    let data_provider = FixtureDataProviderExt::default();
    app.insert_resource(data_provider);
    app.init_resource::<FinalLayerAttributedAssertions>();

    // Create a parameter with LTP (Latest Takes Precedence) merge strategy
    let metadata = ParameterMetadata {
        resolution: DmxValueResolution::Coarse,
        attribute: Attribute::Red,
        native_unit: Attribute::Red.native_unit(),
        value_polarity: Attribute::Red.value_polarity(),
        min: 0.0,
        max: 255.0,
        offset: ParameterValue::Absolute { value: 0.0 },
        is_inverted: false,
        is_snap: false,
        merge_type: MergeStrategy::LTP,
        use_grandmaster: false,
    };

    let fixture = Fixture {
        identifiers: Identifiers {
            id: 1,
            uid: uuid::Uuid::new_v4(),
            label: "test".to_string(),
        },
        make: "test".to_string(),
        model: "test".to_string(),
        elements: vec![FixtureElement {
            label: "test fixture".to_owned(),
            parameters: vec![metadata.clone()],
        }],
        ..Default::default()
    };

    let parameter_entity = app
        .world_mut()
        .spawn(Parameter {
            metadata: metadata.clone(),
            values: Default::default(),
        })
        .id();

    unsafe {
        let mut data_provider = app
            .world_mut()
            .get_resource_mut::<FixtureDataProviderExt>()
            .unwrap();
        let _ = data_provider.inner.add(fixture.clone());

        let parameter: Instance<Parameter> = Instance::from_entity_unchecked(parameter_entity);
        data_provider.add_parameter(
            FixtureRef {
                fixture_uid: fixture.identifiers.uid,
                index: Some(1),
            },
            Attribute::Red,
            parameter,
        );
    }

    // Create layers with different priorities
    let layer1 = create_test_layer(99, parameter_entity, 99.0);
    let layer2 = create_test_layer(1, parameter_entity, 1.0);

    // Add layers to the layer stack
    app.world_mut().spawn((
        ObjectRefMarker(ObjectRef::ById {
            object_type: ObjectType::Cue,
            id: 1,
        }),
        layer1,
    ));
    app.world_mut().spawn((
        ObjectRefMarker(ObjectRef::ById {
            object_type: ObjectType::Cue,
            id: 2,
        }),
        layer2,
    ));

    // Run the compositor system
    app.add_systems(Update, compositor::<Parameter>);
    app.update();

    // Verify the parameter was updated with the higher priority value
    let param = app.world().get::<Parameter>(parameter_entity).unwrap();
    assert_eq!(param.values.current_value, 99.0);
}

/// Verifies releasing layers evaluate release progress from their layer compositing context.
#[test]
fn compositor_uses_layer_compositing_context_for_release_elapsed() {
    let mut app = App::new();
    app.insert_resource(FixtureDataProviderExt::default());
    app.init_resource::<FinalLayerAttributedAssertions>();

    let parameter_entity = app
        .world_mut()
        .spawn(Parameter {
            metadata: ParameterMetadata {
                resolution: DmxValueResolution::Coarse,
                attribute: Attribute::Intensity,
                native_unit: Attribute::Intensity.native_unit(),
                value_polarity: Attribute::Intensity.value_polarity(),
                min: 0.0,
                max: 255.0,
                offset: ParameterValue::Absolute { value: 0.0 },
                is_inverted: false,
                is_snap: false,
                merge_type: MergeStrategy::LTP,
                use_grandmaster: false,
            },
            values: Default::default(),
        })
        .id();

    let parameter = unsafe { Instance::<Parameter>::from_entity_unchecked(parameter_entity) };
    let mut layer = Layer::new("release".to_owned(), Priority(1));
    layer.absolute.insert(
        parameter,
        (
            ParameterValue::Absolute { value: 100.0 },
            Some(MaterializedTransition {
                delay_in: Duration::ZERO,
                fade_in: Duration::ZERO,
                curve_in: FadeCurve::Linear,
                delay_out: Duration::ZERO,
                fade_out: Duration::from_secs(1),
                curve_out: FadeCurve::Linear,
                start_position: Duration::ZERO,
                release_position: None,
            }),
        ),
    );

    app.world_mut().spawn((
        ObjectRefMarker(ObjectRef::ById {
            object_type: ObjectType::Cue,
            id: 1,
        }),
        ReleaseMarker::default(),
        LayerCompositingContext {
            position: Duration::from_millis(1500),
            released_at: Some(Duration::from_secs(1)),
        },
        layer,
    ));

    app.add_systems(Update, compositor::<Parameter>);
    app.update();

    let param = app.world().get::<Parameter>(parameter_entity).unwrap();
    assert_eq!(param.values.current_value, 50.0);
}

#[test]
fn test_compositor_same_priority_htp_highest_value_wins() {
    let mut app = App::new();
    let data_provider = FixtureDataProviderExt::default();
    app.insert_resource(data_provider);
    app.init_resource::<FinalLayerAttributedAssertions>();

    // Create a parameter with HTP (Highest Takes Precedence) merge strategy
    let metadata = ParameterMetadata {
        resolution: DmxValueResolution::Coarse,
        attribute: Attribute::Intensity,
        native_unit: Attribute::Intensity.native_unit(),
        value_polarity: Attribute::Intensity.value_polarity(),
        min: 0.0,
        max: 255.0,
        offset: ParameterValue::Absolute { value: 0.0 },
        is_inverted: false,
        is_snap: false,
        merge_type: MergeStrategy::HTP,
        use_grandmaster: false,
    };

    let fixture = Fixture {
        identifiers: Identifiers {
            id: 1,
            uid: uuid::Uuid::new_v4(),
            label: "test".to_string(),
        },
        make: "test".to_string(),
        model: "test".to_string(),
        elements: vec![FixtureElement {
            label: "test fixture".to_owned(),
            parameters: vec![metadata.clone()],
        }],
        ..Default::default()
    };

    let parameter_entity = app
        .world_mut()
        .spawn(Parameter {
            metadata: metadata.clone(),
            values: Default::default(),
        })
        .id();

    unsafe {
        let mut data_provider = app
            .world_mut()
            .get_resource_mut::<FixtureDataProviderExt>()
            .unwrap();
        let _ = data_provider.inner.add(fixture.clone());

        let parameter: Instance<Parameter> = Instance::from_entity_unchecked(parameter_entity);
        data_provider.add_parameter(
            FixtureRef {
                fixture_uid: fixture.identifiers.uid,
                index: Some(1),
            },
            Attribute::Intensity,
            parameter,
        );
    }

    // Create layers with SAME priority but assert a lower value in second layer
    let layer1 = create_test_layer(1, parameter_entity, 150.0);
    let layer2 = create_test_layer(1, parameter_entity, 100.0);

    app.world_mut().spawn((
        ObjectRefMarker(ObjectRef::ById {
            object_type: ObjectType::Cue,
            id: 1,
        }),
        layer1,
    ));
    app.world_mut().spawn((
        ObjectRefMarker(ObjectRef::ById {
            object_type: ObjectType::Cue,
            id: 2,
        }),
        layer2,
    ));

    app.add_systems(Update, compositor::<Parameter>);
    app.update();

    // With same priority and HTP merge strategy, the highest value wins
    let param = app.world().get::<Parameter>(parameter_entity).unwrap();
    assert_eq!(param.values.current_value, 150.0);
}

#[test]
fn test_compositor_same_priority_ltp_activation_order_wins() {
    use std::thread::sleep;
    use std::time::Duration;

    let mut app = App::new();
    let data_provider = FixtureDataProviderExt::default();
    app.insert_resource(data_provider);
    app.init_resource::<FinalLayerAttributedAssertions>();

    // Create a parameter with LTP (Latest Takes Precedence) merge strategy
    let metadata = ParameterMetadata {
        resolution: DmxValueResolution::Coarse,
        attribute: Attribute::Red,
        native_unit: Attribute::Red.native_unit(),
        value_polarity: Attribute::Red.value_polarity(),
        min: 0.0,
        max: 255.0,
        offset: ParameterValue::Absolute { value: 0.0 },
        is_inverted: false,
        is_snap: false,
        merge_type: MergeStrategy::LTP,
        use_grandmaster: false,
    };

    let fixture = Fixture {
        identifiers: Identifiers {
            id: 1,
            uid: uuid::Uuid::new_v4(),
            label: "test".to_string(),
        },
        make: "test".to_string(),
        model: "test".to_string(),
        elements: vec![FixtureElement {
            label: "test fixture".to_owned(),
            parameters: vec![metadata.clone()],
        }],
        ..Default::default()
    };

    let parameter_entity = app
        .world_mut()
        .spawn(Parameter {
            metadata: metadata.clone(),
            values: Default::default(),
        })
        .id();

    unsafe {
        let mut data_provider = app
            .world_mut()
            .get_resource_mut::<FixtureDataProviderExt>()
            .unwrap();
        let _ = data_provider.inner.add(fixture.clone());

        let parameter: Instance<Parameter> = Instance::from_entity_unchecked(parameter_entity);
        data_provider.add_parameter(
            FixtureRef {
                fixture_uid: fixture.identifiers.uid,
                index: Some(1),
            },
            Attribute::Red,
            parameter,
        );
    }

    // Create layers with SAME priority but different activation times
    // layer1 activated first
    let layer1 = create_test_layer(1, parameter_entity, 100.0);
    sleep(Duration::from_millis(2)); // Ensure different activation times

    // layer2 activated second (should win due to later activation time)
    let layer2 = create_test_layer(1, parameter_entity, 50.0);

    app.world_mut().spawn((
        ObjectRefMarker(ObjectRef::ById {
            object_type: ObjectType::Cue,
            id: 1,
        }),
        layer1,
    ));
    app.world_mut().spawn((
        ObjectRefMarker(ObjectRef::ById {
            object_type: ObjectType::Cue,
            id: 2,
        }),
        layer2,
    ));

    app.add_systems(Update, compositor::<Parameter>);
    app.update();

    // With same priority and LTP, the latest activated layer wins (layer2's value: 50)
    let param = app.world().get::<Parameter>(parameter_entity).unwrap();
    assert_eq!(param.values.current_value, 50.0);
}

#[test]
fn test_compositor_priority_takes_precedence_over_htp() {
    let mut app = App::new();
    let data_provider = FixtureDataProviderExt::default();
    app.insert_resource(data_provider);
    app.init_resource::<FinalLayerAttributedAssertions>();

    // Create a parameter with HTP merge strategy
    let metadata = ParameterMetadata {
        resolution: DmxValueResolution::Coarse,
        attribute: Attribute::Intensity,
        native_unit: Attribute::Intensity.native_unit(),
        value_polarity: Attribute::Intensity.value_polarity(),
        min: 0.0,
        max: 255.0,
        offset: ParameterValue::Absolute { value: 0.0 },
        is_inverted: false,
        is_snap: false,
        merge_type: MergeStrategy::HTP,
        use_grandmaster: false,
    };

    let fixture = Fixture {
        identifiers: Identifiers {
            id: 1,
            uid: uuid::Uuid::new_v4(),
            label: "test".to_string(),
        },
        make: "test".to_string(),
        model: "test".to_string(),
        elements: vec![FixtureElement {
            label: "test fixture".to_owned(),
            parameters: vec![metadata.clone()],
        }],
        ..Default::default()
    };

    let parameter_entity = app
        .world_mut()
        .spawn(Parameter {
            metadata: metadata.clone(),
            values: Default::default(),
        })
        .id();

    unsafe {
        let mut data_provider = app
            .world_mut()
            .get_resource_mut::<FixtureDataProviderExt>()
            .unwrap();
        let _ = data_provider.inner.add(fixture.clone());

        let parameter: Instance<Parameter> = Instance::from_entity_unchecked(parameter_entity);
        data_provider.add_parameter(
            FixtureRef {
                fixture_uid: fixture.identifiers.uid,
                index: Some(1),
            },
            Attribute::Intensity,
            parameter,
        );
    }

    // Layer 1: lower priority (1), higher value (200)
    // Layer 2: higher priority (2), lower value (50)
    let layer1 = create_test_layer(1, parameter_entity, 200.0);
    let layer2 = create_test_layer(2, parameter_entity, 50.0);

    app.world_mut().spawn((
        ObjectRefMarker(ObjectRef::ById {
            object_type: ObjectType::Cue,
            id: 1,
        }),
        layer1,
    ));
    app.world_mut().spawn((
        ObjectRefMarker(ObjectRef::ById {
            object_type: ObjectType::Cue,
            id: 2,
        }),
        layer2,
    ));

    app.add_systems(Update, compositor::<Parameter>);
    app.update();

    // Priority always wins over HTP - higher priority layer's value (50) takes precedence
    // even though the lower priority layer has a higher value (200)
    let param = app.world().get::<Parameter>(parameter_entity).unwrap();
    assert_eq!(param.values.current_value, 50.0);
}

#[test]
fn test_compositor_priority_takes_precedence_over_ltp() {
    let mut app = App::new();
    let data_provider = FixtureDataProviderExt::default();
    app.insert_resource(data_provider);
    app.init_resource::<FinalLayerAttributedAssertions>();

    // Create a parameter with LTP merge strategy
    let metadata = ParameterMetadata {
        resolution: DmxValueResolution::Coarse,
        attribute: Attribute::Red,
        native_unit: Attribute::Red.native_unit(),
        value_polarity: Attribute::Red.value_polarity(),
        min: 0.0,
        max: 255.0,
        offset: ParameterValue::Absolute { value: 0.0 },
        is_inverted: false,
        is_snap: false,
        merge_type: MergeStrategy::LTP,
        use_grandmaster: false,
    };

    let fixture = Fixture {
        identifiers: Identifiers {
            id: 1,
            uid: uuid::Uuid::new_v4(),
            label: "test".to_string(),
        },
        make: "test".to_string(),
        model: "test".to_string(),
        elements: vec![FixtureElement {
            label: "test fixture".to_owned(),
            parameters: vec![metadata.clone()],
        }],
        ..Default::default()
    };

    let parameter_entity = app
        .world_mut()
        .spawn(Parameter {
            metadata: metadata.clone(),
            values: Default::default(),
        })
        .id();

    unsafe {
        let mut data_provider = app
            .world_mut()
            .get_resource_mut::<FixtureDataProviderExt>()
            .unwrap();
        let _ = data_provider.inner.add(fixture.clone());

        let parameter: Instance<Parameter> = Instance::from_entity_unchecked(parameter_entity);
        data_provider.add_parameter(
            FixtureRef {
                fixture_uid: fixture.identifiers.uid,
                index: Some(1),
            },
            Attribute::Red,
            parameter,
        );
    }

    // Layer 1: lower priority (1), value 100
    // Layer 2: higher priority (2), value 75
    let layer1 = create_test_layer(1, parameter_entity, 100.0);
    let layer2 = create_test_layer(2, parameter_entity, 75.0);

    app.world_mut().spawn((
        ObjectRefMarker(ObjectRef::ById {
            object_type: ObjectType::Cue,
            id: 1,
        }),
        layer1,
    ));
    app.world_mut().spawn((
        ObjectRefMarker(ObjectRef::ById {
            object_type: ObjectType::Cue,
            id: 2,
        }),
        layer2,
    ));

    app.add_systems(Update, compositor::<Parameter>);
    app.update();

    // Priority always wins - higher priority layer's value (75) takes precedence
    let param = app.world().get::<Parameter>(parameter_entity).unwrap();
    assert_eq!(param.values.current_value, 75.0);
}

#[test]
fn test_compositor_handles_ltp_merge_strategy() {
    let mut app = App::new();
    let data_provider = FixtureDataProviderExt::default();
    app.insert_resource(data_provider);
    app.init_resource::<FinalLayerAttributedAssertions>();

    // Create a parameter with LTP (Latest Takes Precedence) merge strategy
    let metadata = ParameterMetadata {
        resolution: DmxValueResolution::Coarse,
        attribute: Attribute::Red,
        native_unit: Attribute::Red.native_unit(),
        value_polarity: Attribute::Red.value_polarity(),
        min: 0.0,
        max: 255.0,
        offset: ParameterValue::Absolute { value: 0.0 },
        is_inverted: false,
        is_snap: false,
        merge_type: MergeStrategy::LTP,
        use_grandmaster: false,
    };

    let fixture = Fixture {
        identifiers: Identifiers {
            id: 1,
            uid: uuid::Uuid::new_v4(),
            label: "test".to_string(),
        },
        make: "test".to_string(),
        model: "test".to_string(),
        elements: vec![FixtureElement {
            label: "test fixture".to_owned(),
            parameters: vec![metadata.clone()],
        }],
        ..Default::default()
    };

    let parameter_entity = app
        .world_mut()
        .spawn(Parameter {
            metadata: metadata.clone(),
            values: Default::default(),
        })
        .id();

    unsafe {
        let mut data_provider = app
            .world_mut()
            .get_resource_mut::<FixtureDataProviderExt>()
            .unwrap();
        let _ = data_provider.inner.add(fixture.clone());

        let parameter: Instance<Parameter> = Instance::from_entity_unchecked(parameter_entity);
        data_provider.add_parameter(
            FixtureRef {
                fixture_uid: fixture.identifiers.uid,
                index: Some(1),
            },
            Attribute::Red,
            parameter,
        );
    }

    // Create layers with different values
    let layer1 = create_test_layer(1, parameter_entity, 100.0);
    let layer2 = create_test_layer(2, parameter_entity, 50.0);

    app.world_mut().spawn((
        ObjectRefMarker(ObjectRef::ById {
            object_type: ObjectType::Cue,
            id: 1,
        }),
        layer1,
    ));
    app.world_mut().spawn((
        ObjectRefMarker(ObjectRef::ById {
            object_type: ObjectType::Cue,
            id: 2,
        }),
        layer2,
    ));
    app.add_systems(Update, compositor::<Parameter>);
    app.update();

    // With LTP and different priorities, the higher priority layer's value wins
    let param = app.world().get::<Parameter>(parameter_entity).unwrap();
    assert_eq!(param.values.current_value, 50.0);
}

#[test]
fn test_compositor_handles_missing_parameters_gracefully() {
    let mut app = App::new();
    app.insert_resource(FixtureDataProviderExt::default());
    app.init_resource::<FinalLayerAttributedAssertions>();

    // Create a layer that references a non-existent parameter
    let layer = Layer::new("test".to_owned(), Priority(1));

    // This should not panic
    app.world_mut().spawn(layer);
    app.add_systems(Update, compositor::<Parameter>);
    app.update();

    // The test passes if we get here without panicking
}

#[test]
fn test_compositor_resets_to_default_after_layer_removal() {
    let mut app = App::new();
    let data_provider = FixtureDataProviderExt::default();
    app.insert_resource(data_provider);
    app.init_resource::<FinalLayerAttributedAssertions>();

    let metadata = ParameterMetadata {
        resolution: DmxValueResolution::Coarse,
        attribute: Attribute::Red,
        native_unit: Attribute::Red.native_unit(),
        value_polarity: Attribute::Red.value_polarity(),
        min: 0.0,
        max: 255.0,
        offset: ParameterValue::Absolute { value: 0.0 },
        is_inverted: false,
        is_snap: false,
        merge_type: MergeStrategy::LTP,
        use_grandmaster: false,
    };

    let fixture = Fixture {
        identifiers: Identifiers {
            id: 1,
            uid: uuid::Uuid::new_v4(),
            label: "test".to_string(),
        },
        make: "test".to_string(),
        model: "test".to_string(),
        elements: vec![FixtureElement {
            label: "test fixture".to_owned(),
            parameters: vec![metadata.clone()],
        }],
        ..Default::default()
    };

    let mut values = ParameterValues::default();
    values.default_value = 11.0;
    let parameter_entity = app
        .world_mut()
        .spawn(Parameter {
            metadata: metadata.clone(),
            values,
        })
        .id();

    unsafe {
        let mut data_provider = app
            .world_mut()
            .get_resource_mut::<FixtureDataProviderExt>()
            .unwrap();
        let _ = data_provider.inner.add(fixture.clone());

        let parameter: Instance<Parameter> = Instance::from_entity_unchecked(parameter_entity);
        data_provider.add_parameter(
            FixtureRef {
                fixture_uid: fixture.identifiers.uid,
                index: Some(1),
            },
            Attribute::Red,
            parameter,
        );
    }

    let layer_entity = app
        .world_mut()
        .spawn((
            ObjectRefMarker(ObjectRef::ById {
                object_type: ObjectType::Cue,
                id: 1,
            }),
            create_test_layer(1, parameter_entity, 120.0),
        ))
        .id();

    app.add_systems(Update, compositor::<Parameter>);
    app.update();

    let param = app.world().get::<Parameter>(parameter_entity).unwrap();
    assert_eq!(param.values.current_value, 120.0);

    app.world_mut().despawn(layer_entity);
    app.world_mut()
        .get_mut::<Parameter>(parameter_entity)
        .unwrap()
        .set_raw_value(200.0);
    app.update();

    let param = app.world().get::<Parameter>(parameter_entity).unwrap();
    assert_eq!(
        param.values.current_value, 11.0,
        "expected compositor to reset unasserted parameters to their defaults"
    );
}

#[test]
fn test_compositor_resets_inverted_parameter_to_logical_default() {
    let mut app = App::new();
    app.insert_resource(FixtureDataProviderExt::default());
    app.init_resource::<FinalLayerAttributedAssertions>();

    let metadata = ParameterMetadata {
        resolution: DmxValueResolution::Coarse,
        attribute: Attribute::Red,
        native_unit: Attribute::Red.native_unit(),
        value_polarity: Attribute::Red.value_polarity(),
        min: 0.0,
        max: 255.0,
        offset: ParameterValue::Absolute { value: 0.0 },
        is_inverted: true,
        is_snap: false,
        merge_type: MergeStrategy::LTP,
        use_grandmaster: false,
    };
    let values = ParameterValues {
        default_value: 11.0,
        current_value: 200.0,
        highlight_value: 0.0,
    };
    let parameter_entity = app.world_mut().spawn(Parameter { metadata, values }).id();

    app.add_systems(Update, compositor::<Parameter>);
    app.update();

    let param = app.world().get::<Parameter>(parameter_entity).unwrap();
    assert_eq!(
        param.values.current_value, 11.0,
        "expected compositor to restore the logical default"
    );
    assert_eq!(
        param.get_raw_value(),
        244.0,
        "expected inverted DMX output to be derived from the logical default"
    );
}

/// Builds an app with a manual assertion layer and one 16-bit parameter at `value`, returning
/// the parameter entity. `components` supply the parameter's resolved console/wire addresses.
fn manual_channel_app(value: f32, components: impl Bundle) -> (App, Entity) {
    let mut app = App::new();
    app.add_message::<CommandEnvelope<FixtureCommand>>();
    app.add_message::<EngineActionEnvelope<ClearDmxChannels>>();
    app.add_message::<EngineActionEnvelope<PlaybackAction>>();
    app.add_message::<EngineActionEnvelope<DmxAction>>();
    init_command_lifecycle(&mut app);
    app.insert_resource(FixtureDataProviderExt::default());
    app.insert_resource(ConsoleDmxUniverses::default());
    app.init_resource::<FinalLayerAttributedAssertions>();

    let metadata = ParameterMetadata {
        attribute: Attribute::Pan,
        resolution: DmxValueResolution::Fine,
        min: 0.0,
        max: 65535.0,
        ..Default::default()
    };
    let fixture = Fixture {
        identifiers: Identifiers {
            id: 1,
            uid: uuid::Uuid::new_v4(),
            label: "mover".to_string(),
        },
        elements: vec![FixtureElement {
            label: "mover".to_owned(),
            parameters: vec![metadata.clone()],
        }],
        ..Default::default()
    };
    let parameter_entity = app
        .world_mut()
        .spawn((
            Parameter {
                metadata: metadata.clone(),
                values: ParameterValues {
                    default_value: value,
                    current_value: value,
                    ..Default::default()
                },
            },
            components,
        ))
        .id();
    {
        let mut data_provider = app.world_mut().resource_mut::<FixtureDataProviderExt>();
        let _ = data_provider.inner.add(fixture.clone());
        // SAFETY: the entity was just spawned with a `Parameter` component.
        let parameter: Instance<Parameter> =
            unsafe { Instance::from_entity_unchecked(parameter_entity) };
        data_provider.add_parameter(
            FixtureRef {
                fixture_uid: fixture.identifiers.uid,
                index: Some(1),
            },
            metadata.attribute,
            parameter,
        );
    }
    app.world_mut().spawn((
        Layer::new("test manual".to_string(), MANUAL_ASSERTION_LAYER_PRIORITY),
        ManualAssertionLayer,
        ObjectRefMarker(ObjectRef::ById {
            object_type: ObjectType::Parameter,
            id: 1,
        }),
    ));
    app.add_systems(
        Update,
        (
            nightfall_fixtures::events::handle_set_dmx_channels,
            nightfall_fixtures::compositor::update_manual_assertion_layer,
            compositor::<Parameter>,
        )
            .chain(),
    );
    (app, parameter_entity)
}

/// Sends `ch universe/address @ value` and returns the parameter's resulting value.
fn set_manual_channel(
    app: &mut App,
    parameter_entity: Entity,
    universe: u16,
    address: u16,
    value: u8,
) -> f32 {
    write_tracked_fixture_command(
        app,
        FixtureCommand::SetDmxChannels {
            channels: DmxChannelExpr::Single(DmxChannelRef { universe, address }),
            value,
        },
    );
    app.update();
    app.world()
        .get::<Parameter>(parameter_entity)
        .unwrap()
        .values
        .current_value
}

/// `ch U/A` addresses console-bound parameters by console address: the coarse write keeps
/// the current fine byte, and the parameter's wire coordinates do not match.
#[test]
fn test_manual_dmx_channel_uses_console_address_for_console_bound_parameter() {
    let (mut app, parameter) = manual_channel_app(
        0x1234 as f32,
        (
            ResolvedConsoleDestination {
                address: Some(ConsoleDmxAddress {
                    universe: 2,
                    address: 121,
                }),
            },
            ResolvedOutputDestinations {
                destinations: vec![OutputDestination {
                    transport: OutputTransport::Sacn {
                        mode: SacnDelivery::Multicast,
                    },
                    universe: 10,
                    address: 121,
                }],
            },
        ),
    );

    assert_eq!(
        set_manual_channel(&mut app, parameter, 10, 121, 0x05),
        0x1234 as f32,
        "wire coordinates must not address a console-bound parameter"
    );
    assert_eq!(
        set_manual_channel(&mut app, parameter, 2, 121, 0x80),
        0x8034 as f32,
        "coarse write must keep the current fine byte"
    );
    assert_eq!(
        set_manual_channel(&mut app, parameter, 2, 122, 0x56),
        0x8056 as f32
    );
}

/// Parameters without a console address stay addressable by their direct wire patch, and a
/// coarse write keeps the current fine byte instead of reading an unrelated console channel.
#[test]
fn test_manual_dmx_channel_falls_back_to_wire_address_for_direct_patch() {
    let (mut app, parameter) = manual_channel_app(
        0x1234 as f32,
        ResolvedOutputDestinations {
            destinations: vec![OutputDestination {
                transport: OutputTransport::Sacn {
                    mode: SacnDelivery::Multicast,
                },
                universe: 1,
                address: 5,
            }],
        },
    );

    assert_eq!(
        set_manual_channel(&mut app, parameter, 1, 5, 0x80),
        0x8034 as f32
    );
}

#[test]
fn test_manual_dmx_channel_command_materializes_after_input_layer() {
    let mut app = App::new();
    app.add_message::<CommandEnvelope<FixtureCommand>>();
    app.add_message::<EngineActionEnvelope<ClearDmxChannels>>();
    app.add_message::<EngineActionEnvelope<PlaybackAction>>();
    app.add_message::<EngineActionEnvelope<DmxAction>>();
    app.add_message::<CommandResult>();
    app.add_message::<CommandReply>();
    app.add_message::<FinishedCommand>();
    app.add_message::<CommandNotice>();
    app.init_resource::<CommandTracker>();
    app.insert_resource(FixtureDataProviderExt::default());
    app.insert_resource(ConsoleDmxUniverses::default());
    app.init_resource::<FinalLayerAttributedAssertions>();

    let metadata = ParameterMetadata {
        resolution: DmxValueResolution::Coarse,
        min: 0.0,
        max: 255.0,
        ..Default::default()
    };
    let fixture = Fixture {
        identifiers: Identifiers {
            id: 1,
            uid: uuid::Uuid::new_v4(),
            label: "test".to_string(),
        },
        make: "test".to_string(),
        model: "test".to_string(),
        elements: vec![FixtureElement {
            label: "test fixture".to_owned(),
            parameters: vec![metadata.clone()],
        }],
        ..Default::default()
    };

    let mut values = ParameterValues::default();
    values.default_value = 7.0;
    let parameter_entity = app
        .world_mut()
        .spawn((
            Parameter {
                metadata: metadata.clone(),
                values,
            },
            ResolvedOutputDestinations {
                destinations: vec![OutputDestination {
                    transport: OutputTransport::Disabled,
                    universe: 5,
                    address: 13,
                }],
            },
        ))
        .id();

    unsafe {
        let mut data_provider = app
            .world_mut()
            .get_resource_mut::<FixtureDataProviderExt>()
            .unwrap();
        let _ = data_provider.inner.add(fixture.clone());

        let parameter: Instance<Parameter> = Instance::from_entity_unchecked(parameter_entity);
        data_provider.add_parameter(
            FixtureRef {
                fixture_uid: fixture.identifiers.uid,
                index: Some(1),
            },
            metadata.attribute,
            parameter,
        );
    }

    app.world_mut().spawn((
        Layer::new(
            "test transport input".to_string(),
            TRANSPORT_INPUT_LAYER_PRIORITY,
        ),
        TransportInputLayer,
        ObjectRefMarker(ObjectRef::ById {
            object_type: ObjectType::Parameter,
            id: 0,
        }),
    ));
    app.world_mut().spawn((
        Layer::new("test manual".to_string(), MANUAL_ASSERTION_LAYER_PRIORITY),
        ManualAssertionLayer,
        ObjectRefMarker(ObjectRef::ById {
            object_type: ObjectType::Parameter,
            id: 1,
        }),
    ));

    app.add_systems(
        Update,
        (
            nightfall_fixtures::events::handle_set_dmx_channels,
            nightfall_fixtures::events::handle_clear_dmx_channels,
            nightfall_fixtures::compositor::update_manual_assertion_layer,
            compositor::<Parameter>,
        )
            .chain(),
    );

    write_tracked_fixture_command(
        &mut app,
        FixtureCommand::SetDmxChannels {
            channels: DmxChannelExpr::Single(DmxChannelRef {
                universe: 5,
                address: 13,
            }),
            value: 200,
        },
    );
    app.update();

    let parameter = app.world().get::<Parameter>(parameter_entity).unwrap();
    assert_eq!(parameter.values.current_value, 200.0);
    assert!(MANUAL_ASSERTION_LAYER_PRIORITY.0 > TRANSPORT_INPUT_LAYER_PRIORITY.0);

    app.world_mut()
        .write_message(EngineActionEnvelope::detached(ClearDmxChannels(
            DmxChannelSnapshot {
                channels: DmxChannelExpr::Single(DmxChannelRef {
                    universe: 5,
                    address: 13,
                }),
                value: 200,
            },
        )));
    app.update();

    let parameter = app.world().get::<Parameter>(parameter_entity).unwrap();
    assert_eq!(parameter.values.current_value, 7.0);

    write_tracked_fixture_command(
        &mut app,
        FixtureCommand::SetDmxChannels {
            channels: DmxChannelExpr::Single(DmxChannelRef {
                universe: 5,
                address: 13,
            }),
            value: 111,
        },
    );
    app.update();

    let parameter = app.world().get::<Parameter>(parameter_entity).unwrap();
    assert_eq!(parameter.values.current_value, 111.0);

    app.world_mut()
        .write_message(EngineActionEnvelope::detached(
            PlaybackAction::ReleaseParameters {
                scope: PlaybackScope::All,
            },
        ));
    app.update();

    let parameter = app.world().get::<Parameter>(parameter_entity).unwrap();
    assert_eq!(parameter.values.current_value, 7.0);

    let world = app.world_mut();
    let mut layer_query = world.query_filtered::<&Layer, With<ManualAssertionLayer>>();
    let layer = layer_query
        .single(&world)
        .expect("expected manual assertion layer");
    assert!(layer.absolute.is_empty());
    assert!(layer.relative.is_empty());
}
