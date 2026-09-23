// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::{collections::HashMap, time::Duration};

use bevy_app::prelude::*;
use bevy_ecs::prelude::*;
use moonshine_kind::prelude::*;
use nightfall::prelude::*;
use nightfall_compositor::prelude::*;
use nightfall_cues::prelude::*;
use nightfall_dmx::prelude::*;
use nightfall_engine::prelude::DataProvider;
use nightfall_fixtures::prelude::*;
use nightfall_instances::{InstanceClock, Owner};
use nightfall_programmer::painter::materialize_and_paint_programmer;
use nightfall_programmer::prelude::*;
use uuid::Uuid;

/// Helper function to create a test app with all necessary resources and systems
fn create_test_app() -> App {
    let mut app = App::new();

    // Add required resources
    app.init_resource::<Programmer>();
    app.init_resource::<FixtureDataProviderExt>();
    app.init_resource::<DataProvider<Group>>(); // Required by SelectionResolver

    // Add the painter system
    app.add_systems(Update, materialize_and_paint_programmer);

    app
}

/// Helper function to create a test app that runs programmer painting through compositing.
fn create_compositor_test_app() -> App {
    let mut app = App::new();

    app.init_resource::<Programmer>();
    app.init_resource::<FixtureDataProviderExt>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FinalLayerAttributedAssertions>();

    app.add_systems(
        Update,
        (
            materialize_and_paint_programmer,
            ApplyDeferred,
            compositor::<Parameter>,
            ApplyDeferred,
        )
            .chain(),
    );

    app
}

/// Helper function to create a simple bound instruction for testing
fn create_test_instruction() -> BoundCueInstruction {
    let mut values = HashMap::new();
    values.insert(
        Attribute::Intensity,
        ValueSource::Inline(ParameterValue::Absolute { value: 128.0 }),
    );

    BoundCueInstruction {
        selection: SelectionExpr::Fixture(UnresolvedFixtureRef {
            fixture_id: 1,
            element_index: None,
        })
        .into(),
        cue_instruction: CueInstruction {
            blueprint_application: None,
            values,
            transitions_by_attribute: Default::default(),
            transitions_by_fixture_attribute: Default::default(),
            transitions: Default::default(),
            color_path_id: None,
        },
    }
}

/// Helper function to create a resolved fixture reference for a test fixture id.
fn test_fixture_ref(fixture_id: u32) -> FixtureRef {
    FixtureRef {
        fixture_uid: Uuid::from_u128(fixture_id as u128),
        index: Some(1),
    }
}

/// Helper function to build red parameter metadata for materialized output tests.
fn red_parameter_metadata() -> ParameterMetadata {
    ParameterMetadata {
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
    }
}

/// Helper function to insert one single-element RGB fixture and return its red parameter.
fn insert_red_fixture(app: &mut App, fixture_id: u32) -> Instance<Parameter> {
    let metadata = red_parameter_metadata();
    let fixture = Fixture {
        identifiers: Identifiers {
            id: fixture_id,
            uid: Uuid::from_u128(fixture_id as u128),
            label: format!("Fixture {fixture_id}"),
        },
        make: "Test".to_string(),
        model: "RGB".to_string(),
        mode: "Mode".to_string(),
        elements: vec![FixtureElement {
            label: "Main".to_string(),
            parameters: vec![metadata.clone()],
        }],
        ..Default::default()
    };

    let parameter_entity = app
        .world_mut()
        .spawn(Parameter {
            metadata,
            values: Default::default(),
        })
        .id();

    // SAFETY: the entity was spawned in this world with a Parameter component.
    let parameter = unsafe { Instance::<Parameter>::from_entity_unchecked(parameter_entity) };
    let mut fixtures = app.world_mut().resource_mut::<FixtureDataProviderExt>();
    fixtures.inner.add(fixture).expect("fixture should insert");
    fixtures.add_parameter(test_fixture_ref(fixture_id), Attribute::Red, parameter);

    parameter
}

/// Helper function to insert a group containing one fixture reference.
fn insert_group_for_fixture(app: &mut App, group_id: u32, fixture_id: u32) {
    app.world_mut()
        .resource_mut::<DataProvider<Group>>()
        .add(Group {
            identifiers: Identifiers {
                id: group_id,
                uid: Uuid::from_u128(10_000 + group_id as u128),
                label: format!("Group {group_id}"),
            },
            selection: SpatialSelection::identity(SelectionExpr::Resolved(vec![test_fixture_ref(
                fixture_id,
            )])),
            description: String::new(),
        })
        .expect("group should insert");
}

/// Helper function to set all programmer playback clocks to a deterministic position.
fn set_instance_clock_position(app: &mut App, position: Duration) {
    let mut query = app.world_mut().query::<&mut InstanceClock>();
    for mut clock in query.iter_mut(app.world_mut()) {
        clock.previous_position = clock.position;
        clock.position = position;
        clock.delta = position.saturating_sub(clock.previous_position);
    }
}

/// Helper function to read a parameter's current output value.
fn parameter_value(app: &App, parameter: Instance<Parameter>) -> f64 {
    app.world()
        .get::<Parameter>(parameter.entity())
        .expect("parameter should exist")
        .values
        .current_value
}

/// Helper function to count MaterializedCue entities with a specific UUID
fn count_materialized_cues_for_uuid(world: &mut World, uuid: &Uuid) -> usize {
    let mut query = world.query::<&MaterializedCue>();
    query
        .iter(world)
        .filter(|mcue| mcue.cue.identifiers().uid == *uuid)
        .count()
}

/// Verifies fanned programmer fades advance in live output for group selections.
#[test]
fn programmer_group_range_fade_outputs_interpolated_red_values() {
    let mut app = create_compositor_test_app();
    let red_1 = insert_red_fixture(&mut app, 1);
    let red_2 = insert_red_fixture(&mut app, 2);
    let red_3 = insert_red_fixture(&mut app, 3);
    for id in 1..=3 {
        insert_group_for_fixture(&mut app, id, id);
    }

    let mut values = HashMap::new();
    values.insert(
        Attribute::Red,
        ValueSource::Inline(ParameterValue::Absolute { value: 255.0 }),
    );
    let interpolated_fade = TransitionMode::Interpolated {
        start: Duration::from_secs(1),
        end: Duration::from_secs(3),
    };

    app.world_mut()
        .resource_mut::<Programmer>()
        .add_instruction(BoundCueInstruction {
            selection: SelectionExpr::Group(GroupRefExpr::RangeById { start: 1, end: 3 }).into(),
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values,
                transitions: PartialTransition {
                    fade_in: Some(interpolated_fade.clone()),
                    ..Default::default()
                },
                transitions_by_attribute: Default::default(),
                transitions_by_fixture_attribute: Default::default(),
                color_path_id: None,
            },
        });

    app.update();
    set_instance_clock_position(&mut app, Duration::from_millis(500));
    app.update();

    let fixture_1_red = parameter_value(&app, red_1);
    let fixture_2_red = parameter_value(&app, red_2);
    let fixture_3_red = parameter_value(&app, red_3);

    assert!(
        fixture_1_red > fixture_2_red && fixture_2_red > fixture_3_red && fixture_3_red > 0.0,
        "expected fanned fade values to be non-zero and ordered 1s>2s>3s at 500ms, got {fixture_1_red}, {fixture_2_red}, {fixture_3_red}"
    );
    assert!(
        (fixture_1_red - 127.5).abs() < 0.01,
        "expected group 1 to be halfway through a 1s fade, got {fixture_1_red}"
    );
    assert!(
        (fixture_2_red - 63.75).abs() < 0.01,
        "expected group 2 to be one quarter through a 2s fade, got {fixture_2_red}"
    );
    assert!(
        (fixture_3_red - 42.5).abs() < 0.01,
        "expected group 3 to be one sixth through a 3s fade, got {fixture_3_red}"
    );
}

/// Verifies authored fade-out timing does not delay programmer release after clear.
#[test]
fn programmer_clear_after_fade_out_releases_without_timing() {
    let mut app = create_compositor_test_app();
    let red = insert_red_fixture(&mut app, 1);

    let mut values = HashMap::new();
    values.insert(
        Attribute::Red,
        ValueSource::Inline(ParameterValue::Absolute { value: 255.0 }),
    );

    app.world_mut()
        .resource_mut::<Programmer>()
        .add_instruction(BoundCueInstruction {
            selection: SelectionExpr::Fixture(UnresolvedFixtureRef {
                fixture_id: 1,
                element_index: None,
            })
            .into(),
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values,
                transitions: PartialTransition {
                    fade_out: Some(TransitionMode::Fixed(Duration::from_secs(5))),
                    ..Default::default()
                },
                transitions_by_attribute: Default::default(),
                transitions_by_fixture_attribute: Default::default(),
                color_path_id: None,
            },
        });

    app.update();
    set_instance_clock_position(&mut app, Duration::from_secs(5));
    app.update();
    assert!(
        (parameter_value(&app, red) - 255.0).abs() < 0.01,
        "expected red to reach full value before clear"
    );

    app.world_mut().resource_mut::<Programmer>().clear();
    app.update();

    assert!(
        parameter_value(&app, red) < 0.01,
        "expected clear to release red immediately without honoring authored fade-out timing"
    );
}

#[test]
fn test_painter_creates_layer_for_new_instruction() {
    let mut app = create_test_app();

    // Add an instruction to the programmer
    let instruction_uuid = {
        let mut programmer = app.world_mut().resource_mut::<Programmer>();
        programmer.add_instruction(create_test_instruction())
    };

    // Run one frame to materialize the instruction
    app.update();

    // Verify exactly one MaterializedCue entity was created
    let count = count_materialized_cues_for_uuid(app.world_mut(), &instruction_uuid);
    assert_eq!(
        count, 1,
        "Expected exactly 1 MaterializedCue entity for new instruction, found {}",
        count
    );

    // Verify the entity has the correct components
    let mut query = app
        .world_mut()
        .query_filtered::<(Entity, &MaterializedCue, &Layer, &Owner), With<MaterializedCue>>();

    let entities: Vec<_> = query
        .iter(app.world())
        .filter(|(_, mcue, _, _)| mcue.cue.identifiers().uid == instruction_uuid)
        .collect();

    assert_eq!(
        entities.len(),
        1,
        "Expected exactly one entity with all required components"
    );

    let (_, mcue, layer, owner) = entities[0];

    // Verify the MaterializedCue has correct priority
    assert_eq!(
        mcue.priority,
        Priority(127),
        "Programmer MaterializedCue should have priority 127"
    );

    // Verify the Layer has correct priority
    assert_eq!(
        layer.priority,
        Priority(127),
        "Programmer Layer should have priority 127"
    );

    // Verify the Owner component references the Programmer's UID (not the instruction UUID)
    // The programmer owns all its instructions' layers
    let programmer_uid = app.world().resource::<Programmer>().identifiers().uid;
    assert_eq!(
        owner.0, programmer_uid,
        "Owner component should reference the Programmer UID"
    );
}

#[test]
fn test_painter_does_not_duplicate_layers_across_frames() {
    let mut app = create_test_app();

    // Add an instruction to the programmer
    let instruction_uuid = {
        let mut programmer = app.world_mut().resource_mut::<Programmer>();
        programmer.add_instruction(create_test_instruction())
    };

    // Run first frame
    app.update();
    let count_after_frame_1 = count_materialized_cues_for_uuid(app.world_mut(), &instruction_uuid);
    assert_eq!(
        count_after_frame_1, 1,
        "Expected exactly 1 MaterializedCue entity after first frame, found {}",
        count_after_frame_1
    );

    // Run second frame
    app.update();
    let count_after_frame_2 = count_materialized_cues_for_uuid(app.world_mut(), &instruction_uuid);
    assert_eq!(
        count_after_frame_2, 1,
        "Expected exactly 1 MaterializedCue entity after second frame (no duplication), found {}",
        count_after_frame_2
    );

    // Run third frame
    app.update();
    let count_after_frame_3 = count_materialized_cues_for_uuid(app.world_mut(), &instruction_uuid);
    assert_eq!(
        count_after_frame_3, 1,
        "Expected exactly 1 MaterializedCue entity after third frame (no duplication), found {}",
        count_after_frame_3
    );

    // Run fourth frame for good measure
    app.update();
    let count_after_frame_4 = count_materialized_cues_for_uuid(app.world_mut(), &instruction_uuid);
    assert_eq!(
        count_after_frame_4, 1,
        "Expected exactly 1 MaterializedCue entity after fourth frame (no duplication), found {}",
        count_after_frame_4
    );
}

#[test]
fn test_painter_updates_existing_layer_when_instruction_changes() {
    let mut app = create_test_app();

    // Add an instruction with initial value
    let instruction_uuid = {
        let mut programmer = app.world_mut().resource_mut::<Programmer>();
        programmer.add_instruction(create_test_instruction())
    };

    // Run first frame
    app.update();

    // Get the initial MaterializedCue UUID
    let initial_mcue_uid = {
        let mut query = app.world_mut().query::<&MaterializedCue>();
        query
            .iter(app.world_mut())
            .find(|mcue| mcue.cue.identifiers().uid == instruction_uuid)
            .expect("MaterializedCue should exist")
            .cue
            .identifiers()
            .uid
    };
    {
        let mut query = app.world_mut().query::<&mut MaterializedCue>();
        let mut mcue = query
            .iter_mut(app.world_mut())
            .find(|mcue| mcue.cue.identifiers().uid == instruction_uuid)
            .expect("MaterializedCue should exist before update");
        mcue.set_start_position(Duration::from_millis(650));
    }

    // Modify the instruction (change intensity value)
    {
        let mut values = HashMap::new();
        values.insert(
            Attribute::Intensity,
            ValueSource::Inline(ParameterValue::Absolute { value: 255.0 }), // Changed from 128
        );

        let mut programmer = app.world_mut().resource_mut::<Programmer>();
        programmer.add_instruction(BoundCueInstruction {
            selection: SelectionExpr::Fixture(UnresolvedFixtureRef {
                fixture_id: 1,
                element_index: None,
            })
            .into(),
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values,
                transitions_by_attribute: Default::default(),
                transitions_by_fixture_attribute: Default::default(),
                transitions: Default::default(),
                color_path_id: None,
            },
        });
    }

    // Run another frame
    app.update();

    // Verify still only one entity exists
    let count = count_materialized_cues_for_uuid(app.world_mut(), &instruction_uuid);
    assert_eq!(
        count, 1,
        "Expected exactly 1 MaterializedCue entity after updating instruction, found {}",
        count
    );

    // Verify the MaterializedCue was updated (not replaced)
    let updated_mcue_uid = {
        let mut query = app.world_mut().query::<&MaterializedCue>();
        query
            .iter(app.world_mut())
            .find(|mcue| mcue.cue.identifiers().uid == instruction_uuid)
            .expect("MaterializedCue should still exist")
            .cue
            .identifiers()
            .uid
    };
    let updated_start_position = {
        let mut query = app.world_mut().query::<&MaterializedCue>();
        query
            .iter(app.world_mut())
            .find(|mcue| mcue.cue.identifiers().uid == instruction_uuid)
            .expect("MaterializedCue should still exist")
            .start_position
    };

    // The cue should have been updated with new instruction
    assert_eq!(
        updated_mcue_uid, initial_mcue_uid,
        "MaterializedCue UUID should remain the same"
    );
    assert_eq!(
        updated_start_position,
        Duration::from_millis(650),
        "MaterializedCue source-local start position should survive rebuild"
    );
}

#[test]
fn test_painter_handles_multiple_instructions_correctly() {
    let mut app = create_test_app();

    // Add three different instructions
    let uuid1 = {
        let mut values = HashMap::new();
        values.insert(
            Attribute::Intensity,
            ValueSource::Inline(ParameterValue::Absolute { value: 128.0 }),
        );

        let mut programmer = app.world_mut().resource_mut::<Programmer>();
        programmer.add_instruction(BoundCueInstruction {
            selection: SelectionExpr::Fixture(UnresolvedFixtureRef {
                fixture_id: 1,
                element_index: None,
            })
            .into(),
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values,
                transitions_by_attribute: Default::default(),
                transitions_by_fixture_attribute: Default::default(),
                transitions: Default::default(),
                color_path_id: None,
            },
        })
    };

    let uuid2 = {
        let mut values = HashMap::new();
        values.insert(
            Attribute::Intensity,
            ValueSource::Inline(ParameterValue::Absolute { value: 192.0 }),
        );

        let mut programmer = app.world_mut().resource_mut::<Programmer>();
        programmer.add_instruction(BoundCueInstruction {
            selection: SelectionExpr::Fixture(UnresolvedFixtureRef {
                fixture_id: 2,
                element_index: None,
            })
            .into(),
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values,
                transitions_by_attribute: Default::default(),
                transitions_by_fixture_attribute: Default::default(),
                transitions: Default::default(),
                color_path_id: None,
            },
        })
    };

    let uuid3 = {
        let mut values = HashMap::new();
        values.insert(
            Attribute::Red,
            ValueSource::Inline(ParameterValue::Absolute { value: 255.0 }),
        );

        let mut programmer = app.world_mut().resource_mut::<Programmer>();
        programmer.add_instruction(BoundCueInstruction {
            selection: SelectionExpr::Fixture(UnresolvedFixtureRef {
                fixture_id: 3,
                element_index: None,
            })
            .into(),
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values,
                transitions_by_attribute: Default::default(),
                transitions_by_fixture_attribute: Default::default(),
                transitions: Default::default(),
                color_path_id: None,
            },
        })
    };

    // Run multiple frames
    app.update();
    app.update();
    app.update();

    // Verify each instruction has exactly one MaterializedCue
    let count1 = count_materialized_cues_for_uuid(app.world_mut(), &uuid1);
    let count2 = count_materialized_cues_for_uuid(app.world_mut(), &uuid2);
    let count3 = count_materialized_cues_for_uuid(app.world_mut(), &uuid3);

    assert_eq!(
        count1, 1,
        "Expected exactly 1 MaterializedCue for instruction 1, found {}",
        count1
    );
    assert_eq!(
        count2, 1,
        "Expected exactly 1 MaterializedCue for instruction 2, found {}",
        count2
    );
    assert_eq!(
        count3, 1,
        "Expected exactly 1 MaterializedCue for instruction 3, found {}",
        count3
    );

    // Verify total count
    let total_count = app
        .world_mut()
        .query::<&MaterializedCue>()
        .iter(app.world_mut())
        .count();

    assert_eq!(
        total_count, 3,
        "Expected exactly 3 total MaterializedCue entities, found {}",
        total_count
    );
}

#[test]
fn test_painter_no_layers_when_no_instructions() {
    let mut app = create_test_app();

    // Run multiple frames without adding any instructions
    app.update();
    app.update();
    app.update();

    // Verify no MaterializedCue entities were created
    let total_count = app
        .world_mut()
        .query::<&MaterializedCue>()
        .iter(app.world_mut())
        .count();

    assert_eq!(
        total_count, 0,
        "Expected no MaterializedCue entities when programmer has no instructions, found {}",
        total_count
    );
}

/// Ensures clearing programmer state releases the materialized instruction layer.
#[test]
fn test_painter_releases_layer_after_instruction_clear() {
    let mut app = create_test_app();

    let instruction_uuid = {
        let mut programmer = app.world_mut().resource_mut::<Programmer>();
        programmer.add_instruction(create_test_instruction())
    };

    app.update();

    {
        let mut programmer = app.world_mut().resource_mut::<Programmer>();
        programmer.clear();
    }

    app.update();

    let mut query = app
        .world_mut()
        .query::<(&MaterializedCue, Option<&ReleaseMarker>)>();
    let release_markers = query
        .iter(app.world())
        .filter(|(mcue, _)| mcue.cue.identifiers().uid == instruction_uuid)
        .map(|(_, release_marker)| release_marker.is_some())
        .collect::<Vec<_>>();

    assert_eq!(
        release_markers,
        vec![true],
        "Expected cleared programmer instruction layer to be marked for release"
    );
}
