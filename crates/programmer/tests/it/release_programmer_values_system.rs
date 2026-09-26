// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::collections::{HashMap, HashSet};

use bevy_app::prelude::*;
use bevy_ecs::prelude::Messages;
use bevy_ecs::schedule::IntoScheduleConfigs;
use nightfall::prelude::*;
use nightfall_cues::CueLifecycleAction;
use nightfall_cues::prelude::{BoundCueInstruction, CueInstruction};
use nightfall_desk::prelude::{DeskSettings, SelectionFlattenPolicy};
use nightfall_dmx::prelude::{Attribute, ParameterValue};
use nightfall_engine::prelude::{
    CommandEnvelope, CommandError, CommandId, CommandNotice, CommandOrigin, CommandOutcome,
    CommandReply, CommandResult, CommandTracker, DataProvider, EngineActionEnvelope,
    FinishedCommand, OperationResult, PayloadEnvelope, PendingCommandBuffer,
    PendingEngineActionBuffer, ReplyTarget,
};
use nightfall_fixtures::prelude::{Fixture, FixtureDataProviderExt, FixtureElement};
use nightfall_instances::{PlaybackAction, PlaybackScope};
use nightfall_programmer::events::{
    PendingUserCommandPlans, ProgrammerCommand, SelectionFlattenApprovals,
    handle_programmer_events, plan_pending_user_commands,
};
use nightfall_programmer::prelude::{
    AttributeFilter, ClearCommand, ClearTarget, Programmer, ProgrammerAction, Scope, UserCommand,
};
use uuid::Uuid;

fn test_fixture_ref(seed: u128) -> FixtureRef {
    FixtureRef {
        fixture_uid: Uuid::from_u128(seed),
        index: Some(1),
    }
}

fn test_fixture(fixture_id: u32) -> Fixture {
    Fixture {
        identifiers: Identifiers {
            id: fixture_id,
            uid: Uuid::from_u128(fixture_id as u128),
            label: format!("Fixture {}", fixture_id),
        },
        make: "Test".to_string(),
        model: "Fixture".to_string(),
        mode: "Mode".to_string(),
        elements: vec![FixtureElement::default()],
        ..Default::default()
    }
}

/// Builds a fixture with a caller-selected number of elements for release splitting tests.
fn test_fixture_with_elements(fixture_id: u32, element_count: usize) -> Fixture {
    Fixture {
        elements: vec![FixtureElement::default(); element_count],
        ..test_fixture(fixture_id)
    }
}

fn instruction_with_red_blue() -> CueInstruction {
    CueInstruction {
        blueprint_application: None,
        values: HashMap::from([
            (
                Attribute::Red,
                ValueSource::Inline(ParameterValue::Absolute { value: 255.0 }),
            ),
            (
                Attribute::Blue,
                ValueSource::Inline(ParameterValue::Absolute { value: 128.0 }),
            ),
        ]),
        transitions: Default::default(),
        transitions_by_attribute: Default::default(),
        transitions_by_fixture_attribute: Default::default(),
        color_path_id: None,
    }
}

fn setup_app() -> App {
    let mut app = App::new();
    app.add_message::<CommandEnvelope<ProgrammerCommand>>();
    app.add_message::<EngineActionEnvelope<CueLifecycleAction>>();
    app.add_message::<EngineActionEnvelope<ProgrammerAction>>();
    app.add_message::<EngineActionEnvelope<PlaybackAction>>();
    app.add_message::<OperationResult<(), CommandError>>();
    app.add_message::<CommandResult>();
    app.add_message::<CommandReply>();
    app.add_message::<FinishedCommand>();
    app.add_message::<CommandNotice>();
    app.init_resource::<CommandTracker>();
    app.init_resource::<SelectionFlattenApprovals>();
    app.init_resource::<PendingUserCommandPlans>();
    app.init_resource::<PendingCommandBuffer>();
    app.init_resource::<PendingEngineActionBuffer>();
    app.insert_resource(Programmer::default());
    app.insert_resource(DeskSettings::default());
    app.insert_resource(FixtureDataProviderExt::default());
    app.insert_resource(DataProvider::<Group>::default());
    app.add_systems(
        Update,
        (plan_pending_user_commands, handle_programmer_events).chain(),
    );
    app
}

fn fixture_attribute_map(programmer: &Programmer) -> HashMap<FixtureRef, HashSet<Attribute>> {
    let mut map: HashMap<FixtureRef, HashSet<Attribute>> = HashMap::new();
    for (_uid, instruction) in programmer.active_instructions().iter() {
        let SelectionExpr::Resolved(fixtures) = &instruction.selection.source else {
            continue;
        };
        let attrs: HashSet<Attribute> =
            instruction.cue_instruction.values.keys().cloned().collect();
        for fixture in fixtures {
            map.insert(fixture.clone(), attrs.clone());
        }
    }
    map
}

fn emit_release_action(
    app: &mut App,
    correlation_id: Uuid,
    selection: Option<SelectionExpr>,
    attributes: Vec<Attribute>,
) {
    app.world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<ProgrammerAction>>>()
        .write(EngineActionEnvelope::for_command_context(
            correlation_id.into(),
            correlation_id.into(),
            ProgrammerAction::ReleaseValues {
                scope: selection.map_or(Scope::All, Scope::Selection),
                attributes: AttributeFilter::from_attributes(&attributes),
                allow_selection_flatten: false,
            },
        ));
}

fn emit_programmer_command(app: &mut App, correlation_id: Uuid, payload: ProgrammerCommand) {
    app.world_mut().write_message(CommandEnvelope::with_context(
        correlation_id.into(),
        correlation_id.into(),
        CommandOrigin::Cli,
        ReplyTarget::Detached,
        payload,
    ));
}

/// Builds a live category Blueprint row with no copied direct values.
fn referenced_color_instruction(fixtures: Vec<FixtureRef>) -> BoundCueInstruction {
    BoundCueInstruction {
        selection: SelectionExpr::Resolved(fixtures).into(),
        cue_instruction: CueInstruction {
            blueprint_application: Some(BlueprintApplication {
                blueprint_uid: Uuid::from_u128(5000),
                selector: BlueprintSelector::Category(
                    nightfall_dmx::prelude::AttributeCategory::Color,
                ),
            }),
            values: HashMap::new(),
            ..Default::default()
        },
    }
}

/// Verifies releasing an unrelated attribute preserves an otherwise value-empty live row.
#[test]
fn release_unrelated_attribute_preserves_blueprint_reference() {
    let mut app = setup_app();
    let fixture = test_fixture_ref(701);
    app.world_mut()
        .resource_mut::<FixtureDataProviderExt>()
        .inner
        .add(test_fixture(701))
        .expect("fixture should be added");
    app.world_mut()
        .resource_mut::<Programmer>()
        .add_instruction(referenced_color_instruction(vec![fixture]));

    emit_release_action(&mut app, Uuid::new_v4(), None, vec![Attribute::Pan]);
    app.update();

    let programmer = app.world().resource::<Programmer>();
    let instructions = programmer.active_instructions().iter().collect::<Vec<_>>();
    assert_eq!(instructions.len(), 1);
    assert!(
        instructions[0]
            .1
            .cue_instruction
            .blueprint_application
            .is_some()
    );
}

/// Verifies a matching selected release removes only the matched portion of a live row.
#[test]
fn release_matching_attribute_splits_blueprint_reference_selection() {
    let mut app = setup_app();
    let first = test_fixture_ref(702);
    let second = test_fixture_ref(703);
    {
        let mut fixtures = app.world_mut().resource_mut::<FixtureDataProviderExt>();
        fixtures
            .inner
            .add(test_fixture(702))
            .expect("first fixture should be added");
        fixtures
            .inner
            .add(test_fixture(703))
            .expect("second fixture should be added");
    }
    app.world_mut()
        .resource_mut::<Programmer>()
        .add_instruction(referenced_color_instruction(vec![
            first.clone(),
            second.clone(),
        ]));

    emit_release_action(
        &mut app,
        Uuid::new_v4(),
        Some(SelectionExpr::Resolved(vec![first])),
        vec![Attribute::Red],
    );
    app.update();

    let programmer = app.world().resource::<Programmer>();
    let instructions = programmer.active_instructions().iter().collect::<Vec<_>>();
    assert_eq!(instructions.len(), 1);
    assert_eq!(
        instructions[0].1.selection.source,
        SelectionExpr::Resolved(vec![second])
    );
    assert!(
        instructions[0]
            .1
            .cue_instruction
            .blueprint_application
            .is_some()
    );
}

/// Verifies a tracked clear-selection command succeeds only after applying its mutation.
#[test]
fn tracked_clear_selection_finishes_after_mutation() {
    let mut app = setup_app();
    let fixture = test_fixture_ref(990);
    app.world_mut()
        .resource_mut::<Programmer>()
        .set_active_selection(SelectionExpr::Resolved(vec![fixture]));
    let envelope = CommandEnvelope::new(
        ProgrammerCommand::ClearProgrammerSelection,
        CommandOrigin::WebUi,
        ReplyTarget::Detached,
    );
    let command_id = envelope.command_id;
    app.world_mut()
        .resource_mut::<CommandTracker>()
        .register(&envelope)
        .expect("clear selection command should register");
    app.world_mut().write_message(envelope);

    app.update();

    assert!(
        app.world()
            .resource::<Programmer>()
            .active_selection()
            .is_empty()
    );
    let results: Vec<_> = app
        .world_mut()
        .resource_mut::<Messages<CommandResult>>()
        .drain()
        .collect();
    assert!(matches!(
        results.as_slice(),
        [CommandResult {
            command_id: result_command_id,
            outcome: CommandOutcome::Succeeded { output: None },
        }] if *result_command_id == command_id
    ));
}

#[test]
fn test_legacy_clear_programmer_is_handled() {
    let mut app = setup_app();
    let fixture = test_fixture_ref(401);
    let correlation_id = Uuid::new_v4();

    {
        let mut programmer = app.world_mut().resource_mut::<Programmer>();
        programmer.set_active_selection(SelectionExpr::Resolved(vec![fixture.clone()]));
        programmer.add_instruction(BoundCueInstruction {
            selection: SelectionExpr::Resolved(vec![fixture]).into(),
            cue_instruction: instruction_with_red_blue(),
        });
    }

    emit_programmer_command(&mut app, correlation_id, ProgrammerCommand::ClearProgrammer);
    app.update();

    let programmer = app.world().resource::<Programmer>();
    assert!(
        programmer.active_selection().is_empty(),
        "clear programmer should clear active selection when selection exists",
    );
    assert_eq!(
        programmer.active_instructions().len(),
        1,
        "clear programmer should keep values when it clears selection",
    );
}

#[test]
fn test_legacy_clear_programmer_selection_is_handled() {
    let mut app = setup_app();
    let fixture = test_fixture_ref(402);
    let correlation_id = Uuid::new_v4();

    {
        let mut programmer = app.world_mut().resource_mut::<Programmer>();
        programmer.set_active_selection(SelectionExpr::Resolved(vec![fixture]));
    }

    emit_programmer_command(
        &mut app,
        correlation_id,
        ProgrammerCommand::ClearProgrammerSelection,
    );
    app.update();

    let programmer = app.world().resource::<Programmer>();
    assert!(
        programmer.active_selection().is_empty(),
        "clear selection command should clear active selection",
    );
}

#[test]
fn test_legacy_clear_programmer_values_is_handled() {
    let mut app = setup_app();
    let fixture = test_fixture_ref(403);
    let correlation_id = Uuid::new_v4();

    {
        let mut programmer = app.world_mut().resource_mut::<Programmer>();
        programmer.add_instruction(BoundCueInstruction {
            selection: SelectionExpr::Resolved(vec![fixture]).into(),
            cue_instruction: instruction_with_red_blue(),
        });
    }

    emit_programmer_command(
        &mut app,
        correlation_id,
        ProgrammerCommand::ClearProgrammerValues,
    );
    app.update();

    let programmer = app.world().resource::<Programmer>();
    assert!(
        programmer.active_instructions().is_empty(),
        "clear values command should remove all active instructions",
    );
}

/// Verifies clearing all programmer values also drops retained recalled cue timing defaults.
#[test]
fn clear_programmer_values_clears_recalled_cue_timing_defaults() {
    let mut app = setup_app();
    let fixture = test_fixture_ref(405);
    let correlation_id = Uuid::new_v4();

    {
        let mut programmer = app.world_mut().resource_mut::<Programmer>();
        programmer.add_instruction(BoundCueInstruction {
            selection: SelectionExpr::Resolved(vec![fixture]).into(),
            cue_instruction: instruction_with_red_blue(),
        });
        programmer.set_recalled_cue_timing_defaults(
            PartialTransition {
                fade_in: Some(TransitionMode::Fixed(std::time::Duration::from_secs(5))),
                ..Default::default()
            },
            Default::default(),
        );
    }

    emit_programmer_command(
        &mut app,
        correlation_id,
        ProgrammerCommand::ClearProgrammerValues,
    );
    app.update();

    let programmer = app.world().resource::<Programmer>();
    assert!(
        programmer.active_instructions().is_empty(),
        "clear values command should remove all active instructions",
    );
    assert!(
        programmer.recalled_cue_timing_defaults.is_none(),
        "clear values command should drop recalled cue timing defaults",
    );
}

#[test]
fn test_legacy_release_programmer_values_is_handled() {
    let mut app = setup_app();
    let fixture = test_fixture_ref(404);
    let correlation_id = Uuid::new_v4();

    {
        let mut programmer = app.world_mut().resource_mut::<Programmer>();
        programmer.add_instruction(BoundCueInstruction {
            selection: SelectionExpr::Resolved(vec![fixture.clone()]).into(),
            cue_instruction: instruction_with_red_blue(),
        });
    }

    emit_programmer_command(
        &mut app,
        correlation_id,
        ProgrammerCommand::ReleaseProgrammerValues {
            selection: Some(SelectionExpr::Resolved(vec![fixture.clone()])),
            attributes: vec![Attribute::Red],
            allow_selection_flatten: false,
            selection_flatten_approval: None,
        },
    );
    app.update();

    let programmer = app.world().resource::<Programmer>();
    let attrs = fixture_attribute_map(&programmer);
    assert_eq!(
        attrs.get(&fixture),
        Some(&HashSet::from([Attribute::Blue])),
        "release values command should remove only filtered attributes",
    );
}

#[test]
fn test_release_programmer_values_with_selection_and_attr_filter() {
    let mut app = setup_app();
    let fixture_a = test_fixture_ref(1);
    let fixture_b = test_fixture_ref(2);

    {
        let mut programmer = app.world_mut().resource_mut::<Programmer>();
        programmer.add_instruction(BoundCueInstruction {
            selection: SelectionExpr::Resolved(vec![fixture_a.clone(), fixture_b.clone()]).into(),
            cue_instruction: instruction_with_red_blue(),
        });
    }

    emit_release_action(
        &mut app,
        Uuid::new_v4(),
        Some(SelectionExpr::Resolved(vec![fixture_a.clone()])),
        vec![Attribute::Red],
    );
    app.update();

    let programmer = app.world().resource::<Programmer>();
    let attrs = fixture_attribute_map(&programmer);
    assert_eq!(
        attrs.len(),
        2,
        "Expected split instructions for both fixtures"
    );
    assert_eq!(
        attrs.get(&fixture_a),
        Some(&HashSet::from([Attribute::Blue])),
        "Fixture A should keep only blue"
    );
    assert_eq!(
        attrs.get(&fixture_b),
        Some(&HashSet::from([Attribute::Red, Attribute::Blue])),
        "Fixture B should keep red and blue"
    );
}

/// Releasing all values for one element of a whole-fixture row preserves the other elements.
#[test]
fn test_release_programmer_values_splits_whole_fixture_for_element_clear() {
    let mut app = setup_app();
    let fixture = test_fixture_with_elements(311, 3);
    let fixture_uid = fixture.identifiers.uid;
    app.world_mut()
        .resource_mut::<FixtureDataProviderExt>()
        .inner
        .add(fixture)
        .expect("fixture should be added");

    {
        let mut programmer = app.world_mut().resource_mut::<Programmer>();
        programmer.add_instruction(BoundCueInstruction {
            selection: SelectionExpr::Fixture(UnresolvedFixtureRef {
                fixture_id: 311,
                element_index: None,
            })
            .into(),
            cue_instruction: instruction_with_red_blue(),
        });
    }

    emit_release_action(
        &mut app,
        Uuid::new_v4(),
        Some(SelectionExpr::Resolved(vec![FixtureRef {
            fixture_uid,
            index: Some(2),
        }])),
        vec![],
    );
    app.update();

    let programmer = app.world().resource::<Programmer>();
    let attrs = fixture_attribute_map(&programmer);
    assert_eq!(
        attrs,
        HashMap::from([
            (
                FixtureRef {
                    fixture_uid,
                    index: Some(1),
                },
                HashSet::from([Attribute::Red, Attribute::Blue]),
            ),
            (
                FixtureRef {
                    fixture_uid,
                    index: Some(3),
                },
                HashSet::from([Attribute::Red, Attribute::Blue]),
            ),
        ]),
        "Only the requested element should be removed from the programmer",
    );
}

/// Releasing one attribute for one element of a whole-fixture row keeps other attributes there.
#[test]
fn test_release_programmer_values_splits_whole_fixture_for_element_attribute_clear() {
    let mut app = setup_app();
    let fixture = test_fixture_with_elements(311, 3);
    let fixture_uid = fixture.identifiers.uid;
    app.world_mut()
        .resource_mut::<FixtureDataProviderExt>()
        .inner
        .add(fixture)
        .expect("fixture should be added");

    {
        let mut programmer = app.world_mut().resource_mut::<Programmer>();
        programmer.add_instruction(BoundCueInstruction {
            selection: SelectionExpr::Fixture(UnresolvedFixtureRef {
                fixture_id: 311,
                element_index: None,
            })
            .into(),
            cue_instruction: instruction_with_red_blue(),
        });
    }

    emit_release_action(
        &mut app,
        Uuid::new_v4(),
        Some(SelectionExpr::Resolved(vec![FixtureRef {
            fixture_uid,
            index: Some(2),
        }])),
        vec![Attribute::Red],
    );
    app.update();

    let programmer = app.world().resource::<Programmer>();
    let attrs = fixture_attribute_map(&programmer);
    assert_eq!(
        attrs,
        HashMap::from([
            (
                FixtureRef {
                    fixture_uid,
                    index: Some(1),
                },
                HashSet::from([Attribute::Red, Attribute::Blue]),
            ),
            (
                FixtureRef {
                    fixture_uid,
                    index: Some(2),
                },
                HashSet::from([Attribute::Blue]),
            ),
            (
                FixtureRef {
                    fixture_uid,
                    index: Some(3),
                },
                HashSet::from([Attribute::Red, Attribute::Blue]),
            ),
        ]),
        "The requested element should lose only the requested attribute",
    );
}

#[test]
fn test_release_programmer_values_without_selection_applies_globally() {
    let mut app = setup_app();
    let fixture_a = test_fixture_ref(11);
    let fixture_b = test_fixture_ref(22);

    {
        let mut programmer = app.world_mut().resource_mut::<Programmer>();
        programmer.add_instruction(BoundCueInstruction {
            selection: SelectionExpr::Resolved(vec![fixture_a.clone(), fixture_b.clone()]).into(),
            cue_instruction: instruction_with_red_blue(),
        });
    }

    emit_release_action(&mut app, Uuid::new_v4(), None, vec![Attribute::Red]);
    app.update();

    let programmer = app.world().resource::<Programmer>();
    let attrs = fixture_attribute_map(&programmer);
    assert_eq!(
        attrs.len(),
        2,
        "Expected split instructions for both fixtures"
    );
    assert_eq!(
        attrs.get(&fixture_a),
        Some(&HashSet::from([Attribute::Blue])),
        "Fixture A should have red released"
    );
    assert_eq!(
        attrs.get(&fixture_b),
        Some(&HashSet::from([Attribute::Blue])),
        "Fixture B should also have red released"
    );
}

#[test]
fn test_release_programmer_values_matches_group_selection_with_wildcard_indices() {
    let mut app = setup_app();
    let fixture = test_fixture(501);
    let fixture_ref_none = FixtureRef {
        fixture_uid: fixture.identifiers.uid,
        index: None,
    };
    let fixture_ref_indexed = FixtureRef {
        fixture_uid: fixture.identifiers.uid,
        index: Some(1),
    };

    {
        let mut fixtures = app.world_mut().resource_mut::<FixtureDataProviderExt>();
        fixtures
            .inner
            .add(fixture.clone())
            .expect("fixture should be added");
    }

    {
        let mut groups = app.world_mut().resource_mut::<DataProvider<Group>>();
        groups
            .add(Group {
                identifiers: Identifiers {
                    id: 13,
                    uid: Uuid::from_u128(13),
                    label: "Group 13".to_string(),
                },
                selection: SelectionExpr::Resolved(vec![fixture_ref_none]).into(),
                ..Default::default()
            })
            .expect("group should be added");
    }

    {
        let mut programmer = app.world_mut().resource_mut::<Programmer>();
        programmer.add_instruction(BoundCueInstruction {
            selection: SelectionExpr::Group(GroupRefExpr::ById(13)).into(),
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values: HashMap::from([(
                    Attribute::Red,
                    ValueSource::Inline(ParameterValue::Absolute { value: 255.0 }),
                )]),
                transitions: Default::default(),
                transitions_by_attribute: Default::default(),
                transitions_by_fixture_attribute: Default::default(),
                color_path_id: None,
            },
        });
    }

    emit_release_action(
        &mut app,
        Uuid::new_v4(),
        Some(SelectionExpr::Fixture(UnresolvedFixtureRef {
            fixture_id: 501,
            element_index: None,
        })),
        vec![],
    );
    app.update();

    let programmer = app.world().resource::<Programmer>();
    let attrs = fixture_attribute_map(&programmer);
    assert!(
        attrs.get(&fixture_ref_indexed).is_none(),
        "Fixture 501 should be removed from programmer after clear fix 501"
    );
    assert!(
        programmer.active_instructions().is_empty(),
        "No programmer instructions should remain for the released fixture"
    );
}

#[test]
fn test_release_programmer_values_emits_release_selection_for_full_release() {
    let mut app = setup_app();
    let fixture = test_fixture_ref(303);

    {
        let mut programmer = app.world_mut().resource_mut::<Programmer>();
        programmer.add_instruction(BoundCueInstruction {
            selection: SelectionExpr::Resolved(vec![fixture.clone()]).into(),
            cue_instruction: instruction_with_red_blue(),
        });
    }

    emit_release_action(
        &mut app,
        Uuid::new_v4(),
        Some(SelectionExpr::Resolved(vec![fixture.clone()])),
        vec![],
    );
    app.update();

    let action_events: Vec<_> = app
        .world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<PlaybackAction>>>()
        .drain()
        .collect();
    assert!(
        action_events.iter().any(|event| {
            matches!(
                &event.action,
                PlaybackAction::ReleaseParameters { scope: PlaybackScope::Selection(SelectionExpr::Resolved(fixtures)) }
                    if fixtures.len() == 1 && fixtures[0] == fixture
            )
        }),
        "full release should emit PlaybackAction::ReleaseParameters",
    );
}

#[test]
fn test_release_programmer_values_removes_fixture_from_group_range_instruction() {
    let mut app = setup_app();

    let mut group_13_fixtures = Vec::new();
    let mut group_14_fixtures = Vec::new();

    {
        let mut fixtures = app.world_mut().resource_mut::<FixtureDataProviderExt>();
        for fixture_id in 501..=524 {
            let fixture = test_fixture(fixture_id);
            fixtures
                .inner
                .add(fixture.clone())
                .expect("fixture should be added");
            let fixture_ref = FixtureRef {
                fixture_uid: fixture.identifiers.uid,
                index: None,
            };
            if fixture_id <= 512 {
                group_13_fixtures.push(fixture_ref);
            } else {
                group_14_fixtures.push(fixture_ref);
            }
        }
    }

    {
        let mut groups = app.world_mut().resource_mut::<DataProvider<Group>>();
        groups
            .add(Group {
                identifiers: Identifiers {
                    id: 13,
                    uid: Uuid::from_u128(13),
                    label: "Group 13".to_string(),
                },
                selection: SelectionExpr::Resolved(group_13_fixtures).into(),
                ..Default::default()
            })
            .expect("group 13 should be added");
        groups
            .add(Group {
                identifiers: Identifiers {
                    id: 14,
                    uid: Uuid::from_u128(14),
                    label: "Group 14".to_string(),
                },
                selection: SelectionExpr::Resolved(group_14_fixtures).into(),
                ..Default::default()
            })
            .expect("group 14 should be added");
    }

    {
        let mut programmer = app.world_mut().resource_mut::<Programmer>();
        programmer.add_instruction(BoundCueInstruction {
            selection: SelectionExpr::Group(GroupRefExpr::RangeById { start: 13, end: 14 }).into(),
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values: HashMap::from([(
                    Attribute::Red,
                    ValueSource::Inline(ParameterValue::Absolute { value: 255.0 }),
                )]),
                transitions: Default::default(),
                transitions_by_attribute: Default::default(),
                transitions_by_fixture_attribute: Default::default(),
                color_path_id: None,
            },
        });
    }

    emit_release_action(
        &mut app,
        Uuid::new_v4(),
        Some(SelectionExpr::Fixture(UnresolvedFixtureRef {
            fixture_id: 501,
            element_index: None,
        })),
        vec![],
    );
    app.update();

    let fixture_501_uid = Uuid::from_u128(501);
    let programmer = app.world().resource::<Programmer>();
    let rows = fixture_attribute_map(&programmer);
    assert!(
        !rows
            .keys()
            .any(|fixture| fixture.fixture_uid == fixture_501_uid),
        "fixture 501 should no longer exist in programmer instructions",
    );
}

/// Verifies an explicitly approved action bypasses prompt policy and applies immediately.
#[test]
fn test_explicitly_approved_desk_release_removes_fixture_from_group_range_instruction() {
    let mut app = setup_app();
    app.world_mut()
        .resource_mut::<DeskSettings>()
        .selection_flatten_policy = SelectionFlattenPolicy::Prompt;

    let mut group_13_fixtures = Vec::new();
    let mut group_14_fixtures = Vec::new();

    {
        let mut fixtures = app.world_mut().resource_mut::<FixtureDataProviderExt>();
        for fixture_id in 501..=524 {
            let fixture = test_fixture(fixture_id);
            fixtures
                .inner
                .add(fixture.clone())
                .expect("fixture should be added");
            let fixture_ref = FixtureRef {
                fixture_uid: fixture.identifiers.uid,
                index: None,
            };
            if fixture_id <= 512 {
                group_13_fixtures.push(fixture_ref);
            } else {
                group_14_fixtures.push(fixture_ref);
            }
        }
    }

    {
        let mut groups = app.world_mut().resource_mut::<DataProvider<Group>>();
        groups
            .add(Group {
                identifiers: Identifiers {
                    id: 13,
                    uid: Uuid::from_u128(13),
                    label: "Group 13".to_string(),
                },
                selection: SelectionExpr::Resolved(group_13_fixtures).into(),
                ..Default::default()
            })
            .expect("group 13 should be added");
        groups
            .add(Group {
                identifiers: Identifiers {
                    id: 14,
                    uid: Uuid::from_u128(14),
                    label: "Group 14".to_string(),
                },
                selection: SelectionExpr::Resolved(group_14_fixtures).into(),
                ..Default::default()
            })
            .expect("group 14 should be added");
    }

    {
        let mut programmer = app.world_mut().resource_mut::<Programmer>();
        programmer.add_instruction(BoundCueInstruction {
            selection: SelectionExpr::Group(GroupRefExpr::RangeById { start: 13, end: 14 }).into(),
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values: HashMap::from([(
                    Attribute::Red,
                    ValueSource::Inline(ParameterValue::Absolute { value: 255.0 }),
                )]),
                transitions: Default::default(),
                transitions_by_attribute: Default::default(),
                transitions_by_fixture_attribute: Default::default(),
                color_path_id: None,
            },
        });
    }

    let correlation_id = Uuid::new_v4();
    app.world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<ProgrammerAction>>>()
        .write(EngineActionEnvelope::for_command_context(
            correlation_id.into(),
            correlation_id.into(),
            ProgrammerAction::ReleaseValues {
                scope: Scope::Selection(SelectionExpr::Fixture(UnresolvedFixtureRef {
                    fixture_id: 501,
                    element_index: None,
                })),
                attributes: AttributeFilter::All,
                allow_selection_flatten: true,
            },
        ));
    app.update();

    let fixture_501_uid = Uuid::from_u128(501);
    let programmer = app.world().resource::<Programmer>();
    let rows = fixture_attribute_map(&programmer);
    assert!(
        !rows
            .keys()
            .any(|fixture| fixture.fixture_uid == fixture_501_uid),
        "fixture 501 should be removed after confirmed desk release",
    );
}

#[test]
fn test_prompt_policy_does_not_prompt_for_attr_only_release() {
    let mut app = setup_app();
    app.world_mut()
        .resource_mut::<DeskSettings>()
        .selection_flatten_policy = SelectionFlattenPolicy::Prompt;

    let fixture = test_fixture(601);
    let fixture_ref_none = FixtureRef {
        fixture_uid: fixture.identifiers.uid,
        index: None,
    };

    {
        let mut fixtures = app.world_mut().resource_mut::<FixtureDataProviderExt>();
        fixtures
            .inner
            .add(fixture.clone())
            .expect("fixture should be added");
    }

    {
        let mut groups = app.world_mut().resource_mut::<DataProvider<Group>>();
        groups
            .add(Group {
                identifiers: Identifiers {
                    id: 21,
                    uid: Uuid::from_u128(21),
                    label: "Group 21".to_string(),
                },
                selection: SelectionExpr::Resolved(vec![fixture_ref_none]).into(),
                ..Default::default()
            })
            .expect("group should be added");
    }

    {
        let mut programmer = app.world_mut().resource_mut::<Programmer>();
        programmer.add_instruction(BoundCueInstruction {
            selection: SelectionExpr::Group(GroupRefExpr::ById(21)).into(),
            cue_instruction: instruction_with_red_blue(),
        });
    }

    emit_release_action(&mut app, Uuid::new_v4(), None, vec![Attribute::Red]);
    app.update();

    let programmer = app.world().resource::<Programmer>();
    let instructions: Vec<_> = programmer
        .active_instructions()
        .iter()
        .map(|(_, instruction)| instruction.clone())
        .collect();
    assert_eq!(instructions.len(), 1, "expected one instruction to remain");
    assert!(
        matches!(
            instructions[0].selection.source,
            SelectionExpr::Group(GroupRefExpr::ById(21))
        ),
        "selection expression should remain non-resolved when not flattening",
    );
    assert!(
        instructions[0]
            .cue_instruction
            .values
            .contains_key(&Attribute::Blue),
        "blue should remain after red release",
    );
    assert!(
        !instructions[0]
            .cue_instruction
            .values
            .contains_key(&Attribute::Red),
        "red should be removed",
    );
}

/// Verifies prompt policy rejects without mutation and a fresh approved command succeeds.
#[test]
fn test_prompt_policy_rejects_flattening_release_and_accepts_explicit_retry() {
    let mut app = setup_app();
    app.world_mut()
        .resource_mut::<DeskSettings>()
        .selection_flatten_policy = SelectionFlattenPolicy::Prompt;

    let fixture_a = test_fixture(701);
    let fixture_b = test_fixture(702);
    let fixture_a_ref_none = FixtureRef {
        fixture_uid: fixture_a.identifiers.uid,
        index: None,
    };

    {
        let mut fixtures = app.world_mut().resource_mut::<FixtureDataProviderExt>();
        fixtures
            .inner
            .add(fixture_a.clone())
            .expect("fixture A should be added");
        fixtures
            .inner
            .add(fixture_b.clone())
            .expect("fixture B should be added");
    }

    {
        let mut groups = app.world_mut().resource_mut::<DataProvider<Group>>();
        groups
            .add(Group {
                identifiers: Identifiers {
                    id: 31,
                    uid: Uuid::from_u128(31),
                    label: "Group 31".to_string(),
                },
                selection: SelectionExpr::Resolved(vec![fixture_a_ref_none]).into(),
                ..Default::default()
            })
            .expect("group should be added");
    }

    {
        let mut programmer = app.world_mut().resource_mut::<Programmer>();
        programmer.add_instruction(BoundCueInstruction {
            selection: SelectionExpr::Add {
                lhs: Box::new(SelectionExpr::Group(GroupRefExpr::ById(31))),
                rhs: Box::new(SelectionExpr::Fixture(UnresolvedFixtureRef {
                    fixture_id: 702,
                    element_index: None,
                })),
            }
            .into(),
            cue_instruction: instruction_with_red_blue(),
        });
    }

    let correlation_id = Uuid::new_v4();
    app.world_mut()
        .resource_mut::<CommandTracker>()
        .register_context(
            correlation_id.into(),
            correlation_id.into(),
            CommandOrigin::WebUi,
            ReplyTarget::Detached,
        )
        .expect("release command should register");
    emit_release_action(
        &mut app,
        correlation_id,
        Some(SelectionExpr::Fixture(UnresolvedFixtureRef {
            fixture_id: 701,
            element_index: None,
        })),
        vec![],
    );
    app.update();

    let original_results: Vec<_> = app
        .world_mut()
        .resource_mut::<Messages<CommandResult>>()
        .drain()
        .collect();
    let [
        CommandResult {
            command_id,
            outcome: CommandOutcome::Failed(error),
        },
    ] = original_results.as_slice()
    else {
        panic!("flattening release should fail with one terminal result");
    };
    assert_eq!(Uuid::from(*command_id), correlation_id);
    assert_eq!(
        error.code,
        "programmer.selection_flatten_confirmation_required"
    );
    let details = error
        .details
        .as_ref()
        .expect("confirmation failure should contain a retry command");
    assert_eq!(details["module"], "ProgrammerCommand");
    let retry_command: ProgrammerCommand = serde_json::from_value(details["command"].clone())
        .expect("retry details should contain a valid programmer command");
    assert!(matches!(
        &retry_command,
        ProgrammerCommand::ReleaseProgrammerValues {
            allow_selection_flatten: true,
            ..
        }
    ));

    {
        let programmer = app.world().resource::<Programmer>();
        assert_eq!(
            programmer.active_instructions().len(),
            1,
            "rejected command must not mutate the programmer",
        );
    }

    let detached_action = EngineActionEnvelope::detached(ProgrammerAction::ReleaseValues {
        scope: Scope::Selection(SelectionExpr::Fixture(UnresolvedFixtureRef {
            fixture_id: fixture_a.identifiers.id,
            element_index: None,
        })),
        attributes: AttributeFilter::All,
        allow_selection_flatten: false,
    });
    let detached_operation_id = detached_action.operation_id;
    app.world_mut().write_message(detached_action);
    app.update();

    let detached_results = app
        .world_mut()
        .resource_mut::<Messages<CommandResult>>()
        .drain()
        .collect::<Vec<_>>();
    assert!(matches!(
        detached_results.as_slice(),
        [CommandResult {
            command_id,
            outcome: CommandOutcome::Failed(error),
        }] if Uuid::from(*command_id) == Uuid::from(detached_operation_id)
            && error.code == "programmer.selection_flatten_confirmation_required"
    ));

    let retry_id = Uuid::new_v4();
    app.world_mut()
        .resource_mut::<CommandTracker>()
        .register_context(
            retry_id.into(),
            retry_id.into(),
            CommandOrigin::WebUi,
            ReplyTarget::Detached,
        )
        .expect("approved retry should register as a fresh command");
    emit_programmer_command(&mut app, retry_id, retry_command);
    app.update();
    app.update();

    let action_events: Vec<_> = app
        .world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<PlaybackAction>>>()
        .drain()
        .collect();
    assert!(
        action_events.iter().any(|event| {
            matches!(
                &event.action,
                PlaybackAction::ReleaseParameters {
                    scope: PlaybackScope::Selection(SelectionExpr::Fixture(UnresolvedFixtureRef {
                        fixture_id,
                        element_index: None,
                    }))
                } if *fixture_id == fixture_a.identifiers.id
            )
        }),
        "approved retry should emit PlaybackAction::ReleaseParameters",
    );

    let release_operation_id = action_events
        .iter()
        .find_map(|event| {
            matches!(
                &event.action,
                PlaybackAction::ReleaseParameters {
                    scope: PlaybackScope::Selection(_)
                }
            )
            .then_some(event.operation_id)
        })
        .expect("confirmed release should have one operation identity");
    app.world_mut()
        .write_message(OperationResult::<(), CommandError>::succeeded(
            release_operation_id,
            (),
        ));
    app.update();
    let retry_results: Vec<_> = app
        .world_mut()
        .resource_mut::<Messages<CommandResult>>()
        .drain()
        .collect();
    assert!(matches!(
        retry_results.as_slice(),
        [CommandResult {
            command_id,
            outcome: CommandOutcome::Succeeded { output: None },
        }] if Uuid::from(*command_id) == retry_id
    ));

    let programmer = app.world().resource::<Programmer>();
    assert_eq!(
        programmer.active_instructions().len(),
        1,
        "confirmed flatten release should preserve unmatched fixtures",
    );
    let remaining_instruction = programmer
        .active_instructions()
        .iter()
        .next()
        .map(|(_, instruction)| instruction)
        .expect("expected a remaining instruction");
    assert!(
        matches!(
            &remaining_instruction.selection.source,
            SelectionExpr::Resolved(fixtures)
                if fixtures.len() == 1
                    && fixtures[0].fixture_uid == fixture_b.identifiers.uid
        ),
        "remaining instruction should be flattened to fixture 702",
    );
}

/// Verifies dispatch-time revalidation rejects every sibling when programmer state changed.
#[test]
fn stale_multi_action_plan_is_rejected_before_any_sibling_mutates() {
    let mut app = setup_app();
    app.world_mut()
        .resource_mut::<DeskSettings>()
        .selection_flatten_policy = SelectionFlattenPolicy::Prompt;

    let fixture_a = test_fixture(811);
    let fixture_b = test_fixture(812);
    let fixture_a_ref = FixtureRef {
        fixture_uid: fixture_a.identifiers.uid,
        index: None,
    };
    let fixture_b_ref = FixtureRef {
        fixture_uid: fixture_b.identifiers.uid,
        index: None,
    };
    {
        let mut fixtures = app.world_mut().resource_mut::<FixtureDataProviderExt>();
        fixtures.inner.add(fixture_a.clone()).unwrap();
        fixtures.inner.add(fixture_b).unwrap();
    }
    app.world_mut()
        .resource_mut::<DataProvider<Group>>()
        .add(Group {
            identifiers: Identifiers {
                id: 51,
                uid: Uuid::from_u128(51),
                label: "Group 51".to_string(),
            },
            selection: SelectionExpr::Resolved(vec![fixture_a_ref, fixture_b_ref]).into(),
            ..Default::default()
        })
        .unwrap();
    app.world_mut()
        .resource_mut::<Programmer>()
        .set_active_selection(SelectionExpr::Group(GroupRefExpr::ById(51)));

    let command_id = CommandId::new();
    app.world_mut()
        .resource_mut::<CommandTracker>()
        .register_context(
            command_id,
            command_id.into(),
            CommandOrigin::WebUi,
            ReplyTarget::Detached,
        )
        .unwrap();
    app.world_mut()
        .resource_mut::<PendingCommandBuffer>()
        .push(PayloadEnvelope::with_context(
            command_id,
            command_id,
            Box::new(UserCommand::Clear(ClearCommand {
                targets: vec![
                    ClearTarget::Selection,
                    ClearTarget::Fixture {
                        selection: SelectionExpr::Fixture(UnresolvedFixtureRef {
                            fixture_id: fixture_a.identifiers.id,
                            element_index: None,
                        }),
                        attributes: vec![],
                    },
                ],
                allow_selection_flatten: false,
                selection_flatten_approval: None,
            })),
        ));
    app.update();

    app.world_mut()
        .resource_mut::<Programmer>()
        .add_instruction(BoundCueInstruction {
            selection: SelectionExpr::Group(GroupRefExpr::ById(51)).into(),
            cue_instruction: instruction_with_red_blue(),
        });
    let planned = app
        .world_mut()
        .resource_mut::<PendingEngineActionBuffer>()
        .drain();
    for envelope in planned {
        let action = *envelope
            .action
            .into_any()
            .downcast::<ProgrammerAction>()
            .expect("planner should emit programmer actions");
        app.world_mut()
            .write_message(EngineActionEnvelope::with_context(
                envelope.operation_id,
                envelope.command_id,
                envelope.undo_id,
                action,
            ));
    }
    app.update();

    assert!(matches!(
        app.world().resource::<Programmer>().active_selection(),
        SelectionExpr::Group(GroupRefExpr::ById(51))
    ));
    let results = app
        .world_mut()
        .resource_mut::<Messages<CommandResult>>()
        .drain()
        .collect::<Vec<_>>();
    assert!(matches!(
        results.as_slice(),
        [CommandResult {
            command_id: result_command_id,
            outcome: CommandOutcome::Failed(error),
        }] if *result_command_id == command_id
            && error.code == "programmer.selection_flatten_confirmation_required"
            && error.details.as_ref().is_some_and(|details| details["module"] == "UserCommand")
    ));
}

/// Verifies each action in a combined clear reports one planned completion.
#[test]
fn combined_clear_selection_and_values_finishes_both_action_slots() {
    let mut app = setup_app();
    let command_id = CommandId::new();
    app.world_mut()
        .resource_mut::<CommandTracker>()
        .register_context(
            command_id,
            command_id.into(),
            CommandOrigin::WebUi,
            ReplyTarget::Detached,
        )
        .expect("combined clear command should register");
    app.world_mut()
        .resource_mut::<CommandTracker>()
        .expect_completions(command_id, 2)
        .expect("combined clear should expect both planned actions");
    app.world_mut()
        .write_message(EngineActionEnvelope::for_command_context(
            command_id,
            command_id.into(),
            ProgrammerAction::ClearSelection,
        ));
    app.world_mut()
        .write_message(EngineActionEnvelope::for_command_context(
            command_id,
            command_id.into(),
            ProgrammerAction::ClearValues {
                scope: Scope::All,
                attributes: AttributeFilter::All,
                allow_selection_flatten: false,
            },
        ));

    app.update();

    let results = app
        .world_mut()
        .resource_mut::<Messages<CommandResult>>()
        .drain()
        .collect::<Vec<_>>();
    assert!(matches!(
        results.as_slice(),
        [CommandResult {
            command_id: result_command_id,
            outcome: CommandOutcome::Succeeded { output: None },
        }] if *result_command_id == command_id
    ));
}

/// Verifies cue cleanup and playback release jointly own one programmer action completion.
#[test]
fn full_release_waits_for_all_delegated_operations_before_succeeding() {
    let mut app = setup_app();
    let fixture = test_fixture_ref(9001);
    app.world_mut()
        .resource_mut::<Programmer>()
        .add_instruction(BoundCueInstruction {
            selection: SelectionExpr::Resolved(vec![fixture]).into(),
            cue_instruction: instruction_with_red_blue(),
        });
    let command_id = CommandId::new();
    app.world_mut()
        .resource_mut::<CommandTracker>()
        .register_context(
            command_id,
            command_id.into(),
            CommandOrigin::WebUi,
            ReplyTarget::Detached,
        )
        .expect("release command should register");
    app.world_mut()
        .write_message(EngineActionEnvelope::for_command_context(
            command_id,
            command_id.into(),
            ProgrammerAction::ReleaseValues {
                scope: Scope::All,
                attributes: AttributeFilter::All,
                allow_selection_flatten: false,
            },
        ));

    app.update();

    let cue_operation_id = app
        .world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<CueLifecycleAction>>>()
        .drain()
        .next()
        .expect("full release should delegate cue cleanup")
        .operation_id;
    let playback_operation_id = app
        .world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<PlaybackAction>>>()
        .drain()
        .next()
        .expect("full release should delegate playback release")
        .operation_id;
    assert!(
        app.world_mut()
            .resource_mut::<Messages<CommandResult>>()
            .drain()
            .next()
            .is_none(),
        "parent action must remain active while both operations are pending",
    );

    app.world_mut()
        .write_message(OperationResult::<(), CommandError>::succeeded(
            cue_operation_id,
            (),
        ));
    app.update();
    assert!(
        app.world_mut()
            .resource_mut::<Messages<CommandResult>>()
            .drain()
            .next()
            .is_none(),
        "one child result must not finish a two-operation action",
    );

    app.world_mut()
        .write_message(OperationResult::<(), CommandError>::succeeded(
            playback_operation_id,
            (),
        ));
    app.update();
    let results = app
        .world_mut()
        .resource_mut::<Messages<CommandResult>>()
        .drain()
        .collect::<Vec<_>>();
    assert!(matches!(
        results.as_slice(),
        [CommandResult {
            command_id: result_command_id,
            outcome: CommandOutcome::Succeeded { output: None },
        }] if *result_command_id == command_id
    ));
}
