// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::collections::HashMap;

use bevy_app::prelude::*;
use bevy_ecs::system::SystemState;
use moonshine_kind::prelude::Instance;
use nightfall_desk::prelude::BlueprintDefinitionChange;
use nightfall_engine::prelude::DataProvider;
use nightfall_fixtures::selection::SpatialSelectionResolver;
use uuid::Uuid;

use super::*;
use crate::cue::FixtureAttributeTransition;

fn spawn_parameter(
    world: &mut World,
    attribute: Attribute,
    min: ParameterDmxValue,
    max: ParameterDmxValue,
) -> Instance<Parameter> {
    let parameter_entity = world
        .spawn(Parameter {
            metadata: ParameterMetadata {
                attribute,
                min,
                max,
                resolution: DmxValueResolution::Coarse,
                ..Default::default()
            },
            values: Default::default(),
        })
        .id();

    // SAFETY: parameter_entity was spawned in this world with a Parameter component.
    unsafe { Instance::from_entity_unchecked(parameter_entity) }
}

fn add_single_element_fixture(
    world: &mut World,
    fixture_id: u32,
    attributes: &[(Attribute, ParameterDmxValue, ParameterDmxValue)],
) -> (FixtureRef, HashMap<Attribute, Instance<Parameter>>) {
    let fixture_uid = Uuid::new_v4();
    let fixture = Fixture {
        identifiers: Identifiers {
            id: fixture_id,
            uid: fixture_uid,
            label: format!("Fixture {fixture_id}"),
        },
        make: "test".to_owned(),
        model: "single-element".to_owned(),
        mode: "default".to_owned(),
        elements: vec![FixtureElement {
            label: "Element 1".to_owned(),
            parameters: attributes
                .iter()
                .map(|(attribute, min, max)| ParameterMetadata {
                    attribute: attribute.clone(),
                    native_unit: attribute.clone().native_unit(),
                    value_polarity: attribute.clone().value_polarity(),
                    min: *min,
                    max: *max,
                    ..Default::default()
                })
                .collect(),
        }],
        ..Default::default()
    };

    world
        .resource_mut::<FixtureDataProviderExt>()
        .inner
        .add(fixture)
        .expect("fixture should be insertable");

    let fixture_ref = FixtureRef {
        fixture_uid,
        index: Some(1),
    };
    let mut parameters = HashMap::new();

    for (attribute, min, max) in attributes {
        let parameter = spawn_parameter(world, attribute.clone(), *min, *max);
        world.resource::<FixtureDataProviderExt>().add_parameter(
            fixture_ref.clone(),
            attribute.clone(),
            parameter,
        );
        parameters.insert(attribute.clone(), parameter);
    }

    (fixture_ref, parameters)
}

fn make_materialized_cue(world: &mut World, cue: &Cue) -> (MaterializedCue, Vec<FixtureRef>) {
    let fixtures = match &cue.instructions[0].selection.source {
        SelectionExpr::Resolved(fixtures) => fixtures.clone(),
        other => panic!("expected resolved test selection, got {other:?}"),
    };

    let mut system_state = SystemState::<(
        Res<FixtureDataProviderExt>,
        SpatialSelectionResolver,
        Query<InstanceRef<Parameter>>,
    )>::new(world);
    let (fixture_data_provider, selection_resolver, parameter_query) = system_state
        .get(world)
        .expect("test system parameters should be available");

    let materialized = MaterializedCue::materialize(
        cue,
        &fixture_data_provider,
        &parameter_query,
        &selection_resolver,
    );

    (materialized, fixtures)
}

/// Materializes a cue with the test world's current Blueprint definitions.
fn make_materialized_cue_with_blueprints(world: &mut World, cue: &Cue) -> MaterializedCue {
    let mut system_state = SystemState::<(
        Res<FixtureDataProviderExt>,
        Res<DataProvider<Blueprint>>,
        SpatialSelectionResolver,
        Query<InstanceRef<Parameter>>,
    )>::new(world);
    let (fixtures, blueprints, selection_resolver, parameters) = system_state
        .get(world)
        .expect("test system parameters should be available");
    MaterializedCue::materialize_with_sources(
        cue,
        None,
        Some(&blueprints),
        &fixtures,
        &parameters,
        &selection_resolver,
    )
}

/// Reads one materialized absolute parameter value for assertions.
fn materialized_absolute_value(
    cue: &MaterializedCue,
    parameter: Instance<Parameter>,
) -> ParameterDmxValue {
    match cue
        .values
        .absolute
        .get(&parameter)
        .expect("parameter should be materialized")
        .0
    {
        ParameterValue::Absolute { value } => value,
        ref value => panic!("expected an absolute parameter value, got {value:?}"),
    }
}

/// Live category applications re-read values and category membership while absolute copies do not.
#[test]
fn blueprint_reference_is_dynamic_while_absolute_values_are_stable() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<DataProvider<Blueprint>>();
    app.init_resource::<FixtureDataProviderExt>();
    let (fixture_ref, parameters) = add_single_element_fixture(
        app.world_mut(),
        401,
        &[(Attribute::Red, 0.0, 255.0), (Attribute::Blue, 0.0, 255.0)],
    );
    let red_parameter = *parameters.get(&Attribute::Red).expect("red parameter");
    let blue_parameter = *parameters.get(&Attribute::Blue).expect("blue parameter");
    let blueprint_uid = Uuid::new_v4();
    let blueprint = Blueprint {
        identifiers: Identifiers {
            id: 5,
            uid: blueprint_uid,
            label: "Color".to_owned(),
        },
        values: HashMap::from([(
            Attribute::Red,
            ValueSource::Inline(ParameterValue::Absolute { value: 32.0 }),
        )]),
        ..Default::default()
    };
    app.world_mut()
        .resource_mut::<DataProvider<Blueprint>>()
        .add(blueprint.clone())
        .expect("blueprint should be insertable");

    let referenced_cue = Cue {
        instructions: vec![BoundCueInstruction {
            selection: SelectionExpr::Resolved(vec![fixture_ref.clone()]).into(),
            cue_instruction: CueInstruction {
                blueprint_application: Some(BlueprintApplication {
                    blueprint_uid,
                    selector: BlueprintSelector::Category(AttributeCategory::Color),
                }),
                ..Default::default()
            },
        }],
        ..Default::default()
    };
    let absolute_cue = Cue {
        instructions: vec![BoundCueInstruction {
            selection: SelectionExpr::Resolved(vec![fixture_ref]).into(),
            cue_instruction: CueInstruction {
                values: blueprint
                    .selected_values(&BlueprintSelector::Category(AttributeCategory::Color)),
                ..Default::default()
            },
        }],
        ..Default::default()
    };

    let first_reference = make_materialized_cue_with_blueprints(app.world_mut(), &referenced_cue);
    assert_eq!(
        materialized_absolute_value(&first_reference, red_parameter),
        32.0
    );
    assert!(
        !first_reference
            .values
            .absolute
            .contains_key(&blue_parameter)
    );

    let original = blueprint.clone();
    let mut updated = blueprint;
    updated.identifiers.id = 50;
    updated.identifiers.label = "Renamed Color".to_owned();
    updated.values = HashMap::from([
        (
            Attribute::Red,
            ValueSource::Inline(ParameterValue::Absolute { value: 96.0 }),
        ),
        (
            Attribute::Blue,
            ValueSource::Inline(ParameterValue::Absolute { value: 128.0 }),
        ),
    ]);
    app.world_mut()
        .resource_mut::<DataProvider<Blueprint>>()
        .add(updated.clone())
        .expect("blueprint should be updateable");

    let changed_reference = make_materialized_cue_with_blueprints(app.world_mut(), &referenced_cue);
    assert_eq!(
        materialized_absolute_value(&changed_reference, red_parameter),
        96.0
    );
    assert_eq!(
        materialized_absolute_value(&changed_reference, blue_parameter),
        128.0
    );
    let unchanged_absolute = make_materialized_cue_with_blueprints(app.world_mut(), &absolute_cue);
    assert_eq!(
        materialized_absolute_value(&unchanged_absolute, red_parameter),
        32.0
    );
    assert!(
        !unchanged_absolute
            .values
            .absolute
            .contains_key(&blue_parameter)
    );

    let mut removed_red = updated;
    removed_red.values.remove(&Attribute::Red);
    app.world_mut()
        .resource_mut::<DataProvider<Blueprint>>()
        .add(removed_red)
        .expect("Blueprint should allow category membership removal");
    let removed_reference = make_materialized_cue_with_blueprints(app.world_mut(), &referenced_cue);
    assert!(
        !removed_reference
            .values
            .absolute
            .contains_key(&red_parameter)
    );
    assert_eq!(
        materialized_absolute_value(&removed_reference, blue_parameter),
        128.0
    );

    app.world_mut()
        .resource_mut::<DataProvider<Blueprint>>()
        .add(original)
        .expect("restoring the prior Blueprint definition should succeed");
    let restored_reference =
        make_materialized_cue_with_blueprints(app.world_mut(), &referenced_cue);
    assert_eq!(
        materialized_absolute_value(&restored_reference, red_parameter),
        32.0
    );
    assert!(
        !restored_reference
            .values
            .absolute
            .contains_key(&blue_parameter)
    );
}

/// Blueprint definition events refresh affected active cue components in place.
#[test]
fn blueprint_definition_change_rematerializes_active_cue() {
    let mut app = App::new();
    app.add_message::<BlueprintDefinitionChange>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<DataProvider<Blueprint>>();
    app.init_resource::<FixtureDataProviderExt>();
    app.add_systems(
        Update,
        crate::materialized_sequence::rematerialize_after_blueprint_definition_change,
    );
    let (fixture_ref, parameters) =
        add_single_element_fixture(app.world_mut(), 402, &[(Attribute::Red, 0.0, 255.0)]);
    let red_parameter = *parameters.get(&Attribute::Red).expect("red parameter");
    let blueprint_uid = Uuid::new_v4();
    let make_blueprint = |value| Blueprint {
        identifiers: Identifiers {
            id: 8,
            uid: blueprint_uid,
            label: "Live Red".to_owned(),
        },
        values: HashMap::from([(
            Attribute::Red,
            ValueSource::Inline(ParameterValue::Absolute { value }),
        )]),
        ..Default::default()
    };
    app.world_mut()
        .resource_mut::<DataProvider<Blueprint>>()
        .add(make_blueprint(20.0))
        .expect("blueprint should be insertable");
    let cue = Cue {
        instructions: vec![BoundCueInstruction {
            selection: SelectionExpr::Resolved(vec![fixture_ref]).into(),
            cue_instruction: CueInstruction {
                blueprint_application: Some(BlueprintApplication {
                    blueprint_uid,
                    selector: BlueprintSelector::Attribute(Attribute::Red),
                }),
                ..Default::default()
            },
        }],
        ..Default::default()
    };
    let materialized = make_materialized_cue_with_blueprints(app.world_mut(), &cue);
    let entity = app.world_mut().spawn(materialized).id();

    app.world_mut()
        .resource_mut::<DataProvider<Blueprint>>()
        .add(make_blueprint(140.0))
        .expect("blueprint should be updateable");
    app.world_mut()
        .write_message(BlueprintDefinitionChange { uid: blueprint_uid });
    app.update();

    let refreshed = app
        .world()
        .get::<MaterializedCue>(entity)
        .expect("materialized cue should remain active");
    assert_eq!(materialized_absolute_value(refreshed, red_parameter), 140.0);
}

/// Blueprint rows participate in the same deterministic authored precedence as direct rows.
#[test]
fn blueprint_application_obeys_instruction_order() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<DataProvider<Blueprint>>();
    app.init_resource::<FixtureDataProviderExt>();
    let (fixture_ref, parameters) =
        add_single_element_fixture(app.world_mut(), 403, &[(Attribute::Red, 0.0, 255.0)]);
    let red_parameter = *parameters.get(&Attribute::Red).expect("red parameter");
    let blueprint_uid = Uuid::new_v4();
    app.world_mut()
        .resource_mut::<DataProvider<Blueprint>>()
        .add(Blueprint {
            identifiers: Identifiers {
                id: 9,
                uid: blueprint_uid,
                label: "Middle".to_owned(),
            },
            values: HashMap::from([(
                Attribute::Red,
                ValueSource::Inline(ParameterValue::Absolute { value: 80.0 }),
            )]),
            ..Default::default()
        })
        .expect("blueprint should be insertable");
    let direct = |value| BoundCueInstruction {
        selection: SelectionExpr::Resolved(vec![fixture_ref.clone()]).into(),
        cue_instruction: CueInstruction {
            values: HashMap::from([(
                Attribute::Red,
                ValueSource::Inline(ParameterValue::Absolute { value }),
            )]),
            ..Default::default()
        },
    };
    let reference = BoundCueInstruction {
        selection: SelectionExpr::Resolved(vec![fixture_ref.clone()]).into(),
        cue_instruction: CueInstruction {
            blueprint_application: Some(BlueprintApplication {
                blueprint_uid,
                selector: BlueprintSelector::Attribute(Attribute::Red),
            }),
            ..Default::default()
        },
    };
    let cue = Cue {
        instructions: vec![direct(20.0), reference, direct(140.0)],
        ..Default::default()
    };
    let materialized = make_materialized_cue_with_blueprints(app.world_mut(), &cue);
    assert_eq!(
        materialized_absolute_value(&materialized, red_parameter),
        140.0
    );
}

/// Missing Blueprint UUIDs materialize as empty authored rows without panicking.
#[test]
fn missing_blueprint_application_materializes_no_values() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<DataProvider<Blueprint>>();
    app.init_resource::<FixtureDataProviderExt>();
    let (fixture_ref, _) =
        add_single_element_fixture(app.world_mut(), 404, &[(Attribute::Red, 0.0, 255.0)]);
    let cue = Cue {
        instructions: vec![BoundCueInstruction {
            selection: SelectionExpr::Resolved(vec![fixture_ref]).into(),
            cue_instruction: CueInstruction {
                blueprint_application: Some(BlueprintApplication {
                    blueprint_uid: Uuid::new_v4(),
                    selector: BlueprintSelector::All,
                }),
                ..Default::default()
            },
        }],
        ..Default::default()
    };

    let materialized = make_materialized_cue_with_blueprints(app.world_mut(), &cue);

    assert!(materialized.values.absolute.is_empty());
    assert!(materialized.values.relative.is_empty());
}

/// Referenced fanned values reuse direct-value ordering, grouping, and inversion semantics.
#[test]
fn blueprint_fan_matches_direct_spatial_materialization() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<DataProvider<Blueprint>>();
    app.init_resource::<FixtureDataProviderExt>();
    let fixtures = (405..=408)
        .map(|id| {
            add_single_element_fixture(app.world_mut(), id, &[(Attribute::Intensity, 0.0, 255.0)]).0
        })
        .collect::<Vec<_>>();
    let fan = ValueSource::Fanned {
        values: vec![
            ParameterValue::Absolute { value: 0.0 },
            ParameterValue::Absolute { value: 255.0 },
        ],
    };
    let blueprint_uid = Uuid::new_v4();
    app.world_mut()
        .resource_mut::<DataProvider<Blueprint>>()
        .add(Blueprint {
            identifiers: Identifiers {
                id: 10,
                uid: blueprint_uid,
                label: "Intensity Fan".to_owned(),
            },
            values: HashMap::from([(Attribute::Intensity, fan.clone())]),
            ..Default::default()
        })
        .expect("Blueprint should be insertable");
    let selection = SpatialSelection {
        source: SelectionExpr::Resolved(fixtures),
        clauses: vec![
            SpatialClause::Group {
                axis: Axis::X,
                amount: 2,
            },
            SpatialClause::Invert {
                mode: InvertMode::Index,
                attrs: Some(vec![Attribute::Intensity]),
            },
        ],
        union: Vec::new(),
    };
    let referenced = Cue {
        instructions: vec![BoundCueInstruction {
            selection: selection.clone(),
            cue_instruction: CueInstruction {
                blueprint_application: Some(BlueprintApplication {
                    blueprint_uid,
                    selector: BlueprintSelector::Attribute(Attribute::Intensity),
                }),
                ..Default::default()
            },
        }],
        ..Default::default()
    };
    let direct = Cue {
        instructions: vec![BoundCueInstruction {
            selection,
            cue_instruction: CueInstruction {
                values: HashMap::from([(Attribute::Intensity, fan)]),
                ..Default::default()
            },
        }],
        ..Default::default()
    };

    let referenced_materialized =
        make_materialized_cue_with_blueprints(app.world_mut(), &referenced);
    let direct_materialized = make_materialized_cue_with_blueprints(app.world_mut(), &direct);

    assert_eq!(
        referenced_materialized.values.absolute,
        direct_materialized.values.absolute
    );
}

/// Standalone cue painting applies assigned color path samples before compositor output.
#[test]
fn paint_materialized_cues_applies_color_path_samples() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();
    app.add_systems(Update, paint_materialized_cues);

    let (fixture_ref, parameters) = add_single_element_fixture(
        app.world_mut(),
        101,
        &[
            (Attribute::Red, 0.0, 255.0),
            (Attribute::Green, 0.0, 255.0),
            (Attribute::Blue, 0.0, 255.0),
        ],
    );
    let red_parameter = *parameters
        .get(&Attribute::Red)
        .expect("red parameter should exist");
    let green_parameter = *parameters
        .get(&Attribute::Green)
        .expect("green parameter should exist");
    let blue_parameter = *parameters
        .get(&Attribute::Blue)
        .expect("blue parameter should exist");
    app.world_mut()
        .get_mut::<Parameter>(red_parameter.entity())
        .expect("red parameter component should exist")
        .values
        .default_value = 255.0;

    let cue = Cue {
        transitions: PartialTransition {
            fade_in: Some(TransitionMode::Fixed(Duration::from_secs(10))),
            ..Default::default()
        },
        instructions: vec![BoundCueInstruction {
            selection: SpatialSelection {
                source: SelectionExpr::Resolved(vec![fixture_ref.clone()]),
                clauses: vec![],
                union: Vec::new(),
            },
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values: HashMap::from([
                    (
                        Attribute::Red,
                        ValueSource::Inline(ParameterValue::Absolute { value: 0.0 }),
                    ),
                    (
                        Attribute::Green,
                        ValueSource::Inline(ParameterValue::Absolute { value: 255.0 }),
                    ),
                    (
                        Attribute::Blue,
                        ValueSource::Inline(ParameterValue::Absolute { value: 255.0 }),
                    ),
                ]),
                color_path_id: Some(ColorPathId(2)),
                ..Default::default()
            },
        }],
        ..Default::default()
    };

    let (materialized, _) = make_materialized_cue(app.world_mut(), &cue);
    let entity = app
        .world_mut()
        .spawn((
            materialized,
            InstanceClock {
                position: Duration::from_secs(5),
                ..Default::default()
            },
        ))
        .id();

    app.update();

    let layer = app
        .world()
        .get::<Layer>(entity)
        .expect("standalone cue should paint a layer");
    let sampled = |parameter: Instance<Parameter>| match layer
        .absolute
        .get(&parameter)
        .expect("color parameter should be sampled")
        .0
    {
        ParameterValue::Absolute { value } => value,
        ref value => panic!("expected absolute sampled value, got {value:?}"),
    };

    let red = sampled(red_parameter);
    let green = sampled(green_parameter);
    let blue = sampled(blue_parameter);

    assert!(
        (90.0..170.0).contains(&red),
        "HSV midpoint should keep partial red, got {red}"
    );
    assert!(
        green > 220.0,
        "HSV midpoint should route through green/yellow, got {green}"
    );
    assert!(
        blue < 40.0,
        "HSV midpoint should not look like native RGB gray, got {blue}"
    );
}

/// Standalone cue color paths sample from lower-priority compositor output.
#[test]
fn paint_materialized_cues_samples_color_paths_from_lower_layer_base() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();
    app.add_systems(Update, paint_materialized_cues);

    let (fixture_ref, parameters) = add_single_element_fixture(
        app.world_mut(),
        102,
        &[
            (Attribute::Red, 0.0, 255.0),
            (Attribute::Green, 0.0, 255.0),
            (Attribute::Blue, 0.0, 255.0),
        ],
    );
    let red_parameter = *parameters
        .get(&Attribute::Red)
        .expect("red parameter should exist");
    let green_parameter = *parameters
        .get(&Attribute::Green)
        .expect("green parameter should exist");
    let blue_parameter = *parameters
        .get(&Attribute::Blue)
        .expect("blue parameter should exist");

    let mut lower_layer = Layer::new("lower red".to_owned(), Priority(-1));
    lower_layer.absolute.insert(
        red_parameter,
        (ParameterValue::Absolute { value: 255.0 }, None),
    );
    app.world_mut().spawn(lower_layer);

    let cue = Cue {
        transitions: PartialTransition {
            fade_in: Some(TransitionMode::Fixed(Duration::from_secs(10))),
            ..Default::default()
        },
        instructions: vec![BoundCueInstruction {
            selection: SpatialSelection {
                source: SelectionExpr::Resolved(vec![fixture_ref.clone()]),
                clauses: vec![],
                union: Vec::new(),
            },
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values: HashMap::from([
                    (
                        Attribute::Red,
                        ValueSource::Inline(ParameterValue::Absolute { value: 0.0 }),
                    ),
                    (
                        Attribute::Green,
                        ValueSource::Inline(ParameterValue::Absolute { value: 255.0 }),
                    ),
                    (
                        Attribute::Blue,
                        ValueSource::Inline(ParameterValue::Absolute { value: 255.0 }),
                    ),
                ]),
                color_path_id: Some(ColorPathId(2)),
                ..Default::default()
            },
        }],
        ..Default::default()
    };

    let (materialized, _) = make_materialized_cue(app.world_mut(), &cue);
    let entity = app
        .world_mut()
        .spawn((
            materialized,
            InstanceClock {
                position: Duration::from_secs(5),
                ..Default::default()
            },
        ))
        .id();

    app.update();

    let layer = app
        .world()
        .get::<Layer>(entity)
        .expect("standalone cue should paint a layer");
    let sampled = |parameter: Instance<Parameter>| match layer
        .absolute
        .get(&parameter)
        .expect("color parameter should be sampled")
        .0
    {
        ParameterValue::Absolute { value } => value,
        ref value => panic!("expected absolute sampled value, got {value:?}"),
    };

    let red = sampled(red_parameter);
    let green = sampled(green_parameter);
    let blue = sampled(blue_parameter);

    assert!(
        (90.0..170.0).contains(&red),
        "HSV midpoint should use the lower red base, got red {red}"
    );
    assert!(
        green > 220.0,
        "HSV midpoint from red to cyan should route through yellow/green, got green {green}"
    );
    assert!(
        blue < 40.0,
        "HSV midpoint from red to cyan should not route through cyan/blue, got blue {blue}"
    );
}

#[test]
fn test_materialized_transition_from_transition() {
    // Create a transition with specific values
    let transition = Transition {
        delay_in: TransitionMode::Fixed(Duration::from_millis(100)),
        fade_in: TransitionMode::Fixed(Duration::from_millis(500)),
        delay_out: TransitionMode::Fixed(Duration::from_millis(200)),
        fade_out: TransitionMode::Fixed(Duration::from_millis(1000)),
        curve_in: FadeCurve::EaseIn,
        curve_out: FadeCurve::EaseOut,
    };

    // Test with offset 0 of 1 (no interpolation)
    let materialized = MaterializedTransition::from_transition(&transition, 0, 1);

    assert_eq!(materialized.delay_in, Duration::from_millis(100));
    assert_eq!(materialized.fade_in, Duration::from_millis(500));
    assert_eq!(materialized.delay_out, Duration::from_millis(200));
    assert_eq!(materialized.fade_out, Duration::from_millis(1000));
    assert_eq!(materialized.curve_in, FadeCurve::EaseIn);
    assert_eq!(materialized.curve_out, FadeCurve::EaseOut);
}

/// Verifies non-intensity out-only timing still gives LTP assertions visible timing.
#[test]
fn non_intensity_out_timing_supplies_assertion_fade() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();

    let (fixture_ref, parameters) =
        add_single_element_fixture(app.world_mut(), 1, &[(Attribute::Red, 0.0, 255.0)]);
    let red_parameter = *parameters
        .get(&Attribute::Red)
        .expect("red parameter should exist");
    app.world_mut()
        .get_mut::<Parameter>(red_parameter.entity())
        .expect("red parameter component should exist")
        .metadata
        .merge_type = MergeStrategy::LTP;

    let cue = Cue {
        instructions: vec![BoundCueInstruction {
            selection: SpatialSelection {
                source: SelectionExpr::Resolved(vec![fixture_ref]),
                clauses: vec![],
                union: Vec::new(),
            },
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values: HashMap::from([(
                    Attribute::Red,
                    ValueSource::Inline(ParameterValue::Absolute { value: 255.0 }),
                )]),
                transitions: PartialTransition {
                    fade_out: Some(TransitionMode::Fixed(Duration::from_secs(1))),
                    ..Default::default()
                },
                ..Default::default()
            },
        }],
        ..Default::default()
    };

    let (materialized, _) = make_materialized_cue(app.world_mut(), &cue);
    let transition = materialized
        .values
        .absolute
        .get(&red_parameter)
        .expect("red should be materialized")
        .1
        .as_ref()
        .expect("red should keep transition timing");

    assert_eq!(transition.fade_in, Duration::from_secs(1));
    assert_eq!(transition.fade_out, Duration::from_secs(1));
}

/// Verifies cue source-local start positions propagate to all transition storage.
#[test]
fn set_start_position_updates_value_and_release_timing_transitions() {
    let mut world = World::new();
    let parameter = spawn_parameter(
        &mut world,
        Attribute::Intensity,
        ParameterDmxValue::from(0.0_f32),
        ParameterDmxValue::from(255.0_f32),
    );
    let transition = MaterializedTransition {
        delay_in: Duration::ZERO,
        fade_in: Duration::from_secs(1),
        curve_in: FadeCurve::Linear,
        delay_out: Duration::ZERO,
        fade_out: Duration::from_secs(1),
        curve_out: FadeCurve::Linear,
        start_position: Duration::ZERO,
        release_position: None,
    };
    let mut cue = MaterializedCue::default();
    cue.values.absolute.insert(
        parameter,
        (
            ParameterValue::Absolute { value: 1.0 },
            Some(transition.clone()),
        ),
    );
    cue.release_timing_overrides
        .insert(parameter, transition.clone());

    cue.set_start_position(Duration::from_millis(750));

    assert_eq!(cue.start_position, Duration::from_millis(750));
    assert_eq!(
        cue.values
            .absolute
            .get(&parameter)
            .and_then(|(_, transition)| transition.as_ref())
            .map(|transition| transition.start_position),
        Some(Duration::from_millis(750))
    );
    assert_eq!(
        cue.release_timing_overrides
            .get(&parameter)
            .map(|transition| transition.start_position),
        Some(Duration::from_millis(750))
    );
}

#[test]
fn test_resolve_fixture_refs() {
    // Add test fixtures with elements
    let mut data_provider = FixtureDataProviderExt::default();

    // Add a fixture with 3 elements
    let fixture_id = Uuid::new_v4();
    let fixture = Fixture {
        identifiers: Identifiers {
            label: "Test Fixture".to_string(),
            uid: fixture_id,
            ..Default::default()
        },
        make: "".to_string(),
        model: "".to_string(),
        elements: vec![FixtureElement::default(); 3],
        ..Default::default()
    };
    let _ = data_provider.inner.add(fixture);

    // Test with specific element reference
    let fixture_ref = FixtureRef {
        fixture_uid: fixture_id,
        index: Some(2),
    };

    let resolved = MaterializedCue::resolve_fixture_refs(&fixture_ref, &data_provider);
    assert_eq!(resolved.len(), 1);
    assert_eq!(resolved[0].index, Some(2));

    // Test with no index (should return all elements)
    let fixture_ref_all = FixtureRef {
        fixture_uid: fixture_id,
        index: None,
    };

    let resolved_all = MaterializedCue::resolve_fixture_refs(&fixture_ref_all, &data_provider);
    assert_eq!(resolved_all.len(), 3);
    assert_eq!(resolved_all[0].index, Some(1));
    assert_eq!(resolved_all[1].index, Some(2));
    assert_eq!(resolved_all[2].index, Some(3));
}

#[test]
fn paint_materialized_cues_preserves_existing_activation_time() {
    let mut app = App::new();
    app.add_systems(Update, paint_materialized_cues);

    let mut existing_layer = Layer::new("existing".to_owned(), Priority::default());
    let original_activation = Instant::now() - Duration::from_secs(5);
    existing_layer.activation_time = original_activation;

    let entity = app
        .world_mut()
        .spawn((MaterializedCue::default(), existing_layer))
        .id();

    app.update();

    let layer = app
        .world()
        .entity(entity)
        .get::<Layer>()
        .expect("layer should exist after painting");
    assert_eq!(layer.activation_time, original_activation);
}

/// Verifies standalone cue runtime status reports source-local clock position when available.
#[test]
fn cue_runtime_status_reports_instance_clock_position() {
    let cue = MaterializedCue::default();
    let clock = InstanceClock {
        position: Duration::from_millis(1234),
        activation_epoch_ms: Some(99.0),
        ..Default::default()
    };

    let status = cue.runtime_status_at_clock(Some(&clock));

    assert_eq!(
        status.position,
        InstancePosition::Time {
            elapsed: Duration::from_millis(1234),
        }
    );
    assert_eq!(status.source_activation_epoch_ms, Some(99.0));
}

/// Verifies standalone cue rendering exposes its playback clock to the compositor layer.
#[test]
fn paint_materialized_cues_mirrors_instance_clock_to_layer_compositing_context() {
    let mut app = App::new();
    app.add_systems(Update, paint_materialized_cues);

    let entity = app
        .world_mut()
        .spawn((
            MaterializedCue::default(),
            InstanceClock {
                position: Duration::from_millis(750),
                ..Default::default()
            },
        ))
        .id();

    app.update();

    let clock = app
        .world()
        .entity(entity)
        .get::<LayerCompositingContext>()
        .expect("layer compositing context should be mirrored from playback clock");
    assert_eq!(clock.position, Duration::from_millis(750));
}

/// Verifies unclocked timed cues expose deterministic zero transition time to the compositor.
#[test]
fn paint_materialized_cues_inserts_zero_compositing_context_for_unclocked_transitions() {
    let mut app = App::new();
    app.add_systems(Update, paint_materialized_cues);

    let parameter = spawn_parameter(
        app.world_mut(),
        Attribute::Intensity,
        ParameterDmxValue::from(0.0_f32),
        ParameterDmxValue::from(255.0_f32),
    );
    let mut cue = MaterializedCue::default();
    cue.values.absolute.insert(
        parameter,
        (
            ParameterValue::Absolute { value: 255.0 },
            Some(MaterializedTransition {
                delay_in: Duration::ZERO,
                fade_in: Duration::from_secs(1),
                curve_in: FadeCurve::Linear,
                delay_out: Duration::ZERO,
                fade_out: Duration::from_secs(1),
                curve_out: FadeCurve::Linear,
                start_position: Duration::ZERO,
                release_position: None,
            }),
        ),
    );

    let entity = app.world_mut().spawn(cue).id();

    app.update();

    let clock = app
        .world()
        .entity(entity)
        .get::<LayerCompositingContext>()
        .expect("timed cue layer should receive deterministic compositing context");
    assert_eq!(clock.position, Duration::ZERO);
    assert_eq!(clock.released_at, None);
}

/// Verifies released standalone cues expose their source-local release anchor.
#[test]
fn paint_materialized_cues_mirrors_release_position_to_layer_compositing_context() {
    let mut app = App::new();
    app.add_systems(Update, paint_materialized_cues);

    let entity = app
        .world_mut()
        .spawn((
            MaterializedCue {
                release_position: Some(Duration::from_millis(250)),
                ..Default::default()
            },
            InstanceClock {
                position: Duration::from_millis(750),
                ..Default::default()
            },
            ReleaseMarker::default(),
        ))
        .id();

    app.update();

    let clock = app
        .world()
        .entity(entity)
        .get::<LayerCompositingContext>()
        .expect("released layer compositing context should be mirrored from playback clock");
    assert_eq!(clock.position, Duration::from_millis(750));
    assert_eq!(clock.released_at, Some(Duration::from_millis(250)));
}

/// Verifies cue release captures the source-local playback position when available.
#[test]
fn release_materialized_cues_records_instance_clock_release_position() {
    let mut app = App::new();
    app.insert_resource(FixtureDataProviderExt::default());
    app.add_systems(Update, release_materialized_cues);

    let entity = app
        .world_mut()
        .spawn((
            MaterializedCue::default(),
            InstanceClock {
                position: Duration::from_millis(350),
                ..Default::default()
            },
            ReleaseMarker::default(),
        ))
        .id();

    app.update();

    let cue = app
        .world()
        .entity(entity)
        .get::<MaterializedCue>()
        .expect("released cue should still exist");
    assert_eq!(cue.release_position, Some(Duration::from_millis(350)));
}

/// Verifies unclocked cue release records deterministic zero instead of wall-clock time.
#[test]
fn release_materialized_cues_without_clock_uses_zero_release_position() {
    let mut app = App::new();
    app.insert_resource(FixtureDataProviderExt::default());
    app.add_systems(Update, release_materialized_cues);

    let entity = app
        .world_mut()
        .spawn((MaterializedCue::default(), ReleaseMarker::default()))
        .id();

    app.update();

    let cue = app
        .world()
        .entity(entity)
        .get::<MaterializedCue>()
        .expect("released cue should still exist");
    assert_eq!(cue.release_position, Some(Duration::ZERO));
}

/// Verifies released standalone cues remain alive until their clocked release finishes.
#[test]
fn despawn_materialized_cues_waits_for_clocked_release_duration() {
    let mut app = App::new();
    app.add_systems(Update, despawn_materialized_cues);

    let parameter = spawn_parameter(
        app.world_mut(),
        Attribute::Intensity,
        ParameterDmxValue::MIN,
        ParameterDmxValue::MAX,
    );
    let mut cue = MaterializedCue {
        release_position: Some(Duration::ZERO),
        ..Default::default()
    };
    cue.values.absolute.insert(
        parameter,
        (
            ParameterValue::Absolute { value: 255.0 },
            Some(MaterializedTransition {
                delay_in: Duration::ZERO,
                fade_in: Duration::ZERO,
                curve_in: FadeCurve::Linear,
                delay_out: Duration::ZERO,
                fade_out: Duration::from_millis(100),
                curve_out: FadeCurve::Linear,
                start_position: Duration::ZERO,
                release_position: Some(Duration::ZERO),
            }),
        ),
    );

    let entity = app
        .world_mut()
        .spawn((
            cue,
            InstanceClock {
                position: Duration::from_millis(50),
                ..Default::default()
            },
            ReleaseMarker::default(),
        ))
        .id();

    app.update();
    assert!(
        app.world().get_entity(entity).is_ok(),
        "cue should remain while clocked release is still in progress"
    );

    app.world_mut()
        .get_mut::<InstanceClock>(entity)
        .expect("cue should still have a playback clock")
        .seek_to(Duration::from_millis(120));
    app.update();

    assert!(
        app.world().get_entity(entity).is_err(),
        "cue should despawn after clocked release duration completes"
    );
}

/// Verifies unclocked cue release cleanup does not advance from ReleaseMarker wall time.
#[test]
fn despawn_materialized_cues_without_clock_uses_zero_release_elapsed() {
    let mut app = App::new();
    app.add_systems(Update, despawn_materialized_cues);

    let parameter = spawn_parameter(
        app.world_mut(),
        Attribute::Intensity,
        ParameterDmxValue::MIN,
        ParameterDmxValue::MAX,
    );
    let mut cue = MaterializedCue::default();
    cue.values.absolute.insert(
        parameter,
        (
            ParameterValue::Absolute { value: 255.0 },
            Some(MaterializedTransition {
                delay_in: Duration::ZERO,
                fade_in: Duration::ZERO,
                curve_in: FadeCurve::Linear,
                delay_out: Duration::ZERO,
                fade_out: Duration::from_millis(100),
                curve_out: FadeCurve::Linear,
                start_position: Duration::ZERO,
                release_position: None,
            }),
        ),
    );

    let entity = app
        .world_mut()
        .spawn((
            cue,
            ReleaseMarker {
                start_time: Instant::now() - Duration::from_secs(10),
            },
        ))
        .id();

    app.update();

    assert!(
        app.world().get_entity(entity).is_ok(),
        "unclocked cue cleanup should not use wall-clock release elapsed"
    );
}

#[test]
fn test_resolve_transition() {
    // Create a cue with transitions
    let mut cue = Cue {
        transitions: PartialTransition {
            fade_in: Some(TransitionMode::Fixed(Duration::from_millis(500))),
            ..Default::default()
        },
        ..Default::default()
    };

    // Set attribute-specific transition
    let attribute = Attribute::Intensity;
    cue.transitions_by_attribute.insert(
        attribute.clone(),
        PartialTransition {
            delay_in: Some(TransitionMode::Fixed(Duration::from_millis(100))),
            ..Default::default()
        },
    );

    // Create a cue instruction with its own transitions
    let fixture_ref = FixtureRef {
        fixture_uid: Uuid::new_v4(),
        index: Some(1),
    };
    let cue_instruction = CueInstruction {
        blueprint_application: None,
        transitions: PartialTransition {
            fade_in: Some(TransitionMode::Fixed(Duration::from_millis(200))),
            ..Default::default()
        },
        transitions_by_fixture_attribute: vec![FixtureAttributeTransition {
            fixture: fixture_ref.clone(),
            transitions_by_attribute: HashMap::from([(
                attribute.clone(),
                PartialTransition {
                    fade_in: Some(TransitionMode::Fixed(Duration::from_millis(50))),
                    ..Default::default()
                },
            )]),
        }],
        ..Default::default()
    };

    // Resolve the transition
    let transition = MaterializedCue::resolve_transition(
        &cue.transitions,
        &cue.transitions_by_attribute,
        &cue_instruction,
        &fixture_ref,
        &attribute,
        &attribute,
        0, // offset
        1, // total
        Duration::from_millis(250),
    );

    // Fixture-attribute transition should override instruction-wide transitions.
    assert_eq!(transition.fade_in, Duration::from_millis(50));
    // Attribute-specific delay should be preserved
    assert_eq!(transition.delay_in, Duration::from_millis(100));
    assert_eq!(transition.start_position, Duration::from_millis(250));
}

#[test]
fn test_get_transition_progress() {
    // Test with no delay and no fade (should be 1.0 immediately)
    let transition = MaterializedTransition {
        delay_in: Duration::ZERO,
        fade_in: Duration::ZERO,
        curve_in: FadeCurve::Linear,
        delay_out: Duration::ZERO,
        fade_out: Duration::ZERO,
        curve_out: FadeCurve::Linear,
        start_position: Duration::ZERO,
        release_position: None,
    };

    // Should be 1.0 immediately since fade_in is zero
    assert_eq!(
        MaterializedTransition::fade_ratio_at_elapsed(
            Duration::ZERO,
            transition.fade_in,
            transition.delay_in,
        ),
        1.0
    );

    // Test with delay
    let transition_with_delay = MaterializedTransition {
        delay_in: Duration::from_millis(100),
        fade_in: Duration::from_millis(500),
        curve_in: FadeCurve::Linear,
        delay_out: Duration::ZERO,
        fade_out: Duration::ZERO,
        curve_out: FadeCurve::Linear,
        start_position: Duration::ZERO,
        release_position: None,
    };

    // Should be 0.0 during delay
    assert_eq!(
        MaterializedTransition::fade_ratio_at_elapsed(
            Duration::ZERO,
            transition_with_delay.fade_in,
            transition_with_delay.delay_in
        ),
        0.0
    );
}

#[test]
fn test_resolve_fanned_value_two_values() {
    // Test linear fan with 2 values (0% to 100%)
    let values = vec![
        ParameterValue::AbsolutePercent { value: 0.0.into() },
        ParameterValue::AbsolutePercent { value: 1.0.into() },
    ];

    // First fixture (index 0 of 4) should be 0%
    let result = MaterializedCue::resolve_fanned_value(&values, 0, 4);
    if let ParameterValue::AbsolutePercent { value } = result {
        let val = value.as_f32();
        assert!((val - 0.0).abs() < 0.001, "Expected 0%, got {}", val);
    } else {
        panic!("Expected AbsolutePercent");
    }

    // Middle fixture (index 1 of 4) should be ~33%
    let result = MaterializedCue::resolve_fanned_value(&values, 1, 4);
    if let ParameterValue::AbsolutePercent { value } = result {
        let val = value.as_f32();
        assert!(
            (val - 0.333).abs() < 0.01,
            "Expected ~33%, got {}",
            val * 100.0
        );
    }

    // Last fixture (index 3 of 4) should be 100%
    let result = MaterializedCue::resolve_fanned_value(&values, 3, 4);
    if let ParameterValue::AbsolutePercent { value } = result {
        let val = value.as_f32();
        assert!((val - 1.0).abs() < 0.001, "Expected 100%, got {}", val);
    }
}

#[test]
fn test_resolve_fanned_value_three_values() {
    // Test envelope with 3 values: 0% -> 100% -> 50%
    let values = vec![
        ParameterValue::AbsolutePercent { value: 0.0.into() },
        ParameterValue::AbsolutePercent { value: 1.0.into() },
        ParameterValue::AbsolutePercent { value: 0.5.into() },
    ];

    // First fixture should be 0%
    let result = MaterializedCue::resolve_fanned_value(&values, 0, 5);
    if let ParameterValue::AbsolutePercent { value } = result {
        let val = value.as_f32();
        assert!((val - 0.0).abs() < 0.001, "Expected 0%, got {}", val);
    }

    // Middle fixture (index 2 of 5, t=0.5) should be at the peak (100%)
    let result = MaterializedCue::resolve_fanned_value(&values, 2, 5);
    if let ParameterValue::AbsolutePercent { value } = result {
        let val = value.as_f32();
        assert!((val - 1.0).abs() < 0.001, "Expected 100%, got {}", val);
    }

    // Last fixture (index 4 of 5) should be 50%
    let result = MaterializedCue::resolve_fanned_value(&values, 4, 5);
    if let ParameterValue::AbsolutePercent { value } = result {
        let val = value.as_f32();
        assert!((val - 0.5).abs() < 0.001, "Expected 50%, got {}", val);
    }
}

#[test]
fn test_resolve_fanned_value_single_value() {
    // Single value should be returned for all fixtures
    let values = vec![ParameterValue::AbsolutePercent { value: 0.75.into() }];

    let result = MaterializedCue::resolve_fanned_value(&values, 0, 4);
    if let ParameterValue::AbsolutePercent { value } = result {
        let val = value.as_f32();
        assert!((val - 0.75).abs() < 0.001, "Expected 75%, got {}", val);
    }

    let result = MaterializedCue::resolve_fanned_value(&values, 3, 4);
    if let ParameterValue::AbsolutePercent { value } = result {
        let val = value.as_f32();
        assert!((val - 0.75).abs() < 0.001, "Expected 75%, got {}", val);
    }
}

#[test]
fn test_resolve_fanned_value_single_fixture() {
    // With only one fixture, should return first value
    let values = vec![
        ParameterValue::AbsolutePercent { value: 0.0.into() },
        ParameterValue::AbsolutePercent { value: 1.0.into() },
    ];

    let result = MaterializedCue::resolve_fanned_value(&values, 0, 1);
    if let ParameterValue::AbsolutePercent { value } = result {
        let val = value.as_f32();
        assert!((val - 0.0).abs() < 0.001, "Expected 0%, got {}", val);
    }
}

#[test]
fn materialize_fans_values_by_resolved_selection_index() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();

    let fixtures: Vec<_> = (1..=4)
        .map(|id| {
            add_single_element_fixture(app.world_mut(), id, &[(Attribute::Intensity, 0.0, 255.0)]).0
        })
        .collect();

    let cue = Cue {
        instructions: vec![BoundCueInstruction {
            selection: SpatialSelection {
                source: SelectionExpr::Resolved(fixtures.clone()),
                clauses: vec![SpatialClause::Group {
                    axis: Axis::X,
                    amount: 2,
                }],
                union: Vec::new(),
            },
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values: HashMap::from([(
                    Attribute::Intensity,
                    ValueSource::Fanned {
                        values: vec![
                            ParameterValue::Absolute { value: 0.0 },
                            ParameterValue::Absolute { value: 255.0 },
                        ],
                    },
                )]),
                ..Default::default()
            },
        }],
        ..Default::default()
    };

    let (materialized, fixtures) = make_materialized_cue(app.world_mut(), &cue);
    let fixture_data_provider = app.world().resource::<FixtureDataProviderExt>();

    let resolved_values: Vec<_> = fixtures
        .into_iter()
        .map(|fixture_ref| {
            let parameter = fixture_data_provider
                .parameter_for_element_attribute(&fixture_ref, &Attribute::Intensity);
            materialized
                .values
                .absolute
                .get(&parameter)
                .expect("fixture should receive an intensity value")
                .0
        })
        .collect();

    assert_eq!(
        resolved_values,
        vec![
            ParameterValue::Absolute { value: 0.0 },
            ParameterValue::Absolute { value: 0.0 },
            ParameterValue::Absolute { value: 255.0 },
            ParameterValue::Absolute { value: 255.0 },
        ]
    );
}

/// Materialization fans instruction-level timing across selection endpoints before applying fixture-attribute overrides.
#[test]
fn materialize_fixture_attribute_timing_overrides_instruction_fan() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();

    let fixtures: Vec<_> = (1..=2)
        .map(|id| {
            add_single_element_fixture(app.world_mut(), id, &[(Attribute::Intensity, 0.0, 255.0)]).0
        })
        .collect();

    let cue = Cue {
        instructions: vec![BoundCueInstruction {
            selection: SpatialSelection {
                source: SelectionExpr::Resolved(fixtures.clone()),
                clauses: vec![],
                union: Vec::new(),
            },
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values: HashMap::from([(
                    Attribute::Intensity,
                    ValueSource::Inline(ParameterValue::Absolute { value: 255.0 }),
                )]),
                transitions: PartialTransition {
                    delay_in: Some(TransitionMode::Interpolated {
                        start: Duration::from_millis(0),
                        end: Duration::from_secs(2),
                    }),
                    ..Default::default()
                },
                transitions_by_fixture_attribute: vec![FixtureAttributeTransition {
                    fixture: fixtures[1].clone(),
                    transitions_by_attribute: HashMap::from([(
                        Attribute::Intensity,
                        PartialTransition {
                            delay_in: Some(TransitionMode::Fixed(Duration::from_secs(7))),
                            ..Default::default()
                        },
                    )]),
                }],
                ..Default::default()
            },
        }],
        ..Default::default()
    };

    let (materialized, fixtures) = make_materialized_cue(app.world_mut(), &cue);
    let fixture_data_provider = app.world().resource::<FixtureDataProviderExt>();
    let transition_delays: Vec<_> = fixtures
        .iter()
        .map(|fixture_ref| {
            let parameter = fixture_data_provider
                .parameter_for_element_attribute(fixture_ref, &Attribute::Intensity);
            materialized
                .values
                .absolute
                .get(&parameter)
                .expect("fixture should receive an intensity value")
                .1
                .as_ref()
                .expect("fixture should receive a transition")
                .delay_in
        })
        .collect();

    assert_eq!(
        transition_delays,
        vec![Duration::from_secs(0), Duration::from_secs(7)]
    );
}

/// Verifies virtual intensity release keeps LTP color asserted until dimmer is dark.
#[test]
fn release_holds_ltp_color_until_virtual_intensity_fade_completes() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();

    let (fixture_ref, parameters) = add_single_element_fixture(
        app.world_mut(),
        3,
        &[
            (Attribute::VirtualIntensity, 0.0, 255.0),
            (Attribute::Red, 0.0, 255.0),
        ],
    );
    let virtual_intensity_parameter = *parameters
        .get(&Attribute::VirtualIntensity)
        .expect("virtual intensity parameter should exist");
    let red_parameter = *parameters
        .get(&Attribute::Red)
        .expect("red parameter should exist");
    app.world_mut()
        .get_mut::<Parameter>(virtual_intensity_parameter.entity())
        .expect("virtual intensity parameter component should exist")
        .values
        .default_value = 255.0;
    app.world_mut()
        .get_mut::<Parameter>(red_parameter.entity())
        .expect("red parameter component should exist")
        .metadata
        .merge_type = MergeStrategy::LTP;

    let cue = Cue {
        instructions: vec![BoundCueInstruction {
            selection: SpatialSelection {
                source: SelectionExpr::Resolved(vec![fixture_ref]),
                clauses: vec![],
                union: Vec::new(),
            },
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values: HashMap::from([
                    (
                        Attribute::VirtualIntensity,
                        ValueSource::Inline(ParameterValue::Absolute { value: 255.0 }),
                    ),
                    (
                        Attribute::Red,
                        ValueSource::Inline(ParameterValue::Absolute { value: 255.0 }),
                    ),
                ]),
                transitions_by_attribute: HashMap::from([(
                    Attribute::VirtualIntensity,
                    PartialTransition {
                        fade_out: Some(TransitionMode::Fixed(Duration::from_secs(3))),
                        ..Default::default()
                    },
                )]),
                ..Default::default()
            },
        }],
        ..Default::default()
    };

    let (mut materialized, _) = make_materialized_cue(app.world_mut(), &cue);
    let mut system_state = SystemState::<(
        Res<FixtureDataProviderExt>,
        Query<InstanceRef<Parameter>>,
    )>::new(app.world_mut());
    let (fixture_data_provider, parameter_query) = system_state
        .get(app.world_mut())
        .expect("test system parameters should be available");

    materialized.release_with_ltp_hold_at_playback_position(
        &fixture_data_provider,
        &parameter_query,
        None,
    );

    let virtual_intensity_transition = materialized
        .values
        .absolute
        .get(&virtual_intensity_parameter)
        .expect("virtual intensity should be materialized")
        .1
        .as_ref()
        .expect("virtual intensity should keep transition timing");
    assert_eq!(
        virtual_intensity_transition.fade_out,
        Duration::from_secs(3)
    );

    let red_transition = materialized
        .values
        .absolute
        .get(&red_parameter)
        .expect("red should be materialized")
        .1
        .as_ref()
        .expect("red should keep transition timing");
    assert_eq!(red_transition.delay_out, Duration::from_secs(3));
    assert_eq!(red_transition.fade_out, Duration::ZERO);
    assert_eq!(red_transition.release_position, Some(Duration::ZERO));

    let _ = parameter_query;
    drop(fixture_data_provider);
    drop(system_state);

    let mut param_query_state = app.world_mut().query::<InstanceMut<Parameter>>();
    let param_query = param_query_state.query_mut(app.world_mut());
    let mut release_layer = materialized.to_layer(None);
    let computed = nightfall_compositor::stages::apply_transitions_with_compositing_context(
        &mut release_layer,
        &ComputedLayer::default(),
        &param_query,
        true,
        nightfall_compositor::types::LayerCompositingContext {
            position: Duration::from_secs(1),
            released_at: Some(Duration::ZERO),
        },
    );
    let virtual_intensity_value = *computed
        .absolute
        .get(&virtual_intensity_parameter)
        .expect("virtual intensity should still output while fading");
    let red_value = *computed
        .absolute
        .get(&red_parameter)
        .expect("red should remain asserted during virtual intensity fade");

    assert!(
        (150.0..200.0).contains(&virtual_intensity_value),
        "virtual intensity should be fading out, got {virtual_intensity_value}"
    );

    assert_eq!(red_value, 255.0);
}

/// Verifies release-cue Intensity timing resolves against virtual dimmer parameters.
#[test]
fn release_cue_intensity_timing_resolves_virtual_intensity() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();

    let (fixture_ref, parameters) = add_single_element_fixture(
        app.world_mut(),
        4,
        &[
            (Attribute::VirtualIntensity, 0.0, 255.0),
            (Attribute::Red, 0.0, 255.0),
        ],
    );
    let virtual_intensity_parameter = *parameters
        .get(&Attribute::VirtualIntensity)
        .expect("virtual intensity parameter should exist");
    let red_parameter = *parameters
        .get(&Attribute::Red)
        .expect("red parameter should exist");
    app.world_mut()
        .get_mut::<Parameter>(red_parameter.entity())
        .expect("red parameter component should exist")
        .metadata
        .merge_type = MergeStrategy::LTP;

    let cue = Cue {
        instructions: vec![BoundCueInstruction {
            selection: SpatialSelection {
                source: SelectionExpr::Resolved(vec![fixture_ref.clone()]),
                clauses: vec![],
                union: Vec::new(),
            },
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values: HashMap::from([
                    (
                        Attribute::Intensity,
                        ValueSource::Inline(ParameterValue::Absolute { value: 255.0 }),
                    ),
                    (
                        Attribute::Red,
                        ValueSource::Inline(ParameterValue::Absolute { value: 255.0 }),
                    ),
                ]),
                ..Default::default()
            },
        }],
        ..Default::default()
    };
    let release_cue = Cue {
        instructions: vec![BoundCueInstruction {
            selection: SpatialSelection {
                source: SelectionExpr::Resolved(vec![fixture_ref.clone()]),
                clauses: vec![],
                union: Vec::new(),
            },
            cue_instruction: CueInstruction {
                blueprint_application: None,
                transitions_by_fixture_attribute: vec![FixtureAttributeTransition {
                    fixture: fixture_ref.clone(),
                    transitions_by_attribute: HashMap::from([(
                        Attribute::Intensity,
                        PartialTransition {
                            fade_out: Some(TransitionMode::Fixed(Duration::from_secs(2))),
                            ..Default::default()
                        },
                    )]),
                }],
                ..Default::default()
            },
        }],
        ..Default::default()
    };

    let (materialized, _) = make_materialized_cue(app.world_mut(), &cue);
    let (release_materialized, _) = make_materialized_cue(app.world_mut(), &release_cue);

    assert!(
        release_materialized
            .values
            .absolute
            .get(&virtual_intensity_parameter)
            .is_none(),
        "release cue should carry timing without asserting virtual intensity"
    );
    assert!(
        release_materialized
            .release_timing_overrides
            .get(&virtual_intensity_parameter)
            .is_some(),
        "release cue should materialize Intensity timing against virtual intensity"
    );

    let release_timings = release_materialized.release_timings_by_parameter();
    let virtual_intensity_transition = release_timings
        .get(&virtual_intensity_parameter)
        .expect("release timing should resolve against virtual intensity");
    assert_eq!(
        virtual_intensity_transition.fade_out,
        Duration::from_secs(2)
    );
    let red_transition = materialized
        .values
        .absolute
        .get(&red_parameter)
        .expect("red should be materialized")
        .1
        .as_ref()
        .expect("red should keep materialized transition timing");
    assert_eq!(red_transition.delay_out, Duration::ZERO);
    assert_eq!(red_transition.fade_out, Duration::ZERO);
}

/// Verifies cue-level release fade resolves against virtual dimmer parameters.
#[test]
fn release_cue_global_timing_resolves_virtual_intensity() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();

    let (fixture_ref, parameters) = add_single_element_fixture(
        app.world_mut(),
        5,
        &[
            (Attribute::VirtualIntensity, 0.0, 255.0),
            (Attribute::Red, 0.0, 255.0),
        ],
    );
    let virtual_intensity_parameter = *parameters
        .get(&Attribute::VirtualIntensity)
        .expect("virtual intensity parameter should exist");
    let red_parameter = *parameters
        .get(&Attribute::Red)
        .expect("red parameter should exist");
    app.world_mut()
        .get_mut::<Parameter>(red_parameter.entity())
        .expect("red parameter component should exist")
        .metadata
        .merge_type = MergeStrategy::LTP;

    let cue = Cue {
        instructions: vec![BoundCueInstruction {
            selection: SpatialSelection {
                source: SelectionExpr::Resolved(vec![fixture_ref.clone()]),
                clauses: vec![],
                union: Vec::new(),
            },
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values: HashMap::from([
                    (
                        Attribute::Intensity,
                        ValueSource::Inline(ParameterValue::Absolute { value: 255.0 }),
                    ),
                    (
                        Attribute::Red,
                        ValueSource::Inline(ParameterValue::Absolute { value: 255.0 }),
                    ),
                ]),
                ..Default::default()
            },
        }],
        ..Default::default()
    };
    let release_cue = Cue {
        transitions: PartialTransition {
            fade_out: Some(TransitionMode::Fixed(Duration::from_secs(2))),
            ..Default::default()
        },
        instructions: vec![BoundCueInstruction {
            selection: SpatialSelection {
                source: SelectionExpr::Resolved(vec![fixture_ref.clone()]),
                clauses: vec![],
                union: Vec::new(),
            },
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values: HashMap::from([(
                    Attribute::Red,
                    ValueSource::Inline(ParameterValue::Absolute { value: 255.0 }),
                )]),
                ..Default::default()
            },
        }],
        ..Default::default()
    };

    let (materialized, _) = make_materialized_cue(app.world_mut(), &cue);
    let (release_materialized, _) = make_materialized_cue(app.world_mut(), &release_cue);

    assert!(
        release_materialized
            .values
            .absolute
            .get(&virtual_intensity_parameter)
            .is_none(),
        "release cue should not assert virtual intensity"
    );
    let release_timings = release_materialized.release_timings_by_parameter();
    let release_virtual_transition = release_timings
        .get(&virtual_intensity_parameter)
        .expect("cue-level release timing should resolve against virtual intensity");
    assert_eq!(release_virtual_transition.fade_out, Duration::from_secs(2));
    assert!(
        materialized.values.absolute.get(&red_parameter).is_some(),
        "source cue should still materialize red independently of release timing extraction"
    );
}

#[test]
fn materialize_inverts_only_targeted_attributes() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();

    let fixtures: Vec<_> = (1..=2)
        .map(|id| {
            add_single_element_fixture(
                app.world_mut(),
                id,
                &[
                    (Attribute::Pan, -90.0, 90.0),
                    (Attribute::Tilt, -90.0, 90.0),
                ],
            )
            .0
        })
        .collect();

    let cue = Cue {
        instructions: vec![BoundCueInstruction {
            selection: SpatialSelection {
                source: SelectionExpr::Resolved(fixtures.clone()),
                clauses: vec![SpatialClause::Invert {
                    mode: InvertMode::Index,
                    attrs: Some(vec![Attribute::Pan]),
                }],
                union: Vec::new(),
            },
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values: HashMap::from([
                    (
                        Attribute::Pan,
                        ValueSource::Inline(ParameterValue::Absolute { value: 45.0 }),
                    ),
                    (
                        Attribute::Tilt,
                        ValueSource::Inline(ParameterValue::Absolute { value: 45.0 }),
                    ),
                ]),
                ..Default::default()
            },
        }],
        ..Default::default()
    };

    let (materialized, fixtures) = make_materialized_cue(app.world_mut(), &cue);
    let fixture_data_provider = app.world().resource::<FixtureDataProviderExt>();

    let pan_values: Vec<_> = fixtures
        .iter()
        .map(|fixture_ref| {
            let parameter =
                fixture_data_provider.parameter_for_element_attribute(fixture_ref, &Attribute::Pan);
            materialized
                .values
                .absolute
                .get(&parameter)
                .expect("fixture should receive a pan value")
                .0
        })
        .collect();
    let tilt_values: Vec<_> = fixtures
        .iter()
        .map(|fixture_ref| {
            let parameter = fixture_data_provider
                .parameter_for_element_attribute(fixture_ref, &Attribute::Tilt);
            materialized
                .values
                .absolute
                .get(&parameter)
                .expect("fixture should receive a tilt value")
                .0
        })
        .collect();

    assert_eq!(
        pan_values,
        vec![
            ParameterValue::Absolute { value: 45.0 },
            ParameterValue::Absolute { value: -45.0 },
        ]
    );
    assert_eq!(
        tilt_values,
        vec![
            ParameterValue::Absolute { value: 45.0 },
            ParameterValue::Absolute { value: 45.0 },
        ]
    );
}

#[test]
fn materialize_cue_parts_share_start_and_override_in_order() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();

    let fixture =
        add_single_element_fixture(app.world_mut(), 1, &[(Attribute::Intensity, 0.0, 255.0)]).0;

    let instruction = |value: f32| BoundCueInstruction {
        selection: SpatialSelection::identity(SelectionExpr::Resolved(vec![fixture.clone()])),
        cue_instruction: CueInstruction {
            blueprint_application: None,
            values: HashMap::from([(
                Attribute::Intensity,
                ValueSource::Inline(ParameterValue::Absolute { value }),
            )]),
            ..Default::default()
        },
    };

    let cue = Cue {
        instructions: vec![instruction(10.0)],
        parts: vec![
            CuePart {
                identifiers: Identifiers {
                    id: 1,
                    label: "Part 1".to_owned(),
                    ..Default::default()
                },
                transitions: PartialTransition {
                    fade_in: Some(TransitionMode::Fixed(Duration::from_millis(200))),
                    ..Default::default()
                },
                instructions: vec![instruction(20.0)],
                ..Default::default()
            },
            CuePart {
                identifiers: Identifiers {
                    id: 2,
                    label: "Part 2".to_owned(),
                    ..Default::default()
                },
                transitions: PartialTransition {
                    delay_in: Some(TransitionMode::Fixed(Duration::from_millis(500))),
                    ..Default::default()
                },
                instructions: vec![instruction(30.0)],
                ..Default::default()
            },
        ],
        ..Default::default()
    };

    let (materialized, _) = make_materialized_cue(app.world_mut(), &cue);
    let fixture_data_provider = app.world().resource::<FixtureDataProviderExt>();
    let parameter =
        fixture_data_provider.parameter_for_element_attribute(&fixture, &Attribute::Intensity);
    let (value, transition) = materialized
        .values
        .absolute
        .get(&parameter)
        .expect("fixture should receive an intensity value");

    assert_eq!(*value, ParameterValue::Absolute { value: 30.0 });
    assert_eq!(materialized.max_fade_in, Duration::from_millis(200));
    assert_eq!(materialized.max_delay_in, Duration::from_millis(500));
    assert_eq!(
        materialized.max_assertion_duration,
        Duration::from_millis(500)
    );
    let duration_profile = materialized.duration_profile();
    assert_eq!(duration_profile.max_fade_in, materialized.max_fade_in);
    assert_eq!(duration_profile.max_delay_in, materialized.max_delay_in);
    assert_eq!(
        duration_profile.cue_entry_duration(),
        materialized.max_assertion_duration
    );

    let mut system_state =
        SystemState::<(Res<FixtureDataProviderExt>, SpatialSelectionResolver)>::new(
            app.world_mut(),
        );
    let (fixture_data_provider, selection_resolver) = system_state
        .get(app.world_mut())
        .expect("test system parameters should be available");
    assert_eq!(
        fixture_data_provider.cue_duration_profile(&cue, &selection_resolver),
        duration_profile
    );
    assert_eq!(
        transition
            .as_ref()
            .expect("transition should be materialized")
            .start_position,
        materialized.start_position
    );
}

/// Verifies cue-part timing falls back to parent cue timing before defaults.
#[test]
fn materialize_cue_part_inherits_parent_cue_transition() {
    let mut app = App::new();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();

    let fixture =
        add_single_element_fixture(app.world_mut(), 1, &[(Attribute::Intensity, 0.0, 255.0)]).0;

    let instruction = |value| BoundCueInstruction {
        selection: SpatialSelection::identity(SelectionExpr::Resolved(vec![fixture.clone()])),
        cue_instruction: CueInstruction {
            blueprint_application: None,
            values: HashMap::from([(
                Attribute::Intensity,
                ValueSource::Inline(ParameterValue::Absolute { value }),
            )]),
            ..Default::default()
        },
    };

    let cue = Cue {
        transitions: PartialTransition {
            fade_out: Some(TransitionMode::Fixed(Duration::from_millis(750))),
            ..Default::default()
        },
        instructions: vec![instruction(100.0)],
        parts: vec![CuePart {
            identifiers: Identifiers {
                id: 1,
                label: "Part 1".to_owned(),
                ..Default::default()
            },
            transitions: PartialTransition {
                delay_in: Some(TransitionMode::Fixed(Duration::from_millis(250))),
                ..Default::default()
            },
            instructions: vec![instruction(0.0)],
            ..Default::default()
        }],
        ..Default::default()
    };

    let (materialized, _) = make_materialized_cue(app.world_mut(), &cue);
    let fixture_data_provider = app.world().resource::<FixtureDataProviderExt>();
    let parameter =
        fixture_data_provider.parameter_for_element_attribute(&fixture, &Attribute::Intensity);
    let transition = materialized
        .values
        .absolute
        .get(&parameter)
        .and_then(|(_, transition)| transition.as_ref())
        .expect("part value should materialize with inherited transition");

    assert_eq!(
        materialized
            .values
            .absolute
            .get(&parameter)
            .map(|(value, _)| *value),
        Some(ParameterValue::Absolute { value: 0.0 })
    );
    assert_eq!(transition.delay_in, Duration::from_millis(250));
    assert_eq!(transition.fade_out, Duration::from_millis(750));
    assert_eq!(
        materialized.max_assertion_duration,
        Duration::from_millis(750)
    );
}

/// Keeps each authored value type when a fan has one waypoint per selected target.
#[test]
fn exact_fan_waypoints_preserve_mixed_value_types() {
    let values = [
        ParameterValue::AbsolutePercent { value: 0.5.into() },
        ParameterValue::Absolute { value: 25.0 },
        ParameterValue::AbsolutePercent { value: 0.8.into() },
    ];
    for (index, expected) in values.iter().enumerate() {
        assert_eq!(
            MaterializedCue::resolve_fanned_value(&values, index, values.len()),
            *expected
        );
    }
}
