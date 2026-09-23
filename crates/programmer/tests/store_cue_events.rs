// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::collections::HashMap;
use std::time::Duration;

use bevy_app::prelude::*;
use bevy_ecs::prelude::Messages;
use nightfall::prelude::*;
use nightfall_cues::cue::FixtureAttributeTransition;
use nightfall_cues::data_provider_ext::CueDataProviderExt;
use nightfall_cues::prelude::{
    BoundCueInstruction, Cue, CueAction, CueInstruction, CuePart, CuePartStoreTarget,
    CueStoreError, CueStoreOperation, CueStoreSuccess, CueStoreTarget, Sequence,
};
use nightfall_dmx::prelude::{Attribute, ParameterValue};
use nightfall_engine::prelude::{
    CommandEnvelope, CommandId, CommandNotice, CommandOrigin, CommandOutcome, CommandReply,
    CommandResult, CommandTracker, DataProvider, EngineActionEnvelope, FinishedCommand,
    OperationResult, PendingEngineActionBuffer, ReplyTarget,
};
use nightfall_fixtures::prelude::{Fixture, FixtureDataProviderExt, FixtureElement};
use nightfall_programmer::events::{
    ProgrammerCommand, StoreCueId, StoreCuePartId, StoreCueWorkflows, StoreMode, handle_cue_events,
    resume_store_cue_workflows,
};
use nightfall_programmer::prelude::Programmer;
use uuid::Uuid;

/// Builds a resolved fixture reference for cue-store tests.
fn fixture_ref(seed: u128) -> FixtureRef {
    element_fixture_ref(seed, 1)
}

/// Builds a resolved fixture element reference for cue-store tests.
fn element_fixture_ref(seed: u128, index: u32) -> FixtureRef {
    FixtureRef {
        fixture_uid: Uuid::from_u128(seed),
        index: Some(index),
    }
}

/// Builds a resolved whole-fixture reference for cue-store tests.
fn whole_fixture_ref(seed: u128) -> FixtureRef {
    FixtureRef {
        fixture_uid: Uuid::from_u128(seed),
        index: None,
    }
}

/// Builds an unresolved whole-fixture reference for selection commands.
fn unresolved_fixture_ref(fixture_id: u32) -> UnresolvedFixtureRef {
    UnresolvedFixtureRef {
        fixture_id,
        element_index: None,
    }
}

/// Builds a fixture with multiple elements so store tests can catch accidental element expansion.
fn fixture_with_elements(fixture_id: u32, element_count: usize) -> Fixture {
    Fixture {
        identifiers: Identifiers {
            id: fixture_id,
            uid: Uuid::from_u128(fixture_id as u128),
            label: format!("Fixture {fixture_id}"),
        },
        make: "Test".to_string(),
        model: "Multi Element".to_string(),
        mode: "Mode".to_string(),
        elements: (0..element_count)
            .map(|_| FixtureElement::default())
            .collect(),
        ..Default::default()
    }
}

/// Builds a single-attribute cue instruction for test payloads.
fn cue_instruction(attribute: Attribute, value: f64) -> CueInstruction {
    CueInstruction {
        blueprint_application: None,
        values: HashMap::from([(
            attribute,
            ValueSource::Inline(ParameterValue::Absolute { value }),
        )]),
        transitions: Default::default(),
        transitions_by_attribute: Default::default(),
        transitions_by_fixture_attribute: Default::default(),
        color_path_id: None,
    }
}

/// Builds a bound instruction for one resolved fixture.
fn bound_instruction(fixture: FixtureRef, attribute: Attribute, value: f64) -> BoundCueInstruction {
    BoundCueInstruction {
        selection: SelectionExpr::Resolved(vec![fixture]).into(),
        cue_instruction: cue_instruction(attribute, value),
    }
}

/// Adds a programmer instruction for a selection with absolute attribute values.
fn add_programmer_values(app: &mut App, selection: SelectionExpr, values: &[(Attribute, f64)]) {
    app.world_mut()
        .resource_mut::<Programmer>()
        .add_instruction(BoundCueInstruction {
            selection: selection.into(),
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values: values
                    .iter()
                    .map(|(attribute, value)| {
                        (
                            attribute.clone(),
                            ValueSource::Inline(ParameterValue::Absolute { value: *value }),
                        )
                    })
                    .collect(),
                transitions: Default::default(),
                transitions_by_attribute: Default::default(),
                transitions_by_fixture_attribute: Default::default(),
                color_path_id: None,
            },
        });
}

/// Inserts a group selection for store-mode normalization tests.
fn insert_group(app: &mut App, group_id: u32, selection: Vec<FixtureRef>) {
    app.world_mut()
        .resource_mut::<DataProvider<Group>>()
        .add(Group {
            identifiers: Identifiers {
                id: group_id,
                uid: Uuid::from_u128(group_id.into()),
                label: format!("Group {group_id}"),
            },
            selection: SelectionExpr::Resolved(selection).into(),
            description: String::new(),
        })
        .expect("group should insert");
}

/// Inserts multi-element fixtures with stable IDs and UIDs.
fn insert_multi_element_fixtures(
    app: &mut App,
    fixture_ids: impl IntoIterator<Item = u32>,
    element_count: usize,
) {
    let mut fixtures = app.world_mut().resource_mut::<FixtureDataProviderExt>();
    for fixture_id in fixture_ids {
        fixtures
            .inner
            .add(fixture_with_elements(fixture_id, element_count))
            .expect("fixture should insert");
    }
}

/// Finds the stored instruction for one resolved fixture.
fn instruction_for_fixture<'a>(
    instructions: &'a [BoundCueInstruction],
    fixture: &FixtureRef,
) -> &'a BoundCueInstruction {
    instructions
        .iter()
        .find(|instruction| {
            matches!(
                &instruction.selection.source,
                SelectionExpr::Resolved(fixtures) if fixtures.as_slice() == std::slice::from_ref(fixture)
            ) && instruction.selection.clauses.is_empty()
        })
        .expect("fixture instruction should exist")
}

/// Returns the single fixture ref from a flattened store-cue instruction.
fn store_cue_instruction_fixture(instruction: &BoundCueInstruction) -> Option<&FixtureRef> {
    let SelectionExpr::Resolved(fixtures) = &instruction.selection.source else {
        return None;
    };
    if !instruction.selection.clauses.is_empty() || fixtures.len() != 1 {
        return None;
    }
    fixtures.first()
}

/// Asserts that an instruction stores the expected absolute value for an attribute.
fn assert_absolute_value(
    instruction: &BoundCueInstruction,
    attribute: Attribute,
    expected_value: f64,
) {
    let value = instruction
        .cue_instruction
        .values
        .get(&attribute)
        .expect("attribute should exist");
    assert!(matches!(
        value,
        ValueSource::Inline(ParameterValue::Absolute { value }) if *value == expected_value
    ));
}

/// Asserts that one attribute stores the expected fixed fade-in duration.
fn assert_attribute_fixed_fade_in(
    instruction: &BoundCueInstruction,
    attribute: Attribute,
    expected: Duration,
) {
    let fade_in = instruction
        .cue_instruction
        .transitions_by_attribute
        .get(&attribute)
        .and_then(|transition| transition.fade_in.as_ref())
        .expect("attribute fade_in should exist");
    assert_eq!(fade_in, &TransitionMode::Fixed(expected));
}

/// Returns a stable serialized representation of attribute transition maps.
fn attribute_transition_snapshot(
    transitions: &AttributeTransitions,
) -> Vec<(String, serde_json::Value)> {
    let mut snapshot = transitions
        .iter()
        .map(|(attribute, transition)| {
            (
                attribute.to_string(),
                serde_json::to_value(transition).expect("attribute transition serializes"),
            )
        })
        .collect::<Vec<_>>();
    snapshot.sort_by(|(left, _), (right, _)| left.cmp(right));
    snapshot
}

/// Asserts that recalled/stored cue content matches aside from cue identity.
fn assert_equivalent_recalled_cue_payload(expected: &Cue, actual: &Cue) {
    assert_eq!(
        serde_json::to_value(&actual.transitions).expect("actual cue transitions serialize"),
        serde_json::to_value(&expected.transitions).expect("expected cue transitions serialize"),
    );
    assert_eq!(
        attribute_transition_snapshot(&actual.transitions_by_attribute),
        attribute_transition_snapshot(&expected.transitions_by_attribute),
    );
    assert_eq!(
        serde_json::to_value(&actual.instructions).expect("actual instructions serialize"),
        serde_json::to_value(&expected.instructions).expect("expected instructions serialize"),
    );
}

/// Builds a cue with stable identifiers and instructions.
fn cue_with_instructions(
    cue_id: u32,
    instructions: Vec<BoundCueInstruction>,
    parts: Vec<CuePart>,
) -> Cue {
    Cue {
        identifiers: Identifiers {
            id: cue_id,
            uid: Uuid::new_v4(),
            label: format!("Cue {cue_id}"),
        },
        instructions,
        parts,
        ..Default::default()
    }
}

/// Builds a cue part with stable identifiers and instructions.
fn part_with_instructions(part_id: u32, instructions: Vec<BoundCueInstruction>) -> CuePart {
    CuePart {
        identifiers: Identifiers {
            id: part_id,
            uid: Uuid::new_v4(),
            label: format!("Part {part_id}"),
        },
        instructions,
        ..Default::default()
    }
}

/// Builds a sequence referencing the provided cue definitions.
fn sequence_with_cues(sequence_id: u32, cues: &[Cue]) -> Sequence {
    Sequence {
        identifiers: Identifiers {
            id: sequence_id,
            uid: Uuid::new_v4(),
            label: format!("Sequence {sequence_id}"),
        },
        steps: cues
            .iter()
            .map(|cue| cue.identifiers.uid.into())
            .collect::<Vec<_>>(),
        ..Default::default()
    }
}

/// Creates an app with resources needed by cue store handling.
fn setup_app() -> App {
    let mut app = App::new();
    app.add_message::<CommandEnvelope<ProgrammerCommand>>();
    app.add_message::<CommandResult>();
    app.add_message::<CommandReply>();
    app.add_message::<FinishedCommand>();
    app.add_message::<CommandNotice>();
    app.add_message::<EngineActionEnvelope<CueStoreOperation>>();
    app.add_message::<OperationResult<CueStoreSuccess, CueStoreError>>();
    app.init_resource::<CommandTracker>();
    app.init_resource::<StoreCueWorkflows>();
    app.insert_resource(Programmer::default());
    app.insert_resource(PendingEngineActionBuffer::default());
    app.insert_resource(DataProvider::<Cue>::default());
    app.insert_resource(DataProvider::<Sequence>::default());
    app.insert_resource(FixtureDataProviderExt::default());
    app.insert_resource(DataProvider::<Group>::default());
    app.add_systems(Update, (handle_cue_events, resume_store_cue_workflows));
    app
}

/// Inserts cues and a sequence into app data providers.
fn insert_sequence(app: &mut App, sequence_id: u32, cues: &[Cue]) {
    {
        let mut cue_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        for cue in cues {
            cue_provider.add(cue.clone()).expect("cue should insert");
        }
    }
    app.world_mut()
        .resource_mut::<DataProvider<Sequence>>()
        .add(sequence_with_cues(sequence_id, cues))
        .expect("sequence should insert");
}

/// Emits a programmer command and returns queued cue actions.
fn run_store_command(app: &mut App, command: ProgrammerCommand) -> Vec<CueAction> {
    app.world_mut().write_message(CommandEnvelope::new(
        command,
        CommandOrigin::Cli,
        ReplyTarget::Detached,
    ));
    app.update();
    app.world_mut()
        .resource_mut::<PendingEngineActionBuffer>()
        .drain()
        .into_iter()
        .filter_map(|envelope| {
            envelope
                .action
                .as_any()
                .downcast_ref::<CueAction>()
                .cloned()
        })
        .collect::<Vec<_>>()
}

/// Emits a tracked programmer command and returns its queued cues-domain operations.
fn run_tracked_store_command(app: &mut App, command: ProgrammerCommand) -> Vec<CueStoreOperation> {
    let envelope = CommandEnvelope::new(command, CommandOrigin::Cli, ReplyTarget::Detached);
    app.world_mut()
        .resource_mut::<CommandTracker>()
        .register(&envelope)
        .expect("programmer command should register");
    app.world_mut().write_message(envelope);
    app.update();
    app.world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<CueStoreOperation>>>()
        .drain()
        .map(|envelope| envelope.action)
        .collect()
}

/// Applies queued cue actions to in-memory providers so later commands can observe them.
fn apply_cue_actions(app: &mut App, actions: &[CueAction]) {
    for action in actions {
        match action {
            CueAction::StoreCue(cue) => {
                let mut provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
                let _ = provider.remove(&cue.identifiers.uid);
                provider
                    .add(cue.as_ref().clone())
                    .expect("cue should store");
            }
            CueAction::StoreSequence(sequence) => {
                let mut provider = app.world_mut().resource_mut::<DataProvider<Sequence>>();
                let _ = provider.remove(&sequence.identifiers.uid);
                provider
                    .add(sequence.as_ref().clone())
                    .expect("sequence should store");
            }
            CueAction::StoreCueInSequence {
                sequence_id,
                cue_id,
                part_id,
                part,
                ..
            } => {
                let mut cue = app
                    .world()
                    .resource::<DataProvider<Cue>>()
                    .cue_by_sequence_id(
                        app.world().resource::<DataProvider<Sequence>>(),
                        *sequence_id,
                        match cue_id {
                            CueStoreTarget::Exact(cue_id) => *cue_id,
                            CueStoreTarget::Next => {
                                let cue_provider = app.world().resource::<DataProvider<Cue>>();
                                let sequence_provider =
                                    app.world().resource::<DataProvider<Sequence>>();
                                let used_ids = sequence_provider
                                    .from_id(*sequence_id)
                                    .ok()
                                    .map(|sequence| {
                                        sequence
                                            .steps
                                            .iter()
                                            .filter_map(|step| {
                                                cue_provider.get((*step).into()).ok()
                                            })
                                            .map(|cue| cue.identifiers.id)
                                            .collect::<Vec<_>>()
                                    })
                                    .unwrap_or_default();
                                next_available_test_id(used_ids)
                            }
                        },
                    )
                    .ok()
                    .map(|cue| (*cue).clone())
                    .unwrap_or_else(|| {
                        let resolved_cue_id = match cue_id {
                            CueStoreTarget::Exact(cue_id) => *cue_id,
                            CueStoreTarget::Next => {
                                let cue_provider = app.world().resource::<DataProvider<Cue>>();
                                let sequence_provider =
                                    app.world().resource::<DataProvider<Sequence>>();
                                let used_ids = sequence_provider
                                    .from_id(*sequence_id)
                                    .ok()
                                    .map(|sequence| {
                                        sequence
                                            .steps
                                            .iter()
                                            .filter_map(|step| {
                                                cue_provider.get((*step).into()).ok()
                                            })
                                            .map(|cue| cue.identifiers.id)
                                            .collect::<Vec<_>>()
                                    })
                                    .unwrap_or_default();
                                next_available_test_id(used_ids)
                            }
                        };
                        cue_with_instructions(resolved_cue_id, Vec::new(), Vec::new())
                    });
                let resolved_part_id = match part_id {
                    CuePartStoreTarget::Exact(part_id) => *part_id,
                    CuePartStoreTarget::Next => {
                        next_available_test_id(cue.parts.iter().map(|part| part.identifiers.id))
                    }
                };
                let mut part = part.clone();
                part.identifiers.id = resolved_part_id;
                if resolved_part_id == 0 {
                    if !part.identifiers.label.trim().is_empty() {
                        cue.identifiers.label = part.identifiers.label;
                    } else if cue.identifiers.label.trim().is_empty() {
                        cue.identifiers.label = format!("Cue {}", cue.identifiers.id);
                    }
                    cue.transitions = part.transitions;
                    cue.transitions_by_attribute = part.transitions_by_attribute;
                    cue.instructions = part.instructions;
                    cue.tracking_flags = part.tracking_flags;
                } else {
                    if part.identifiers.label.trim().is_empty() {
                        part.identifiers.label = format!("Part {}", resolved_part_id);
                    }
                    cue.upsert_part(*part);
                }
                {
                    let mut provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
                    let _ = provider.remove(&cue.identifiers.uid);
                    provider.add(cue.clone()).expect("cue should store");
                }
                let mut sequence = app
                    .world()
                    .resource::<DataProvider<Sequence>>()
                    .from_id(*sequence_id)
                    .ok()
                    .map(|sequence| (*sequence).clone())
                    .unwrap_or_else(|| sequence_with_cues(*sequence_id, &[]));
                if !sequence.steps.contains(&cue.identifiers.uid.into()) {
                    sequence.steps.push(cue.identifiers.uid.into());
                }
                let mut provider = app.world_mut().resource_mut::<DataProvider<Sequence>>();
                let _ = provider.remove(&sequence.identifiers.uid);
                provider.add(sequence).expect("sequence should store");
            }
            CueAction::RestoreCueStoreState {
                sequence_id,
                cue_uid,
                previous_cue,
                previous_sequence,
                ..
            } => {
                {
                    let mut provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
                    if let Some(cue) = previous_cue {
                        let _ = provider.remove(&cue.identifiers.uid);
                        provider
                            .add(cue.as_ref().clone())
                            .expect("cue should restore");
                    } else {
                        let _ = provider.remove(cue_uid);
                    }
                }
                let mut provider = app.world_mut().resource_mut::<DataProvider<Sequence>>();
                if let Some(sequence) = previous_sequence {
                    let _ = provider.remove(&sequence.identifiers.uid);
                    provider
                        .add(sequence.as_ref().clone())
                        .expect("sequence should restore");
                } else {
                    let sequence_uid = provider
                        .from_id(*sequence_id)
                        .ok()
                        .map(|sequence_ref| sequence_ref.identifiers.uid);
                    if let Some(sequence_uid) = sequence_uid {
                        let _ = provider.remove(&sequence_uid);
                    }
                }
            }
        }
    }
}

/// Finds the lowest positive integer that is absent from the supplied IDs.
fn next_available_test_id(used_ids: impl IntoIterator<Item = u32>) -> u32 {
    let used = used_ids
        .into_iter()
        .collect::<std::collections::HashSet<_>>();
    let mut candidate = 1;
    while used.contains(&candidate) {
        candidate += 1;
    }
    candidate
}

/// Runs a cue store command and applies the queued store actions to data providers.
fn run_and_apply_store_command(app: &mut App, command: ProgrammerCommand) -> Cue {
    let target = match &command {
        ProgrammerCommand::StoreCue {
            sequence_id,
            cue_id: StoreCueId::Exact(cue_id),
            ..
        } => Some((*sequence_id, *cue_id)),
        _ => None,
    };
    let actions = run_store_command(app, command);
    apply_cue_actions(app, &actions);
    if let Some((sequence_id, cue_id)) = target {
        return app
            .world()
            .resource::<DataProvider<Cue>>()
            .cue_by_sequence_id(
                app.world().resource::<DataProvider<Sequence>>(),
                sequence_id,
                cue_id,
            )
            .expect("cue should be stored after applying actions")
            .clone();
    }

    stored_cue(&actions)
}

/// Extracts the stored cue action from queued cue actions.
fn stored_cue(actions: &[CueAction]) -> Cue {
    *actions
        .iter()
        .find_map(|action| match action {
            CueAction::StoreCue(cue) => Some(cue.clone()),
            CueAction::StoreCueInSequence {
                cue_id,
                part_id,
                part,
                ..
            } => {
                let mut cue = Cue::default();
                if let CueStoreTarget::Exact(cue_id) = cue_id {
                    cue.identifiers.id = *cue_id;
                }
                let resolved_part_id = match part_id {
                    CuePartStoreTarget::Exact(part_id) => *part_id,
                    CuePartStoreTarget::Next => 1,
                };
                let mut part = part.clone();
                part.identifiers.id = resolved_part_id;
                if resolved_part_id == 0 {
                    cue.instructions = part.instructions;
                    cue.transitions = part.transitions;
                    cue.transitions_by_attribute = part.transitions_by_attribute;
                    cue.tracking_flags = part.tracking_flags;
                } else {
                    cue.upsert_part(*part);
                }
                Some(Box::new(cue))
            }
            _ => None,
        })
        .expect("store command should enqueue a cue action")
}

/// Reads terminal errors and non-terminal notices produced by cue store handling.
fn command_feedback_messages(app: &mut App) -> Vec<String> {
    let mut messages = app
        .world_mut()
        .resource_mut::<Messages<CommandResult>>()
        .drain()
        .filter_map(|result| match result.outcome {
            CommandOutcome::Failed(error) => Some(error.message),
            CommandOutcome::Succeeded { .. } => None,
        })
        .collect::<Vec<_>>();
    messages.extend(
        app.world_mut()
            .resource_mut::<Messages<CommandNotice>>()
            .drain()
            .map(|notice| notice.message),
    );
    messages
}

/// Verifies cue append storage defers ID allocation until cue mutation.
#[test]
fn store_cue_next_allocates_lowest_available_cue_id() {
    let mut app = setup_app();
    let cue_one = cue_with_instructions(1, Vec::new(), Vec::new());
    let cue_three = cue_with_instructions(3, Vec::new(), Vec::new());
    insert_sequence(&mut app, 5, &[cue_one, cue_three]);
    app.world_mut()
        .resource_mut::<Programmer>()
        .add_instruction(bound_instruction(fixture_ref(1), Attribute::Red, 10.0));

    let actions = run_store_command(
        &mut app,
        ProgrammerCommand::StoreCue {
            sequence_id: 5,
            cue_id: StoreCueId::Next,
            part_id: StoreCuePartId::Exact(0),
            mode: StoreMode::Replace,
            label: None,
        },
    );

    assert!(
        matches!(
            actions.as_slice(),
            [CueAction::StoreCueInSequence {
                sequence_id: 5,
                cue_id: CueStoreTarget::Next,
                ..
            }]
        ),
        "append cue storage should defer next-id resolution to cue mutation"
    );

    apply_cue_actions(&mut app, &actions);
    let world = app.world();
    let sequence_provider = world.resource::<DataProvider<Sequence>>();
    let stored = world
        .resource::<DataProvider<Cue>>()
        .cue_by_sequence_id(sequence_provider, 5, 2)
        .expect("append cue should fill the first available cue id");
    assert_eq!(stored.identifiers.id, 2);
}

/// Verifies cue id zero stores programmer values into the sequence setup cue.
#[test]
fn store_cue_zero_updates_sequence_setup_cue() {
    let mut app = setup_app();
    let cue_one = cue_with_instructions(1, Vec::new(), Vec::new());
    let cue_one_uid = cue_one.identifiers.uid;
    insert_sequence(&mut app, 5, &[cue_one]);
    app.world_mut()
        .resource_mut::<Programmer>()
        .add_instruction(bound_instruction(fixture_ref(1), Attribute::Red, 10.0));

    let actions = run_store_command(
        &mut app,
        ProgrammerCommand::StoreCue {
            sequence_id: 5,
            cue_id: StoreCueId::Exact(0),
            part_id: StoreCuePartId::Exact(0),
            mode: StoreMode::Replace,
            label: None,
        },
    );

    assert!(
        matches!(actions.as_slice(), [CueAction::StoreSequence(_)]),
        "setup cue storage should only persist the owning sequence"
    );

    apply_cue_actions(&mut app, &actions);
    let world = app.world();
    let sequence = world
        .resource::<DataProvider<Sequence>>()
        .from_id(5)
        .expect("sequence should still exist");
    assert_eq!(sequence.steps, vec![cue_one_uid.into()]);
    assert_eq!(sequence.setup_cue.identifiers.id, 0);
    assert_eq!(sequence.setup_cue.identifiers.label, "Setup");
    assert_eq!(sequence.setup_cue.instructions.len(), 1);
    assert_absolute_value(&sequence.setup_cue.instructions[0], Attribute::Red, 10.0);
    assert!(
        world
            .resource::<DataProvider<Cue>>()
            .cue_by_sequence_id(world.resource::<DataProvider<Sequence>>(), 5, 0)
            .is_err(),
        "setup cue should not be added to normal sequence steps"
    );
}

/// Verifies cue id zero recall reads the sequence setup cue instead of normal steps.
#[test]
fn recall_cue_zero_reads_sequence_setup_cue() {
    let mut app = setup_app();
    let cue_one = cue_with_instructions(1, Vec::new(), Vec::new());
    insert_sequence(&mut app, 5, &[cue_one]);
    app.world_mut()
        .resource_mut::<Programmer>()
        .add_instruction(bound_instruction(fixture_ref(1), Attribute::Red, 10.0));

    let actions = run_store_command(
        &mut app,
        ProgrammerCommand::StoreCue {
            sequence_id: 5,
            cue_id: StoreCueId::Exact(0),
            part_id: StoreCuePartId::Exact(0),
            mode: StoreMode::Replace,
            label: None,
        },
    );
    apply_cue_actions(&mut app, &actions);

    {
        let mut programmer = app.world_mut().resource_mut::<Programmer>();
        programmer.clear();
        programmer.add_instruction(bound_instruction(fixture_ref(1), Attribute::Red, 40.0));
    }

    let actions = run_store_command(
        &mut app,
        ProgrammerCommand::RecallCue {
            sequence_id: 5,
            cue_id: 0,
            part_id: 0,
            select: false,
        },
    );

    assert!(
        actions.is_empty(),
        "recall should not enqueue cue store actions"
    );
    assert!(
        command_feedback_messages(&mut app).is_empty(),
        "setup cue recall should resolve without a not-found error"
    );

    let programmer = app.world().resource::<Programmer>();
    let instructions = programmer
        .active_instructions()
        .iter()
        .map(|(_, instruction)| instruction)
        .collect::<Vec<_>>();
    assert_eq!(instructions.len(), 1);
    assert_absolute_value(instructions[0], Attribute::Red, 10.0);
}

/// Verifies flagged cue recall selects the fixtures and elements loaded into the programmer.
#[test]
fn recall_cue_with_select_sets_active_selection_to_recalled_targets() {
    let mut app = setup_app();
    let fixture_one = fixture_ref(1);
    let fixture_two = element_fixture_ref(2, 2);
    let cue = cue_with_instructions(
        1,
        vec![
            bound_instruction(fixture_one.clone(), Attribute::Red, 10.0),
            bound_instruction(fixture_two.clone(), Attribute::Blue, 20.0),
            bound_instruction(fixture_one.clone(), Attribute::Green, 30.0),
        ],
        Vec::new(),
    );
    insert_sequence(&mut app, 5, &[cue]);
    app.world_mut()
        .resource_mut::<Programmer>()
        .set_active_selection(SelectionExpr::Resolved(vec![fixture_ref(99)]));

    run_store_command(
        &mut app,
        ProgrammerCommand::RecallCue {
            sequence_id: 5,
            cue_id: 1,
            part_id: 0,
            select: true,
        },
    );

    let programmer = app.world().resource::<Programmer>();
    assert_eq!(programmer.active_instructions().len(), 2);
    assert_eq!(
        programmer.active_selection(),
        SelectionExpr::Resolved(vec![fixture_one, fixture_two])
    );
}

/// Verifies recalling a cue then storing it as another cue preserves values and timing metadata.
#[test]
fn recall_cue_then_store_cue_preserves_authored_payload() {
    let mut app = setup_app();
    let fixture = fixture_ref(1);
    let mut instruction = cue_instruction(Attribute::Red, 10.0);
    instruction.transitions_by_attribute.insert(
        Attribute::Red,
        PartialTransition {
            delay_in: Some(TransitionMode::Fixed(Duration::from_secs(2))),
            fade_out: Some(TransitionMode::Fixed(Duration::from_secs(3))),
            ..Default::default()
        },
    );
    let mut source = cue_with_instructions(
        1,
        vec![BoundCueInstruction {
            selection: SelectionExpr::Resolved(vec![fixture]).into(),
            cue_instruction: instruction,
        }],
        Vec::new(),
    );
    source.transitions = PartialTransition {
        delay_in: Some(TransitionMode::Fixed(Duration::from_secs(4))),
        fade_in: Some(TransitionMode::Fixed(Duration::from_secs(5))),
        ..Default::default()
    };
    source.transitions_by_attribute.insert(
        Attribute::Red,
        PartialTransition {
            delay_out: Some(TransitionMode::Fixed(Duration::from_secs(6))),
            fade_out: Some(TransitionMode::Fixed(Duration::from_secs(7))),
            ..Default::default()
        },
    );
    insert_sequence(&mut app, 5, &[source.clone()]);

    run_store_command(
        &mut app,
        ProgrammerCommand::RecallCue {
            sequence_id: 5,
            cue_id: 1,
            part_id: 0,
            select: false,
        },
    );
    let stored = run_and_apply_store_command(
        &mut app,
        ProgrammerCommand::StoreCue {
            sequence_id: 5,
            cue_id: StoreCueId::Exact(2),
            part_id: StoreCuePartId::Exact(0),
            mode: StoreMode::Replace,
            label: None,
        },
    );

    assert_equivalent_recalled_cue_payload(&source, &stored);
}

/// Verifies replace storage flattens fanned programmer values and timings per reference.
#[test]
fn store_cue_replace_flattens_programmer_instruction_per_fixture_reference() {
    let mut app = setup_app();
    let element_one = fixture_ref(1);
    let mut element_two = element_one.clone();
    element_two.index = Some(2);
    let instruction = BoundCueInstruction {
        selection: SelectionExpr::Resolved(vec![element_one.clone(), element_two.clone()]).into(),
        cue_instruction: CueInstruction {
            blueprint_application: None,
            values: HashMap::from([(
                Attribute::Red,
                ValueSource::Fanned {
                    values: vec![
                        ParameterValue::Absolute { value: 10.0 },
                        ParameterValue::Absolute { value: 20.0 },
                    ],
                },
            )]),
            transitions: PartialTransition {
                fade_in: Some(TransitionMode::Interpolated {
                    start: Duration::ZERO,
                    end: Duration::from_secs(5),
                }),
                fade_out: Some(TransitionMode::Interpolated {
                    start: Duration::ZERO,
                    end: Duration::from_secs(5),
                }),
                ..Default::default()
            },
            transitions_by_attribute: Default::default(),
            transitions_by_fixture_attribute: Default::default(),
            color_path_id: None,
        },
    };
    app.world_mut()
        .resource_mut::<Programmer>()
        .add_instruction(instruction);

    let actions = run_store_command(
        &mut app,
        ProgrammerCommand::StoreCue {
            sequence_id: 5,
            cue_id: StoreCueId::Exact(1),
            part_id: StoreCuePartId::Exact(0),
            mode: StoreMode::Replace,
            label: None,
        },
    );

    apply_cue_actions(&mut app, &actions);
    let cue = app
        .world()
        .resource::<DataProvider<Cue>>()
        .cue_by_sequence_id(app.world().resource::<DataProvider<Sequence>>(), 5, 1)
        .expect("cue should remain in sequence");
    assert_eq!(cue.instructions.len(), 2);
    let first = instruction_for_fixture(&cue.instructions, &element_one);
    let second = instruction_for_fixture(&cue.instructions, &element_two);
    assert_absolute_value(first, Attribute::Red, 10.0);
    assert_absolute_value(second, Attribute::Red, 20.0);
    assert_attribute_fixed_fade_in(first, Attribute::Red, Duration::ZERO);
    assert_attribute_fixed_fade_in(second, Attribute::Red, Duration::from_secs(5));
}

/// Verifies replace storage preserves spatial grid iteration when resolving timing fans.
#[test]
fn store_cue_replace_flattens_spatial_grid_timings_by_iteration_index() {
    let mut app = setup_app();
    insert_multi_element_fixtures(&mut app, 1..=16, 1);
    let fixtures = (1..=16).map(whole_fixture_ref).collect::<Vec<_>>();
    let instruction = BoundCueInstruction {
        selection: SpatialSelection {
            source: SelectionExpr::Resolved(fixtures),
            clauses: vec![SpatialClause::Grid(GridSize::Width(4))],
            union: Vec::new(),
        },
        cue_instruction: CueInstruction {
            blueprint_application: None,
            values: HashMap::from([(
                Attribute::Intensity,
                ValueSource::Inline(ParameterValue::Absolute { value: 0.0 }),
            )]),
            transitions: PartialTransition {
                fade_in: Some(TransitionMode::Interpolated {
                    start: Duration::ZERO,
                    end: Duration::from_secs(2),
                }),
                fade_out: Some(TransitionMode::Interpolated {
                    start: Duration::ZERO,
                    end: Duration::from_secs(2),
                }),
                ..Default::default()
            },
            transitions_by_attribute: Default::default(),
            transitions_by_fixture_attribute: Default::default(),
            color_path_id: None,
        },
    };
    app.world_mut()
        .resource_mut::<Programmer>()
        .add_instruction(instruction);

    let actions = run_store_command(
        &mut app,
        ProgrammerCommand::StoreCue {
            sequence_id: 5,
            cue_id: StoreCueId::Exact(1),
            part_id: StoreCuePartId::Exact(0),
            mode: StoreMode::Replace,
            label: None,
        },
    );

    apply_cue_actions(&mut app, &actions);
    let cue = app
        .world()
        .resource::<DataProvider<Cue>>()
        .cue_by_sequence_id(app.world().resource::<DataProvider<Sequence>>(), 5, 1)
        .expect("cue should remain in sequence");
    assert_eq!(cue.instructions.len(), 16);
    for (expected, fixture_ids) in [
        (Duration::ZERO, [1, 5, 9, 13]),
        (Duration::from_secs_f32(2.0 / 3.0), [2, 6, 10, 14]),
        (Duration::from_secs_f32(4.0 / 3.0), [3, 7, 11, 15]),
        (Duration::from_secs(2), [4, 8, 12, 16]),
    ] {
        for fixture_id in fixture_ids {
            let instruction =
                instruction_for_fixture(&cue.instructions, &whole_fixture_ref(fixture_id));
            assert_attribute_fixed_fade_in(instruction, Attribute::Intensity, expected);
        }
    }
}

/// Verifies replace storage coalesces recalled rows with newly edited fixture values.
#[test]
fn store_cue_replace_coalesces_resolved_and_unresolved_programmer_rows() {
    let mut app = setup_app();
    insert_multi_element_fixtures(&mut app, [311], 1);
    app.world_mut()
        .resource_mut::<Programmer>()
        .add_instruction(bound_instruction(
            whole_fixture_ref(311),
            Attribute::Red,
            100.0,
        ));
    add_programmer_values(
        &mut app,
        SelectionExpr::Fixture(unresolved_fixture_ref(311)),
        &[(Attribute::Intensity, 100.0)],
    );

    let actions = run_store_command(
        &mut app,
        ProgrammerCommand::StoreCue {
            sequence_id: 5,
            cue_id: StoreCueId::Exact(1),
            part_id: StoreCuePartId::Exact(0),
            mode: StoreMode::Replace,
            label: None,
        },
    );

    apply_cue_actions(&mut app, &actions);
    let cue = app
        .world()
        .resource::<DataProvider<Cue>>()
        .cue_by_sequence_id(app.world().resource::<DataProvider<Sequence>>(), 5, 1)
        .expect("cue should remain in sequence");
    assert_eq!(cue.instructions.len(), 1);
    let values = &cue.instructions[0].cue_instruction.values;
    assert!(values.contains_key(&Attribute::Red));
    assert!(values.contains_key(&Attribute::Intensity));
}

/// Verifies replace storage preserves row timings when coalescing fixture rows.
#[test]
fn store_cue_replace_promotes_row_timings_before_coalescing_rows() {
    let mut app = setup_app();
    insert_multi_element_fixtures(&mut app, [311], 1);
    app.world_mut()
        .resource_mut::<Programmer>()
        .add_instruction(BoundCueInstruction {
            selection: SelectionExpr::Resolved(vec![whole_fixture_ref(311)]).into(),
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values: HashMap::from([(
                    Attribute::Red,
                    ValueSource::Inline(ParameterValue::Absolute { value: 100.0 }),
                )]),
                transitions: PartialTransition {
                    fade_in: Some(TransitionMode::Fixed(Duration::from_secs(1))),
                    ..Default::default()
                },
                transitions_by_attribute: Default::default(),
                transitions_by_fixture_attribute: Default::default(),
                color_path_id: None,
            },
        });
    app.world_mut()
        .resource_mut::<Programmer>()
        .add_instruction(BoundCueInstruction {
            selection: SelectionExpr::Fixture(unresolved_fixture_ref(311)).into(),
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values: HashMap::from([(
                    Attribute::Intensity,
                    ValueSource::Inline(ParameterValue::Absolute { value: 100.0 }),
                )]),
                transitions: PartialTransition {
                    fade_in: Some(TransitionMode::Fixed(Duration::from_secs(5))),
                    ..Default::default()
                },
                transitions_by_attribute: Default::default(),
                transitions_by_fixture_attribute: Default::default(),
                color_path_id: None,
            },
        });

    let actions = run_store_command(
        &mut app,
        ProgrammerCommand::StoreCue {
            sequence_id: 5,
            cue_id: StoreCueId::Exact(1),
            part_id: StoreCuePartId::Exact(0),
            mode: StoreMode::Replace,
            label: None,
        },
    );

    let cue = stored_cue(&actions);
    assert_eq!(cue.instructions.len(), 1);
    let instruction = &cue.instructions[0];
    assert_absolute_value(instruction, Attribute::Red, 100.0);
    assert_absolute_value(instruction, Attribute::Intensity, 100.0);
    assert!(instruction.cue_instruction.transitions.fade_in.is_none());
    assert_attribute_fixed_fade_in(instruction, Attribute::Red, Duration::from_secs(1));
    assert_attribute_fixed_fade_in(instruction, Attribute::Intensity, Duration::from_secs(5));
}

/// Verifies merge and update preserve flattened group row counts after recall.
#[test]
fn store_cue_non_replace_modes_preserve_flattened_group_count_after_recall() {
    for mode in [StoreMode::Merge, StoreMode::Update] {
        let mut app = setup_app();
        let fixtures = vec![fixture_ref(11), fixture_ref(12), fixture_ref(13)];
        insert_group(&mut app, 4, fixtures.clone());
        add_programmer_values(
            &mut app,
            SelectionExpr::Group(GroupRefExpr::ById(4)),
            &[(Attribute::Red, 100.0), (Attribute::Green, 100.0)],
        );

        let cue = run_and_apply_store_command(
            &mut app,
            ProgrammerCommand::StoreCue {
                sequence_id: 5,
                cue_id: StoreCueId::Exact(1),
                part_id: StoreCuePartId::Exact(0),
                mode: StoreMode::Replace,
                label: None,
            },
        );
        let initial_count = cue.instructions.len();
        assert_eq!(initial_count, fixtures.len(), "{mode:?}");

        run_store_command(
            &mut app,
            ProgrammerCommand::RecallCue {
                sequence_id: 5,
                cue_id: 1,
                part_id: 0,
                select: false,
            },
        );
        add_programmer_values(
            &mut app,
            SelectionExpr::Group(GroupRefExpr::ById(4)),
            &[(Attribute::Red, 10.0)],
        );

        let cue = run_and_apply_store_command(
            &mut app,
            ProgrammerCommand::StoreCue {
                sequence_id: 5,
                cue_id: StoreCueId::Exact(1),
                part_id: StoreCuePartId::Exact(0),
                mode,
                label: None,
            },
        );

        assert_eq!(cue.instructions.len(), initial_count, "{mode:?}");
        for fixture in &fixtures {
            let instruction = instruction_for_fixture(&cue.instructions, fixture);
            assert_absolute_value(instruction, Attribute::Red, 10.0);
            assert_absolute_value(instruction, Attribute::Green, 100.0);
        }
    }
}

/// Verifies remove preserves flattened group row counts when other attributes remain.
#[test]
fn store_cue_remove_preserves_flattened_group_count_when_other_attributes_remain() {
    let mut app = setup_app();
    let fixtures = vec![fixture_ref(14), fixture_ref(15), fixture_ref(16)];
    insert_group(&mut app, 4, fixtures.clone());
    add_programmer_values(
        &mut app,
        SelectionExpr::Group(GroupRefExpr::ById(4)),
        &[(Attribute::Red, 100.0), (Attribute::Green, 100.0)],
    );

    let cue = run_and_apply_store_command(
        &mut app,
        ProgrammerCommand::StoreCue {
            sequence_id: 5,
            cue_id: StoreCueId::Exact(1),
            part_id: StoreCuePartId::Exact(0),
            mode: StoreMode::Replace,
            label: None,
        },
    );
    let initial_count = cue.instructions.len();
    assert_eq!(initial_count, fixtures.len());

    app.world_mut().resource_mut::<Programmer>().clear();
    add_programmer_values(
        &mut app,
        SelectionExpr::Group(GroupRefExpr::ById(4)),
        &[(Attribute::Red, 10.0)],
    );

    let cue = run_and_apply_store_command(
        &mut app,
        ProgrammerCommand::StoreCue {
            sequence_id: 5,
            cue_id: StoreCueId::Exact(1),
            part_id: StoreCuePartId::Exact(0),
            mode: StoreMode::Remove,
            label: None,
        },
    );

    assert_eq!(cue.instructions.len(), initial_count);
    for fixture in &fixtures {
        let instruction = instruction_for_fixture(&cue.instructions, fixture);
        assert!(
            !instruction
                .cue_instruction
                .values
                .contains_key(&Attribute::Red)
        );
        assert_absolute_value(instruction, Attribute::Green, 100.0);
    }
}

/// Verifies fixture-wide range stores stay fixture-wide for multi-element fixtures.
#[test]
fn store_cue_fixture_range_preserves_whole_fixture_rows_for_multi_element_fixtures() {
    let mut app = setup_app();
    insert_multi_element_fixtures(&mut app, 1..=2, 3);
    add_programmer_values(
        &mut app,
        SelectionExpr::FixtureRange {
            start: unresolved_fixture_ref(1),
            end: unresolved_fixture_ref(2),
        },
        &[(Attribute::Red, 100.0), (Attribute::Green, 100.0)],
    );

    let cue = run_and_apply_store_command(
        &mut app,
        ProgrammerCommand::StoreCue {
            sequence_id: 5,
            cue_id: StoreCueId::Exact(1),
            part_id: StoreCuePartId::Exact(0),
            mode: StoreMode::Replace,
            label: None,
        },
    );

    assert_eq!(cue.instructions.len(), 2);
    for fixture in [whole_fixture_ref(1), whole_fixture_ref(2)] {
        let instruction = instruction_for_fixture(&cue.instructions, &fixture);
        assert_absolute_value(instruction, Attribute::Red, 100.0);
        assert_absolute_value(instruction, Attribute::Green, 100.0);
    }
}

/// Verifies merge and update do not expand recalled whole-fixture rows into element rows.
#[test]
fn store_cue_non_replace_modes_preserve_recalled_whole_fixture_row_count() {
    for mode in [StoreMode::Merge, StoreMode::Update] {
        let mut app = setup_app();
        insert_multi_element_fixtures(&mut app, 1..=2, 3);
        add_programmer_values(
            &mut app,
            SelectionExpr::FixtureRange {
                start: unresolved_fixture_ref(1),
                end: unresolved_fixture_ref(2),
            },
            &[(Attribute::Red, 100.0), (Attribute::Green, 100.0)],
        );

        let initial_cue = run_and_apply_store_command(
            &mut app,
            ProgrammerCommand::StoreCue {
                sequence_id: 5,
                cue_id: StoreCueId::Exact(1),
                part_id: StoreCuePartId::Exact(0),
                mode: StoreMode::Replace,
                label: None,
            },
        );
        let initial_count = initial_cue.instructions.len();
        assert_eq!(initial_count, 2, "{mode:?}");

        run_store_command(
            &mut app,
            ProgrammerCommand::RecallCue {
                sequence_id: 5,
                cue_id: 1,
                part_id: 0,
                select: false,
            },
        );
        add_programmer_values(
            &mut app,
            SelectionExpr::FixtureRange {
                start: unresolved_fixture_ref(1),
                end: unresolved_fixture_ref(2),
            },
            &[(Attribute::Red, 10.0)],
        );

        let cue = run_and_apply_store_command(
            &mut app,
            ProgrammerCommand::StoreCue {
                sequence_id: 5,
                cue_id: StoreCueId::Exact(1),
                part_id: StoreCuePartId::Exact(0),
                mode,
                label: None,
            },
        );

        assert_eq!(cue.instructions.len(), initial_count, "{mode:?}");
        for fixture in [whole_fixture_ref(1), whole_fixture_ref(2)] {
            let instruction = instruction_for_fixture(&cue.instructions, &fixture);
            assert_absolute_value(instruction, Attribute::Red, 10.0);
            assert_absolute_value(instruction, Attribute::Green, 100.0);
        }
    }
}

/// Verifies remove keeps fixture-wide rows when deleting one attribute from multi-element fixtures.
#[test]
fn store_cue_remove_preserves_whole_fixture_rows_for_multi_element_fixtures() {
    let mut app = setup_app();
    insert_multi_element_fixtures(&mut app, 1..=2, 3);
    add_programmer_values(
        &mut app,
        SelectionExpr::FixtureRange {
            start: unresolved_fixture_ref(1),
            end: unresolved_fixture_ref(2),
        },
        &[(Attribute::Red, 100.0), (Attribute::Green, 100.0)],
    );
    let initial_cue = run_and_apply_store_command(
        &mut app,
        ProgrammerCommand::StoreCue {
            sequence_id: 5,
            cue_id: StoreCueId::Exact(1),
            part_id: StoreCuePartId::Exact(0),
            mode: StoreMode::Replace,
            label: None,
        },
    );
    assert_eq!(initial_cue.instructions.len(), 2);

    app.world_mut().resource_mut::<Programmer>().clear();
    add_programmer_values(
        &mut app,
        SelectionExpr::FixtureRange {
            start: unresolved_fixture_ref(1),
            end: unresolved_fixture_ref(2),
        },
        &[(Attribute::Red, 10.0)],
    );

    let cue = run_and_apply_store_command(
        &mut app,
        ProgrammerCommand::StoreCue {
            sequence_id: 5,
            cue_id: StoreCueId::Exact(1),
            part_id: StoreCuePartId::Exact(0),
            mode: StoreMode::Remove,
            label: None,
        },
    );

    assert_eq!(cue.instructions.len(), 2);
    for fixture in [whole_fixture_ref(1), whole_fixture_ref(2)] {
        let instruction = instruction_for_fixture(&cue.instructions, &fixture);
        assert!(
            !instruction
                .cue_instruction
                .values
                .contains_key(&Attribute::Red)
        );
        assert_absolute_value(instruction, Attribute::Green, 100.0);
    }
}

/// Verifies non-replace store modes compact legacy all-element rows back to fixture rows.
#[test]
fn store_cue_non_replace_modes_compact_legacy_all_element_selection_rows() {
    for mode in [StoreMode::Merge, StoreMode::Update, StoreMode::Remove] {
        let mut app = setup_app();
        insert_multi_element_fixtures(&mut app, [1], 3);
        let legacy_all_element_row = BoundCueInstruction {
            selection: SelectionExpr::Resolved(vec![
                element_fixture_ref(1, 1),
                element_fixture_ref(1, 2),
                element_fixture_ref(1, 3),
            ])
            .into(),
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values: HashMap::from([
                    (
                        Attribute::Red,
                        ValueSource::Inline(ParameterValue::Absolute { value: 70.0 }),
                    ),
                    (
                        Attribute::Green,
                        ValueSource::Inline(ParameterValue::Absolute { value: 70.0 }),
                    ),
                ]),
                transitions: Default::default(),
                transitions_by_attribute: Default::default(),
                transitions_by_fixture_attribute: Default::default(),
                color_path_id: None,
            },
        };
        let cue = cue_with_instructions(1, vec![legacy_all_element_row], Vec::new());
        insert_sequence(&mut app, 5, &[cue]);
        add_programmer_values(
            &mut app,
            SelectionExpr::Fixture(UnresolvedFixtureRef {
                fixture_id: 1,
                element_index: None,
            }),
            &[(Attribute::Red, 10.0)],
        );

        let cue = run_and_apply_store_command(
            &mut app,
            ProgrammerCommand::StoreCue {
                sequence_id: 5,
                cue_id: StoreCueId::Exact(1),
                part_id: StoreCuePartId::Exact(0),
                mode,
                label: None,
            },
        );

        assert_eq!(cue.instructions.len(), 1, "{mode:?}");
        let instruction = instruction_for_fixture(&cue.instructions, &whole_fixture_ref(1));
        if mode == StoreMode::Remove {
            assert!(
                !instruction
                    .cue_instruction
                    .values
                    .contains_key(&Attribute::Red)
            );
            assert_absolute_value(instruction, Attribute::Green, 70.0);
        } else {
            assert_absolute_value(instruction, Attribute::Red, 10.0);
            assert_absolute_value(instruction, Attribute::Green, 70.0);
        }
    }
}

/// Verifies update ignores fixtures outside the cue while merge adds them.
#[test]
fn store_cue_update_preserves_count_for_extra_group_and_merge_adds_it() {
    for (mode, expected_count) in [(StoreMode::Update, 2), (StoreMode::Merge, 4)] {
        let mut app = setup_app();
        let group_n = vec![fixture_ref(21), fixture_ref(22)];
        let group_m = vec![fixture_ref(23), fixture_ref(24)];
        insert_group(&mut app, 4, group_n.clone());
        insert_group(&mut app, 5, group_m.clone());
        add_programmer_values(
            &mut app,
            SelectionExpr::Group(GroupRefExpr::ById(4)),
            &[(Attribute::Red, 100.0)],
        );
        let initial_cue = run_and_apply_store_command(
            &mut app,
            ProgrammerCommand::StoreCue {
                sequence_id: 5,
                cue_id: StoreCueId::Exact(1),
                part_id: StoreCuePartId::Exact(0),
                mode: StoreMode::Replace,
                label: None,
            },
        );
        assert_eq!(initial_cue.instructions.len(), group_n.len());

        app.world_mut().resource_mut::<Programmer>().clear();
        add_programmer_values(
            &mut app,
            SelectionExpr::Add {
                lhs: Box::new(SelectionExpr::Group(GroupRefExpr::ById(4))),
                rhs: Box::new(SelectionExpr::Group(GroupRefExpr::ById(5))),
            },
            &[(Attribute::Red, 10.0)],
        );

        let cue = run_and_apply_store_command(
            &mut app,
            ProgrammerCommand::StoreCue {
                sequence_id: 5,
                cue_id: StoreCueId::Exact(1),
                part_id: StoreCuePartId::Exact(0),
                mode,
                label: None,
            },
        );

        assert_eq!(cue.instructions.len(), expected_count, "{mode:?}");
        for fixture in group_n.iter().chain(group_m.iter()) {
            if mode == StoreMode::Update && group_m.contains(fixture) {
                assert!(
                    cue.instructions
                        .iter()
                        .all(|instruction| store_cue_instruction_fixture(instruction)
                            != Some(fixture)),
                    "{fixture:?} should not be added by update"
                );
            } else {
                assert_absolute_value(
                    instruction_for_fixture(&cue.instructions, fixture),
                    Attribute::Red,
                    10.0,
                );
            }
        }
    }
}

/// Verifies part append storage defers ID allocation until cue mutation.
#[test]
fn store_cue_part_next_allocates_lowest_available_part_id() {
    let mut app = setup_app();
    let cue = cue_with_instructions(
        2,
        Vec::new(),
        vec![
            part_with_instructions(1, Vec::new()),
            part_with_instructions(3, Vec::new()),
        ],
    );
    insert_sequence(&mut app, 5, &[cue]);
    app.world_mut()
        .resource_mut::<Programmer>()
        .add_instruction(bound_instruction(fixture_ref(1), Attribute::Red, 10.0));

    let actions = run_store_command(
        &mut app,
        ProgrammerCommand::StoreCue {
            sequence_id: 5,
            cue_id: StoreCueId::Exact(2),
            part_id: StoreCuePartId::Next,
            mode: StoreMode::Replace,
            label: None,
        },
    );

    assert!(
        matches!(
            actions.as_slice(),
            [CueAction::StoreCueInSequence {
                sequence_id: 5,
                cue_id: CueStoreTarget::Exact(2),
                part_id: CuePartStoreTarget::Next,
                ..
            }]
        ),
        "append part storage should defer next-id resolution to cue mutation"
    );

    apply_cue_actions(&mut app, &actions);
    let world = app.world();
    let sequence_provider = world.resource::<DataProvider<Sequence>>();
    let cue = world
        .resource::<DataProvider<Cue>>()
        .cue_by_sequence_id(sequence_provider, 5, 2)
        .expect("cue should remain in the sequence");
    assert!(
        cue.part_by_id(2).is_some(),
        "append part should fill the first available part id"
    );
}

/// Verifies storing p0 updates the parent cue instead of persisting a real cue part.
#[test]
fn store_cue_part_zero_updates_parent_cue_without_creating_part_zero() {
    let mut app = setup_app();
    let cue = cue_with_instructions(
        2,
        vec![bound_instruction(fixture_ref(1), Attribute::Blue, 20.0)],
        vec![part_with_instructions(1, Vec::new())],
    );
    insert_sequence(&mut app, 5, &[cue]);
    app.world_mut()
        .resource_mut::<Programmer>()
        .add_instruction(bound_instruction(fixture_ref(1), Attribute::Red, 10.0));

    let actions = run_store_command(
        &mut app,
        ProgrammerCommand::StoreCue {
            sequence_id: 5,
            cue_id: StoreCueId::Exact(2),
            part_id: StoreCuePartId::Exact(0),
            mode: StoreMode::Replace,
            label: None,
        },
    );

    apply_cue_actions(&mut app, &actions);
    let cue = app
        .world()
        .resource::<DataProvider<Cue>>()
        .cue_by_sequence_id(app.world().resource::<DataProvider<Sequence>>(), 5, 2)
        .expect("cue should remain in sequence");
    assert_eq!(cue.instructions.len(), 1);
    assert_absolute_value(
        instruction_for_fixture(&cue.instructions, &fixture_ref(1)),
        Attribute::Red,
        10.0,
    );
    assert!(
        cue.part_by_id(0).is_none(),
        "p0 must not be created as a real cue part"
    );
    assert!(
        cue.part_by_id(1).is_some(),
        "nonzero cue parts should be preserved"
    );
}

/// Verifies merge storage preserves existing values and adds programmer values.
#[test]
fn store_cue_merge_upserts_programmer_values_into_existing_cue() {
    let mut app = setup_app();
    let fixture = fixture_ref(1);
    let cue = cue_with_instructions(
        1,
        vec![bound_instruction(fixture.clone(), Attribute::Red, 10.0)],
        Vec::new(),
    );
    insert_sequence(&mut app, 5, &[cue]);
    app.world_mut()
        .resource_mut::<Programmer>()
        .add_instruction(bound_instruction(fixture, Attribute::Blue, 20.0));

    let actions = run_store_command(
        &mut app,
        ProgrammerCommand::StoreCue {
            sequence_id: 5,
            cue_id: StoreCueId::Exact(1),
            part_id: StoreCuePartId::Exact(0),
            mode: StoreMode::Merge,
            label: None,
        },
    );

    let cue = stored_cue(&actions);
    let values = &cue.instructions[0].cue_instruction.values;
    assert!(values.contains_key(&Attribute::Red));
    assert!(values.contains_key(&Attribute::Blue));
}

/// Verifies merge storage flattens existing multi-fixture cue instructions before matching.
#[test]
fn store_cue_merge_flattens_existing_fixture_groups_before_matching() {
    let mut app = setup_app();
    let fixture_a = fixture_ref(1);
    let fixture_b = fixture_ref(2);
    let cue = cue_with_instructions(
        1,
        vec![BoundCueInstruction {
            selection: SelectionExpr::Resolved(vec![fixture_a.clone(), fixture_b.clone()]).into(),
            cue_instruction: cue_instruction(Attribute::Red, 10.0),
        }],
        Vec::new(),
    );
    insert_sequence(&mut app, 5, &[cue]);
    app.world_mut()
        .resource_mut::<Programmer>()
        .add_instruction(bound_instruction(fixture_a.clone(), Attribute::Red, 30.0));

    let actions = run_store_command(
        &mut app,
        ProgrammerCommand::StoreCue {
            sequence_id: 5,
            cue_id: StoreCueId::Exact(1),
            part_id: StoreCuePartId::Exact(0),
            mode: StoreMode::Merge,
            label: None,
        },
    );

    let cue = stored_cue(&actions);
    assert_eq!(cue.instructions.len(), 2);
    assert_absolute_value(
        instruction_for_fixture(&cue.instructions, &fixture_a),
        Attribute::Red,
        30.0,
    );
    assert_absolute_value(
        instruction_for_fixture(&cue.instructions, &fixture_b),
        Attribute::Red,
        10.0,
    );
}

/// Verifies whole-fixture merge storage updates existing element rows without appending conflicts.
#[test]
fn store_cue_merge_whole_fixture_updates_existing_element_rows() {
    let mut app = setup_app();
    let element_one = fixture_ref(1);
    let mut element_two = element_one.clone();
    element_two.index = Some(2);
    let whole_fixture = whole_fixture_ref(1);
    let mut element_one_instruction = cue_instruction(Attribute::Red, 70.0);
    element_one_instruction.values.insert(
        Attribute::Blue,
        ValueSource::Inline(ParameterValue::Absolute { value: 70.0 }),
    );
    let mut element_two_instruction = cue_instruction(Attribute::Red, 70.0);
    element_two_instruction.values.insert(
        Attribute::Blue,
        ValueSource::Inline(ParameterValue::Absolute { value: 70.0 }),
    );
    let cue = cue_with_instructions(
        1,
        vec![
            BoundCueInstruction {
                selection: SelectionExpr::Resolved(vec![element_one.clone()]).into(),
                cue_instruction: element_one_instruction,
            },
            BoundCueInstruction {
                selection: SelectionExpr::Resolved(vec![element_two.clone()]).into(),
                cue_instruction: element_two_instruction,
            },
        ],
        Vec::new(),
    );
    insert_sequence(&mut app, 5, &[cue]);
    app.world_mut()
        .resource_mut::<Programmer>()
        .add_instruction(bound_instruction(whole_fixture, Attribute::Red, 0.0));

    let actions = run_store_command(
        &mut app,
        ProgrammerCommand::StoreCue {
            sequence_id: 5,
            cue_id: StoreCueId::Exact(1),
            part_id: StoreCuePartId::Exact(0),
            mode: StoreMode::Merge,
            label: None,
        },
    );

    let cue = stored_cue(&actions);
    assert_eq!(cue.instructions.len(), 2);
    for element in [&element_one, &element_two] {
        let instruction = instruction_for_fixture(&cue.instructions, element);
        assert_absolute_value(instruction, Attribute::Red, 0.0);
        assert_absolute_value(instruction, Attribute::Blue, 70.0);
    }
}

/// Verifies element stores warn once and leave existing whole-fixture rows unchanged.
#[test]
fn store_cue_element_store_warns_once_and_skips_existing_whole_fixture_rows() {
    for mode in [StoreMode::Merge, StoreMode::Update, StoreMode::Remove] {
        let mut app = setup_app();
        insert_multi_element_fixtures(&mut app, [1], 2);

        let whole_fixture = whole_fixture_ref(1);
        let cue = cue_with_instructions(
            1,
            vec![bound_instruction(
                whole_fixture.clone(),
                Attribute::Red,
                70.0,
            )],
            Vec::new(),
        );
        insert_sequence(&mut app, 5, &[cue]);

        let element_one = element_fixture_ref(1, 1);
        let element_two = element_fixture_ref(1, 2);
        app.world_mut()
            .resource_mut::<Programmer>()
            .add_instruction(bound_instruction(element_one, Attribute::Red, 0.0));
        app.world_mut()
            .resource_mut::<Programmer>()
            .add_instruction(bound_instruction(element_two, Attribute::Red, 0.0));

        let operations = run_tracked_store_command(
            &mut app,
            ProgrammerCommand::StoreCue {
                sequence_id: 5,
                cue_id: StoreCueId::Exact(1),
                part_id: StoreCuePartId::Exact(0),
                mode,
                label: None,
            },
        );

        let warnings = command_feedback_messages(&mut app);
        assert_eq!(
            warnings,
            vec!["Element store skipped existing whole-fixture instruction rows"]
        );

        let part = operations
            .iter()
            .find_map(|operation| match operation {
                CueStoreOperation::StoreCueInSequence { part, .. } => Some(part),
                CueStoreOperation::StoreSequence { .. } => None,
            })
            .expect("store command should enqueue a cue store operation");
        assert_eq!(part.instructions.len(), 1);
        assert_absolute_value(
            instruction_for_fixture(&part.instructions, &whole_fixture),
            Attribute::Red,
            70.0,
        );
    }
}

/// Verifies update storage ignores new fixtures and new attributes.
#[test]
fn store_cue_update_only_changes_existing_fixture_attributes() {
    let mut app = setup_app();
    let fixture = fixture_ref(1);
    let other_fixture = fixture_ref(2);
    let cue = cue_with_instructions(
        1,
        vec![bound_instruction(fixture.clone(), Attribute::Red, 10.0)],
        Vec::new(),
    );
    insert_sequence(&mut app, 5, &[cue]);
    {
        let mut programmer = app.world_mut().resource_mut::<Programmer>();
        programmer.add_instruction(bound_instruction(fixture, Attribute::Red, 30.0));
        programmer.add_instruction(bound_instruction(fixture_ref(1), Attribute::Blue, 20.0));
        programmer.add_instruction(bound_instruction(other_fixture, Attribute::Red, 40.0));
    }

    let actions = run_store_command(
        &mut app,
        ProgrammerCommand::StoreCue {
            sequence_id: 5,
            cue_id: StoreCueId::Exact(1),
            part_id: StoreCuePartId::Exact(0),
            mode: StoreMode::Update,
            label: None,
        },
    );

    let cue = stored_cue(&actions);
    assert_eq!(cue.instructions.len(), 1);
    let values = &cue.instructions[0].cue_instruction.values;
    assert!(values.contains_key(&Attribute::Red));
    assert!(!values.contains_key(&Attribute::Blue));
    assert_absolute_value(&cue.instructions[0], Attribute::Red, 30.0);
}

/// Verifies update storage coalesces duplicate rows before matching attributes.
#[test]
fn store_cue_update_coalesces_duplicate_existing_fixture_rows() {
    let mut app = setup_app();
    let fixture = fixture_ref(1);
    let cue = cue_with_instructions(
        1,
        vec![
            bound_instruction(fixture.clone(), Attribute::Red, 10.0),
            bound_instruction(fixture.clone(), Attribute::Blue, 20.0),
        ],
        Vec::new(),
    );
    insert_sequence(&mut app, 5, &[cue]);
    app.world_mut()
        .resource_mut::<Programmer>()
        .add_instruction(bound_instruction(fixture, Attribute::Red, 30.0));

    let actions = run_store_command(
        &mut app,
        ProgrammerCommand::StoreCue {
            sequence_id: 5,
            cue_id: StoreCueId::Exact(1),
            part_id: StoreCuePartId::Exact(0),
            mode: StoreMode::Update,
            label: None,
        },
    );

    let cue = stored_cue(&actions);
    assert_eq!(cue.instructions.len(), 1);
    assert_absolute_value(&cue.instructions[0], Attribute::Red, 30.0);
    assert_absolute_value(&cue.instructions[0], Attribute::Blue, 20.0);
}

/// Verifies update storage splits same-fixture element rows before matching.
#[test]
fn store_cue_update_splits_existing_fixture_elements_before_matching() {
    let mut app = setup_app();
    let element_one = fixture_ref(1);
    let mut element_two = element_one.clone();
    element_two.index = Some(2);
    let cue = cue_with_instructions(
        1,
        vec![BoundCueInstruction {
            selection: SelectionExpr::Resolved(vec![element_one.clone(), element_two.clone()])
                .into(),
            cue_instruction: cue_instruction(Attribute::Red, 10.0),
        }],
        Vec::new(),
    );
    insert_sequence(&mut app, 5, &[cue]);
    app.world_mut()
        .resource_mut::<Programmer>()
        .add_instruction(bound_instruction(element_one.clone(), Attribute::Red, 30.0));

    let actions = run_store_command(
        &mut app,
        ProgrammerCommand::StoreCue {
            sequence_id: 5,
            cue_id: StoreCueId::Exact(1),
            part_id: StoreCuePartId::Exact(0),
            mode: StoreMode::Update,
            label: None,
        },
    );

    let cue = stored_cue(&actions);
    assert_eq!(cue.instructions.len(), 2);
    assert_absolute_value(
        instruction_for_fixture(&cue.instructions, &element_one),
        Attribute::Red,
        30.0,
    );
    assert_absolute_value(
        instruction_for_fixture(&cue.instructions, &element_two),
        Attribute::Red,
        10.0,
    );
}

/// Verifies whole-fixture update storage applies to existing element rows.
#[test]
fn store_cue_update_whole_fixture_updates_existing_element_rows() {
    let mut app = setup_app();
    let element_one = fixture_ref(1);
    let mut element_two = element_one.clone();
    element_two.index = Some(2);
    let whole_fixture = whole_fixture_ref(1);
    let cue = cue_with_instructions(
        1,
        vec![
            bound_instruction(element_one.clone(), Attribute::Red, 70.0),
            bound_instruction(element_two.clone(), Attribute::Red, 70.0),
        ],
        Vec::new(),
    );
    insert_sequence(&mut app, 5, &[cue]);
    app.world_mut()
        .resource_mut::<Programmer>()
        .add_instruction(bound_instruction(whole_fixture, Attribute::Red, 0.0));

    let actions = run_store_command(
        &mut app,
        ProgrammerCommand::StoreCue {
            sequence_id: 5,
            cue_id: StoreCueId::Exact(1),
            part_id: StoreCuePartId::Exact(0),
            mode: StoreMode::Update,
            label: None,
        },
    );

    let cue = stored_cue(&actions);
    assert_eq!(cue.instructions.len(), 2);
    assert_absolute_value(
        instruction_for_fixture(&cue.instructions, &element_one),
        Attribute::Red,
        0.0,
    );
    assert_absolute_value(
        instruction_for_fixture(&cue.instructions, &element_two),
        Attribute::Red,
        0.0,
    );
}

/// Verifies part update storage resolves existing group selections before matching.
#[test]
fn store_cue_part_update_resolves_existing_group_selection_before_matching() {
    let mut app = setup_app();
    let fixture = fixture_ref(1);
    insert_group(&mut app, 13, vec![fixture.clone()]);
    let cue = cue_with_instructions(
        1,
        Vec::new(),
        vec![part_with_instructions(
            2,
            vec![BoundCueInstruction {
                selection: SelectionExpr::Group(GroupRefExpr::ById(13)).into(),
                cue_instruction: cue_instruction(Attribute::Red, 10.0),
            }],
        )],
    );
    insert_sequence(&mut app, 5, &[cue]);
    app.world_mut()
        .resource_mut::<Programmer>()
        .add_instruction(bound_instruction(fixture.clone(), Attribute::Red, 30.0));

    let actions = run_store_command(
        &mut app,
        ProgrammerCommand::StoreCue {
            sequence_id: 5,
            cue_id: StoreCueId::Exact(1),
            part_id: StoreCuePartId::Exact(2),
            mode: StoreMode::Update,
            label: None,
        },
    );

    let cue = stored_cue(&actions);
    let part = cue.part_by_id(2).expect("part should be stored");
    assert_eq!(part.instructions.len(), 1);
    assert_absolute_value(
        instruction_for_fixture(&part.instructions, &fixture),
        Attribute::Red,
        30.0,
    );
}

/// Verifies remove storage deletes programmer attributes from matching stored fixtures.
#[test]
fn store_cue_remove_deletes_programmer_attributes_from_existing_cue() {
    let mut app = setup_app();
    let fixture = fixture_ref(1);
    let mut existing = cue_instruction(Attribute::Red, 10.0);
    existing.values.insert(
        Attribute::Blue,
        ValueSource::Inline(ParameterValue::Absolute { value: 20.0 }),
    );
    let cue = cue_with_instructions(
        1,
        vec![BoundCueInstruction {
            selection: SelectionExpr::Resolved(vec![fixture.clone()]).into(),
            cue_instruction: existing,
        }],
        Vec::new(),
    );
    insert_sequence(&mut app, 5, &[cue]);
    app.world_mut()
        .resource_mut::<Programmer>()
        .add_instruction(bound_instruction(fixture, Attribute::Red, 30.0));

    let actions = run_store_command(
        &mut app,
        ProgrammerCommand::StoreCue {
            sequence_id: 5,
            cue_id: StoreCueId::Exact(1),
            part_id: StoreCuePartId::Exact(0),
            mode: StoreMode::Remove,
            label: None,
        },
    );

    let cue = stored_cue(&actions);
    let values = &cue.instructions[0].cue_instruction.values;
    assert!(!values.contains_key(&Attribute::Red));
    assert!(values.contains_key(&Attribute::Blue));
}

/// Verifies remove storage coalesces duplicate rows before removing attributes.
#[test]
fn store_cue_remove_coalesces_duplicate_existing_fixture_rows() {
    let mut app = setup_app();
    let fixture = fixture_ref(1);
    let cue = cue_with_instructions(
        1,
        vec![
            bound_instruction(fixture.clone(), Attribute::Red, 10.0),
            bound_instruction(fixture.clone(), Attribute::Blue, 20.0),
        ],
        Vec::new(),
    );
    insert_sequence(&mut app, 5, &[cue]);
    app.world_mut()
        .resource_mut::<Programmer>()
        .add_instruction(bound_instruction(fixture, Attribute::Red, 30.0));

    let actions = run_store_command(
        &mut app,
        ProgrammerCommand::StoreCue {
            sequence_id: 5,
            cue_id: StoreCueId::Exact(1),
            part_id: StoreCuePartId::Exact(0),
            mode: StoreMode::Remove,
            label: None,
        },
    );

    let cue = stored_cue(&actions);
    assert_eq!(cue.instructions.len(), 1);
    let values = &cue.instructions[0].cue_instruction.values;
    assert!(!values.contains_key(&Attribute::Red));
    assert!(values.contains_key(&Attribute::Blue));
}

/// Verifies whole-fixture remove storage removes attributes from existing element rows.
#[test]
fn store_cue_remove_whole_fixture_removes_existing_element_row_attributes() {
    let mut app = setup_app();
    let element_one = fixture_ref(1);
    let mut element_two = element_one.clone();
    element_two.index = Some(2);
    let whole_fixture = whole_fixture_ref(1);
    let mut element_one_instruction = cue_instruction(Attribute::Red, 70.0);
    element_one_instruction.values.insert(
        Attribute::Blue,
        ValueSource::Inline(ParameterValue::Absolute { value: 70.0 }),
    );
    let mut element_two_instruction = cue_instruction(Attribute::Red, 70.0);
    element_two_instruction.values.insert(
        Attribute::Blue,
        ValueSource::Inline(ParameterValue::Absolute { value: 70.0 }),
    );
    let cue = cue_with_instructions(
        1,
        vec![
            BoundCueInstruction {
                selection: SelectionExpr::Resolved(vec![element_one.clone()]).into(),
                cue_instruction: element_one_instruction,
            },
            BoundCueInstruction {
                selection: SelectionExpr::Resolved(vec![element_two.clone()]).into(),
                cue_instruction: element_two_instruction,
            },
        ],
        Vec::new(),
    );
    insert_sequence(&mut app, 5, &[cue]);
    app.world_mut()
        .resource_mut::<Programmer>()
        .add_instruction(bound_instruction(whole_fixture, Attribute::Red, 0.0));

    let actions = run_store_command(
        &mut app,
        ProgrammerCommand::StoreCue {
            sequence_id: 5,
            cue_id: StoreCueId::Exact(1),
            part_id: StoreCuePartId::Exact(0),
            mode: StoreMode::Remove,
            label: None,
        },
    );

    let cue = stored_cue(&actions);
    assert_eq!(cue.instructions.len(), 2);
    for element in [&element_one, &element_two] {
        let values = &instruction_for_fixture(&cue.instructions, element)
            .cue_instruction
            .values;
        assert!(!values.contains_key(&Attribute::Red));
        assert!(values.contains_key(&Attribute::Blue));
    }
}

/// Verifies remove storage drops stored fixtures once their last attribute is removed.
#[test]
fn store_cue_remove_drops_fixture_with_no_remaining_attributes() {
    let mut app = setup_app();
    let fixture = fixture_ref(1);
    let cue = cue_with_instructions(
        1,
        vec![bound_instruction(fixture.clone(), Attribute::Red, 10.0)],
        Vec::new(),
    );
    insert_sequence(&mut app, 5, &[cue]);
    app.world_mut()
        .resource_mut::<Programmer>()
        .add_instruction(bound_instruction(fixture, Attribute::Red, 30.0));

    let actions = run_store_command(
        &mut app,
        ProgrammerCommand::StoreCue {
            sequence_id: 5,
            cue_id: StoreCueId::Exact(1),
            part_id: StoreCuePartId::Exact(0),
            mode: StoreMode::Remove,
            label: None,
        },
    );

    let cue = stored_cue(&actions);
    assert!(
        cue.instructions.is_empty(),
        "fixture instruction should be pruned after its last attribute is removed"
    );
}

/// Verifies remove storage also deletes transition overrides for removed attributes.
#[test]
fn store_cue_remove_drops_orphaned_fixture_attribute_transitions() {
    let mut app = setup_app();
    let fixture = fixture_ref(1);
    let mut existing = cue_instruction(Attribute::Red, 10.0);
    existing
        .transitions_by_fixture_attribute
        .push(FixtureAttributeTransition {
            fixture: fixture.clone(),
            transitions_by_attribute: HashMap::from([(
                Attribute::Red,
                PartialTransition::default(),
            )]),
        });
    let cue = cue_with_instructions(
        1,
        vec![BoundCueInstruction {
            selection: SelectionExpr::Resolved(vec![fixture.clone()]).into(),
            cue_instruction: existing,
        }],
        Vec::new(),
    );
    insert_sequence(&mut app, 5, &[cue]);
    app.world_mut()
        .resource_mut::<Programmer>()
        .add_instruction(bound_instruction(fixture, Attribute::Red, 30.0));

    let actions = run_store_command(
        &mut app,
        ProgrammerCommand::StoreCue {
            sequence_id: 5,
            cue_id: StoreCueId::Exact(1),
            part_id: StoreCuePartId::Exact(0),
            mode: StoreMode::Remove,
            label: None,
        },
    );

    let cue = stored_cue(&actions);
    assert!(
        cue.instructions.is_empty(),
        "fixture instruction should be pruned after value and transition data are removed"
    );
}

/// Verifies merge storage reports a clear error when the target cue is missing.
#[test]
fn store_cue_merge_requires_existing_target() {
    let mut app = setup_app();
    app.world_mut()
        .resource_mut::<Programmer>()
        .add_instruction(bound_instruction(fixture_ref(1), Attribute::Red, 10.0));

    let operations = run_tracked_store_command(
        &mut app,
        ProgrammerCommand::StoreCue {
            sequence_id: 5,
            cue_id: StoreCueId::Exact(1),
            part_id: StoreCuePartId::Exact(0),
            mode: StoreMode::Merge,
            label: None,
        },
    );

    assert!(operations.is_empty());
    assert!(
        command_feedback_messages(&mut app)
            .iter()
            .any(|message| message.contains("must exist")),
        "missing merge target should produce a clear command error"
    );
}

/// Verifies a tracked store command remains active until its cues operation succeeds.
#[test]
fn tracked_store_cue_finishes_only_after_operation_result() {
    let mut app = setup_app();
    let command_id = CommandId::new();
    app.world_mut()
        .resource_mut::<CommandTracker>()
        .register_context(
            command_id,
            command_id.into(),
            CommandOrigin::WebUi,
            ReplyTarget::ClientBroadcast,
        )
        .unwrap();
    app.world_mut().write_message(CommandEnvelope::with_context(
        command_id,
        command_id.into(),
        CommandOrigin::WebUi,
        ReplyTarget::ClientBroadcast,
        ProgrammerCommand::StoreCue {
            sequence_id: 11,
            cue_id: StoreCueId::Exact(1),
            part_id: StoreCuePartId::Exact(0),
            mode: StoreMode::Replace,
            label: None,
        },
    ));

    app.update();

    assert!(
        app.world()
            .resource::<CommandTracker>()
            .is_active(command_id)
    );
    assert!(
        app.world_mut()
            .resource_mut::<Messages<CommandResult>>()
            .drain()
            .next()
            .is_none(),
        "planning the cues operation must not finish the command"
    );
    let operation = app
        .world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<CueStoreOperation>>>()
        .drain()
        .next()
        .expect("tracked store should emit one typed cues operation");
    assert_eq!(operation.command_id, Some(command_id));
    assert_eq!(operation.undo_id, Some(command_id.into()));

    app.world_mut().write_message(
        OperationResult::<CueStoreSuccess, CueStoreError>::succeeded(
            operation.operation_id,
            CueStoreSuccess {
                sequence_id: 11,
                cue_id: 1,
                part_id: 0,
            },
        ),
    );
    app.update();

    assert!(
        !app.world()
            .resource::<CommandTracker>()
            .is_active(command_id)
    );
    let result = app
        .world_mut()
        .resource_mut::<Messages<CommandResult>>()
        .drain()
        .next()
        .expect("operation success should finish the command");
    assert_eq!(result.command_id, command_id);
    assert!(matches!(result.outcome, CommandOutcome::Succeeded { .. }));
}

/// Verifies a cues-domain operation failure becomes the command's single terminal failure.
#[test]
fn tracked_store_cue_maps_operation_failure_to_command_failure() {
    let mut app = setup_app();
    let command_id = CommandId::new();
    app.world_mut()
        .resource_mut::<CommandTracker>()
        .register_context(
            command_id,
            command_id.into(),
            CommandOrigin::WebUi,
            ReplyTarget::ClientBroadcast,
        )
        .unwrap();
    app.world_mut().write_message(CommandEnvelope::with_context(
        command_id,
        command_id.into(),
        CommandOrigin::WebUi,
        ReplyTarget::ClientBroadcast,
        ProgrammerCommand::StoreCue {
            sequence_id: 11,
            cue_id: StoreCueId::Exact(1),
            part_id: StoreCuePartId::Exact(0),
            mode: StoreMode::Replace,
            label: None,
        },
    ));
    app.update();
    let operation_id = app
        .world_mut()
        .resource_mut::<Messages<EngineActionEnvelope<CueStoreOperation>>>()
        .drain()
        .next()
        .unwrap()
        .operation_id;

    app.world_mut()
        .write_message(OperationResult::<CueStoreSuccess, CueStoreError>::failed(
            operation_id,
            CueStoreError::new("cue.store_conflict", "Cue ID already exists"),
        ));
    app.update();

    let result = app
        .world_mut()
        .resource_mut::<Messages<CommandResult>>()
        .drain()
        .next()
        .expect("operation failure should finish the command");
    assert!(matches!(
        result.outcome,
        CommandOutcome::Failed(ref error)
            if error.code == "cue.store_conflict" && error.message == "Cue ID already exists"
    ));
    assert!(
        app.world_mut()
            .resource_mut::<Messages<CommandResult>>()
            .drain()
            .next()
            .is_none()
    );
}

/// Verifies stored cue rows no longer depend on the authored group alias.
#[test]
fn store_cue_merge_materializes_existing_group_refs_before_persistence() {
    let mut app = setup_app();
    let fixture = FixtureRef {
        fixture_uid: Uuid::from_u128(1),
        index: None,
    };
    insert_multi_element_fixtures(&mut app, [1], 1);
    insert_group(&mut app, 9, vec![fixture.clone()]);
    let existing = cue_with_instructions(
        1,
        vec![BoundCueInstruction {
            selection: SpatialSelection::identity(SelectionExpr::Group(GroupRefExpr::ById(9))),
            cue_instruction: cue_instruction(Attribute::Intensity, 50.0),
        }],
        Vec::new(),
    );
    insert_sequence(&mut app, 1, &[existing]);

    let stored = run_and_apply_store_command(
        &mut app,
        ProgrammerCommand::StoreCue {
            sequence_id: 1,
            cue_id: StoreCueId::Exact(1),
            part_id: StoreCuePartId::Exact(0),
            mode: StoreMode::Merge,
            label: None,
        },
    );

    assert_eq!(
        stored.instructions[0].selection.source,
        SelectionExpr::Resolved(vec![fixture])
    );
}

/// Verifies a tracked recall reports a structured failure when its cue does not exist.
#[test]
fn tracked_recall_cue_reports_not_found() {
    let mut app = setup_app();
    let envelope = CommandEnvelope::new(
        ProgrammerCommand::RecallCue {
            sequence_id: 99,
            cue_id: 42,
            part_id: 0,
            select: false,
        },
        CommandOrigin::WebUi,
        ReplyTarget::Detached,
    );
    let command_id = envelope.command_id;
    app.world_mut()
        .resource_mut::<CommandTracker>()
        .register(&envelope)
        .expect("recall cue command should register");
    app.world_mut().write_message(envelope);

    app.update();

    let results: Vec<_> = app
        .world_mut()
        .resource_mut::<Messages<CommandResult>>()
        .drain()
        .collect();
    assert!(matches!(
        results.as_slice(),
        [CommandResult {
            command_id: result_command_id,
            outcome: CommandOutcome::Failed(error),
        }] if *result_command_id == command_id && error.code == "programmer.cue_not_found"
    ));
}
