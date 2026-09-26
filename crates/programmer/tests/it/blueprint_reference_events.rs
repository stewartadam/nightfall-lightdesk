// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::collections::HashMap;

use bevy_app::prelude::*;
use nightfall::prelude::*;
use nightfall_cues::prelude::{BoundCueInstruction, CueInstruction};
use nightfall_desk::prelude::BlueprintAction;
use nightfall_dmx::prelude::{Attribute, AttributeCategory, ParameterValue};
use nightfall_engine::prelude::*;
use nightfall_fixtures::prelude::{
    Fixture, FixtureDataProviderExt, FixtureElement, ParameterMetadata,
};
use nightfall_programmer::events::{
    ProgrammerAttributeOperation, ProgrammerAttributeSource, ProgrammerCommand,
    StoreObjectWorkflows, handle_blueprint_events,
};
use nightfall_programmer::prelude::Programmer;
use uuid::Uuid;

/// Builds an event app containing the resources required by Blueprint application handling.
fn setup_app() -> App {
    let mut app = App::new();
    app.add_message::<CommandEnvelope<ProgrammerCommand>>();
    app.add_message::<EngineActionEnvelope<BlueprintAction>>();
    app.add_message::<CommandResult>();
    app.add_message::<CommandReply>();
    app.add_message::<FinishedCommand>();
    app.add_message::<CommandNotice>();
    app.init_resource::<CommandTracker>();
    app.init_resource::<Programmer>();
    app.init_resource::<StoreObjectWorkflows>();
    app.init_resource::<DataProvider<Blueprint>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();
    app.add_systems(Update, handle_blueprint_events);

    app.world_mut()
        .resource_mut::<FixtureDataProviderExt>()
        .inner
        .add(Fixture {
            identifiers: Identifiers {
                id: 13,
                uid: Uuid::from_u128(13),
                label: "Fixture 13".to_owned(),
            },
            elements: vec![FixtureElement {
                parameters: vec![
                    ParameterMetadata {
                        attribute: Attribute::Red,
                        ..Default::default()
                    },
                    ParameterMetadata {
                        attribute: Attribute::Blue,
                        ..Default::default()
                    },
                ],
                ..Default::default()
            }],
            ..Default::default()
        })
        .expect("fixture should be insertable");
    app.world_mut()
        .resource_mut::<Programmer>()
        .set_active_selection(SelectionExpr::Fixture(UnresolvedFixtureRef {
            fixture_id: 13,
            element_index: None,
        }));
    app
}

/// Builds an attribute Blueprint with deterministic identity and values.
fn blueprint(id: u32, uid: Uuid, label: &str) -> Blueprint {
    Blueprint {
        identifiers: Identifiers {
            id,
            uid,
            label: label.to_owned(),
        },
        values: HashMap::from([
            (
                Attribute::Red,
                ValueSource::Inline(ParameterValue::Absolute { value: 64.0 }),
            ),
            (
                Attribute::Blue,
                ValueSource::Inline(ParameterValue::Absolute { value: 96.0 }),
            ),
        ]),
        ..Default::default()
    }
}

/// Sends one detached programmer command through the real event handler.
fn send_command(app: &mut App, command: ProgrammerCommand) {
    let envelope = CommandEnvelope::new(command, CommandOrigin::Cli, ReplyTarget::Detached);
    app.world_mut()
        .resource_mut::<CommandTracker>()
        .register(&envelope)
        .expect("command should be tracked");
    app.world_mut().write_message(envelope);
    app.update();
}

/// Drains non-terminal command feedback emitted by Blueprint application handling.
fn command_notices(app: &mut App) -> Vec<String> {
    app.world_mut()
        .resource_mut::<bevy_ecs::prelude::Messages<CommandNotice>>()
        .drain()
        .map(|notice| notice.message)
        .collect()
}

/// Drains structured failure codes produced by the Blueprint command handler.
fn command_error_codes(app: &mut App) -> Vec<String> {
    app.world_mut()
        .resource_mut::<bevy_ecs::prelude::Messages<CommandResult>>()
        .drain()
        .filter_map(|result| match result.outcome {
            CommandOutcome::Failed(error) => Some(error.code),
            CommandOutcome::Succeeded { .. } => None,
        })
        .collect()
}

/// Reference mode stores UUID plus selector, while absolute mode stores current values only.
#[test]
fn applies_blueprints_by_reference_or_absolute_value() {
    let mut app = setup_app();
    let uid = Uuid::new_v4();
    app.world_mut()
        .resource_mut::<DataProvider<Blueprint>>()
        .add(blueprint(5, uid, "Sunset"))
        .expect("blueprint should be insertable");

    send_command(
        &mut app,
        ProgrammerCommand::ApplyAttributeOperations {
            selection: None,
            operations: vec![ProgrammerAttributeOperation {
                target: BlueprintSelector::Category(AttributeCategory::Color),
                source: ProgrammerAttributeSource::Blueprint {
                    address: BlueprintAddress::Label("sunset".to_owned()),
                    resolution: BlueprintResolution::Reference,
                },
            }],
            transitions: Default::default(),
            transitions_by_attribute: Default::default(),
        },
    );
    send_command(
        &mut app,
        ProgrammerCommand::ApplyAttributeOperations {
            selection: None,
            operations: vec![ProgrammerAttributeOperation {
                target: BlueprintSelector::Attribute(Attribute::Red),
                source: ProgrammerAttributeSource::Blueprint {
                    address: BlueprintAddress::Id(5),
                    resolution: BlueprintResolution::Absolute,
                },
            }],
            transitions: Default::default(),
            transitions_by_attribute: Default::default(),
        },
    );

    let programmer = app.world().resource::<Programmer>();
    let instructions = programmer
        .active_instructions()
        .iter()
        .map(|(_, instruction)| &instruction.cue_instruction)
        .collect::<Vec<&CueInstruction>>();
    assert_eq!(instructions.len(), 2);
    assert_eq!(
        instructions[0].blueprint_application,
        Some(BlueprintApplication {
            blueprint_uid: uid,
            selector: BlueprintSelector::Category(AttributeCategory::Color),
        })
    );
    assert!(instructions[0].values.is_empty());
    assert!(instructions[1].blueprint_application.is_none());
    assert_eq!(instructions[1].values.len(), 1);
    assert!(instructions[1].values.contains_key(&Attribute::Red));
}

/// Mixed selections retain the reference while warning about unsupported attribute targets.
#[test]
fn blueprint_attribute_application_warns_for_unsupported_selected_fixture() {
    let mut app = setup_app();
    let blueprint_uid = Uuid::new_v4();
    app.world_mut()
        .resource_mut::<DataProvider<Blueprint>>()
        .add(blueprint(5, blueprint_uid, "Sunset"))
        .expect("Blueprint should be insertable");
    app.world_mut()
        .resource_mut::<FixtureDataProviderExt>()
        .inner
        .add(Fixture {
            identifiers: Identifiers {
                id: 14,
                uid: Uuid::from_u128(14),
                label: "Intensity only".to_owned(),
            },
            elements: vec![FixtureElement {
                parameters: vec![ParameterMetadata {
                    attribute: Attribute::Intensity,
                    ..Default::default()
                }],
                ..Default::default()
            }],
            ..Default::default()
        })
        .expect("fixture should be insertable");
    app.world_mut()
        .resource_mut::<Programmer>()
        .set_active_selection(SelectionExpr::Resolved(vec![
            FixtureRef {
                fixture_uid: Uuid::from_u128(13),
                index: None,
            },
            FixtureRef {
                fixture_uid: Uuid::from_u128(14),
                index: None,
            },
        ]));

    send_command(
        &mut app,
        ProgrammerCommand::ApplyAttributeOperations {
            selection: None,
            operations: vec![ProgrammerAttributeOperation {
                target: BlueprintSelector::Attribute(Attribute::Red),
                source: ProgrammerAttributeSource::Blueprint {
                    address: BlueprintAddress::Id(5),
                    resolution: BlueprintResolution::Reference,
                },
            }],
            transitions: Default::default(),
            transitions_by_attribute: Default::default(),
        },
    );

    let notices = command_notices(&mut app);
    assert!(notices.iter().any(|notice| {
        notice.contains("blueprint.attribute_unsupported") && notice.contains("fixture 14")
    }));
    assert_eq!(
        app.world()
            .resource::<Programmer>()
            .active_instructions()
            .len(),
        1
    );
}

/// Category recalls report targets that expose none of the selected Blueprint values.
#[test]
fn blueprint_category_application_warns_when_target_has_no_applicable_values() {
    let mut app = setup_app();
    app.world_mut()
        .resource_mut::<DataProvider<Blueprint>>()
        .add(blueprint(5, Uuid::new_v4(), "Sunset"))
        .expect("Blueprint should be insertable");
    app.world_mut()
        .resource_mut::<FixtureDataProviderExt>()
        .inner
        .add(Fixture {
            identifiers: Identifiers {
                id: 14,
                uid: Uuid::from_u128(14),
                label: "Intensity only".to_owned(),
            },
            elements: vec![FixtureElement {
                parameters: vec![ParameterMetadata {
                    attribute: Attribute::Intensity,
                    ..Default::default()
                }],
                ..Default::default()
            }],
            ..Default::default()
        })
        .expect("fixture should be insertable");
    app.world_mut()
        .resource_mut::<Programmer>()
        .set_active_selection(SelectionExpr::Fixture(UnresolvedFixtureRef {
            fixture_id: 14,
            element_index: None,
        }));

    send_command(
        &mut app,
        ProgrammerCommand::ApplyAttributeOperations {
            selection: None,
            operations: vec![ProgrammerAttributeOperation {
                target: BlueprintSelector::Category(AttributeCategory::Color),
                source: ProgrammerAttributeSource::Blueprint {
                    address: BlueprintAddress::Id(5),
                    resolution: BlueprintResolution::Reference,
                },
            }],
            transitions: Default::default(),
            transitions_by_attribute: Default::default(),
        },
    );

    assert!(command_notices(&mut app).iter().any(|notice| {
        notice.contains("blueprint.no_applicable_values") && notice.contains("fixture 14")
    }));
}

/// Large pixel selections produce bounded feedback instead of one toast per pixel.
#[test]
fn blueprint_incompatible_pixel_selection_emits_one_summary() {
    let mut app = setup_app();
    let mut pan_tilt = blueprint(2, Uuid::new_v4(), "Pan Tilt");
    pan_tilt.values = HashMap::from([
        (
            Attribute::Pan,
            ValueSource::Inline(ParameterValue::Absolute { value: 25.0 }),
        ),
        (
            Attribute::Tilt,
            ValueSource::Inline(ParameterValue::Absolute { value: 75.0 }),
        ),
    ]);
    app.world_mut()
        .resource_mut::<DataProvider<Blueprint>>()
        .add(pan_tilt)
        .unwrap();
    let mut selection = Vec::new();
    for id in 310..326 {
        let uid = Uuid::from_u128(id as u128);
        app.world_mut()
            .resource_mut::<FixtureDataProviderExt>()
            .inner
            .add(Fixture {
                identifiers: Identifiers {
                    id,
                    uid,
                    label: format!("Tape {id}"),
                },
                elements: vec![
                    FixtureElement {
                        parameters: vec![ParameterMetadata {
                            attribute: Attribute::Red,
                            ..Default::default()
                        }],
                        ..Default::default()
                    };
                    40
                ],
                ..Default::default()
            })
            .unwrap();
        selection.push(FixtureRef {
            fixture_uid: uid,
            index: None,
        });
    }
    app.world_mut()
        .resource_mut::<Programmer>()
        .set_active_selection(SelectionExpr::Resolved(selection));
    send_command(
        &mut app,
        ProgrammerCommand::ApplyAttributeOperations {
            selection: None,
            operations: vec![ProgrammerAttributeOperation {
                target: BlueprintSelector::All,
                source: ProgrammerAttributeSource::Blueprint {
                    address: BlueprintAddress::Id(2),
                    resolution: BlueprintResolution::Reference,
                },
            }],
            transitions: Default::default(),
            transitions_by_attribute: Default::default(),
        },
    );
    let notices = command_notices(&mut app);
    assert_eq!(
        notices.len(),
        1,
        "compatibility feedback must not flood the UI"
    );
    assert!(notices[0].contains("640"));
    assert!(notices[0].contains("blueprint.no_applicable_values"));
    assert!(notices[0].len() < 1000);
}

/// Blueprint capture applies ordered whole-fixture overrides to earlier element rows.
#[test]
fn blueprint_capture_expands_overlapping_fixture_and_element_selections() {
    let mut app = setup_app();
    let fixture_uid = Uuid::from_u128(14);
    app.world_mut()
        .resource_mut::<FixtureDataProviderExt>()
        .inner
        .add(Fixture {
            identifiers: Identifiers {
                id: 14,
                uid: fixture_uid,
                label: "Two element".to_owned(),
            },
            elements: vec![
                FixtureElement {
                    parameters: vec![ParameterMetadata {
                        attribute: Attribute::Red,
                        ..Default::default()
                    }],
                    ..Default::default()
                },
                FixtureElement {
                    parameters: vec![ParameterMetadata {
                        attribute: Attribute::Red,
                        ..Default::default()
                    }],
                    ..Default::default()
                },
            ],
            ..Default::default()
        })
        .expect("fixture should be insertable");
    {
        let mut programmer = app.world_mut().resource_mut::<Programmer>();
        programmer.add_instruction(BoundCueInstruction {
            selection: SelectionExpr::Resolved(vec![FixtureRef {
                fixture_uid,
                index: Some(1),
            }])
            .into(),
            cue_instruction: CueInstruction {
                values: HashMap::from([(
                    Attribute::Red,
                    ValueSource::Inline(ParameterValue::Absolute { value: 10.0 }),
                )]),
                ..Default::default()
            },
        });
        programmer.add_instruction(BoundCueInstruction {
            selection: SelectionExpr::Resolved(vec![FixtureRef {
                fixture_uid,
                index: None,
            }])
            .into(),
            cue_instruction: CueInstruction {
                values: HashMap::from([(
                    Attribute::Red,
                    ValueSource::Inline(ParameterValue::Absolute { value: 20.0 }),
                )]),
                ..Default::default()
            },
        });
    }

    send_command(
        &mut app,
        ProgrammerCommand::StoreBlueprint {
            blueprint_id: 6,
            filter: vec![BlueprintSelector::Attribute(Attribute::Red)],
        },
    );

    let actions = app
        .world_mut()
        .resource_mut::<bevy_ecs::prelude::Messages<EngineActionEnvelope<BlueprintAction>>>()
        .drain()
        .collect::<Vec<_>>();
    let [action] = actions.as_slice() else {
        panic!("capture should enqueue exactly one Blueprint action");
    };
    let BlueprintAction::StoreBlueprint(stored) = &action.action;
    assert_eq!(
        stored.values.get(&Attribute::Red),
        Some(&ValueSource::Inline(ParameterValue::Absolute {
            value: 20.0
        }))
    );
}

/// Ambiguous labels fail before any programmer row is inserted.
#[test]
fn ambiguous_blueprint_label_is_atomic() {
    let mut app = setup_app();
    for (id, uid) in [(5, Uuid::new_v4()), (6, Uuid::new_v4())] {
        app.world_mut()
            .resource_mut::<DataProvider<Blueprint>>()
            .add(blueprint(id, uid, "Same"))
            .expect("blueprint should be insertable");
    }
    send_command(
        &mut app,
        ProgrammerCommand::ApplyAttributeOperations {
            selection: None,
            operations: vec![ProgrammerAttributeOperation {
                target: BlueprintSelector::All,
                source: ProgrammerAttributeSource::Blueprint {
                    address: BlueprintAddress::Label("same".to_owned()),
                    resolution: BlueprintResolution::Reference,
                },
            }],
            transitions: Default::default(),
            transitions_by_attribute: Default::default(),
        },
    );
    assert!(
        app.world()
            .resource::<Programmer>()
            .active_instructions()
            .is_empty()
    );
}

/// Missing definitions and empty selectors fail without appending partial programmer rows.
#[test]
fn missing_blueprints_and_empty_selectors_are_atomic() {
    let mut app = setup_app();
    app.world_mut()
        .resource_mut::<DataProvider<Blueprint>>()
        .add(blueprint(5, Uuid::new_v4(), "Sunset"))
        .expect("Blueprint should be insertable");

    for (target, address, expected_code) in [
        (
            BlueprintSelector::Category(AttributeCategory::Position),
            BlueprintAddress::Id(5),
            "blueprint.category_empty",
        ),
        (
            BlueprintSelector::Attribute(Attribute::Pan),
            BlueprintAddress::Id(5),
            "blueprint.attribute_missing",
        ),
        (
            BlueprintSelector::All,
            BlueprintAddress::Id(99),
            "blueprint.not_found",
        ),
    ] {
        send_command(
            &mut app,
            ProgrammerCommand::ApplyAttributeOperations {
                selection: None,
                operations: vec![ProgrammerAttributeOperation {
                    target,
                    source: ProgrammerAttributeSource::Blueprint {
                        address,
                        resolution: BlueprintResolution::Reference,
                    },
                }],
                transitions: Default::default(),
                transitions_by_attribute: Default::default(),
            },
        );
        assert_eq!(command_error_codes(&mut app), vec![expected_code]);
        assert!(
            app.world()
                .resource::<Programmer>()
                .active_instructions()
                .is_empty()
        );
    }
}

/// Empty and fixture-dependent Blueprint captures fail before object-store actions are emitted.
#[test]
fn blueprint_capture_rejects_empty_and_conflicting_values() {
    let mut app = setup_app();
    app.world_mut().resource_mut::<Programmer>().clear();
    send_command(
        &mut app,
        ProgrammerCommand::StoreBlueprint {
            blueprint_id: 7,
            filter: vec![],
        },
    );
    assert_eq!(
        command_error_codes(&mut app),
        vec!["blueprint.capture_empty"]
    );

    let second_uid = Uuid::from_u128(14);
    app.world_mut()
        .resource_mut::<FixtureDataProviderExt>()
        .inner
        .add(Fixture {
            identifiers: Identifiers {
                id: 14,
                uid: second_uid,
                label: "Fixture 14".to_owned(),
            },
            elements: vec![FixtureElement {
                parameters: vec![ParameterMetadata {
                    attribute: Attribute::Red,
                    ..Default::default()
                }],
                ..Default::default()
            }],
            ..Default::default()
        })
        .expect("second fixture should be insertable");
    {
        let mut programmer = app.world_mut().resource_mut::<Programmer>();
        for (fixture_uid, value) in [(Uuid::from_u128(13), 10.0), (second_uid, 20.0)] {
            programmer.add_instruction(BoundCueInstruction {
                selection: SelectionExpr::Resolved(vec![FixtureRef {
                    fixture_uid,
                    index: None,
                }])
                .into(),
                cue_instruction: CueInstruction {
                    values: HashMap::from([(
                        Attribute::Red,
                        ValueSource::Inline(ParameterValue::Absolute { value }),
                    )]),
                    ..Default::default()
                },
            });
        }
    }
    send_command(
        &mut app,
        ProgrammerCommand::StoreBlueprint {
            blueprint_id: 7,
            filter: vec![],
        },
    );
    assert_eq!(
        command_error_codes(&mut app),
        vec!["blueprint.capture_conflict"]
    );
    assert!(
        app.world_mut()
            .resource_mut::<bevy_ecs::prelude::Messages<EngineActionEnvelope<BlueprintAction>>>()
            .drain()
            .next()
            .is_none()
    );
}

/// Blueprint capture retains one authored fan instead of expanding fixture-specific values.
#[test]
fn blueprint_capture_retains_fanned_intent() {
    let mut app = setup_app();
    let fan = ValueSource::Fanned {
        values: vec![
            ParameterValue::AbsolutePercent { value: 0.0.into() },
            ParameterValue::AbsolutePercent { value: 1.0.into() },
        ],
    };
    {
        let mut programmer = app.world_mut().resource_mut::<Programmer>();
        programmer.clear();
        programmer.add_instruction(BoundCueInstruction {
            selection: SelectionExpr::Resolved(vec![FixtureRef {
                fixture_uid: Uuid::from_u128(13),
                index: None,
            }])
            .into(),
            cue_instruction: CueInstruction {
                values: HashMap::from([(Attribute::Red, fan.clone())]),
                ..Default::default()
            },
        });
    }

    send_command(
        &mut app,
        ProgrammerCommand::StoreBlueprint {
            blueprint_id: 8,
            filter: vec![BlueprintSelector::Attribute(Attribute::Red)],
        },
    );

    let actions = app
        .world_mut()
        .resource_mut::<bevy_ecs::prelude::Messages<EngineActionEnvelope<BlueprintAction>>>()
        .drain()
        .collect::<Vec<_>>();
    let [action] = actions.as_slice() else {
        panic!("fanned capture should enqueue one Blueprint action");
    };
    let BlueprintAction::StoreBlueprint(stored) = &action.action;
    assert_eq!(stored.values.get(&Attribute::Red), Some(&fan));
}

/// Capturing referenced programmer rows copies current logical values into a self-contained object.
#[test]
fn blueprint_capture_flattens_referenced_programmer_values() {
    let mut app = setup_app();
    let source_uid = Uuid::new_v4();
    let source = blueprint(5, source_uid, "Source");
    app.world_mut()
        .resource_mut::<DataProvider<Blueprint>>()
        .add(source.clone())
        .expect("source Blueprint should be insertable");
    app.world_mut()
        .resource_mut::<Programmer>()
        .add_instruction(BoundCueInstruction {
            selection: SelectionExpr::Resolved(vec![FixtureRef {
                fixture_uid: Uuid::from_u128(13),
                index: None,
            }])
            .into(),
            cue_instruction: CueInstruction {
                blueprint_application: Some(BlueprintApplication {
                    blueprint_uid: source_uid,
                    selector: BlueprintSelector::Category(AttributeCategory::Color),
                }),
                ..Default::default()
            },
        });

    send_command(
        &mut app,
        ProgrammerCommand::StoreBlueprint {
            blueprint_id: 9,
            filter: vec![],
        },
    );

    let actions = app
        .world_mut()
        .resource_mut::<bevy_ecs::prelude::Messages<EngineActionEnvelope<BlueprintAction>>>()
        .drain()
        .collect::<Vec<_>>();
    let [action] = actions.as_slice() else {
        panic!("referenced capture should enqueue one Blueprint action");
    };
    let BlueprintAction::StoreBlueprint(stored) = &action.action;
    assert_eq!(stored.values, source.values);
    assert_ne!(stored.identifiers.uid, source_uid);
}
