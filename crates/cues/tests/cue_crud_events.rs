// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::collections::HashMap;

use bevy_app::prelude::*;
use bevy_ecs::prelude::{MessageReader, Messages, ResMut};
use bevy_ecs::schedule::IntoScheduleConfigs;
use nightfall::prelude::*;
use nightfall_cues::data_provider_ext::CueDataProviderExt;
use nightfall_cues::events::{cue_action_events, cue_crud_events};
use nightfall_cues::prelude::{
    BoundCueInstruction, Cue, CueAction, CueCommand, CueInstruction, CuePart, CuePartStoreTarget,
    CueStoreTarget, Sequence,
};
use nightfall_cues::websocket::{CueDefinitionChange, SequenceDefinitionChange};
use nightfall_dmx::prelude::{Attribute, ParameterValue};
use nightfall_engine::prelude::{
    CommandEnvelope, CommandId, CommandNotice, CommandOrigin, CommandOutcome, CommandOutput,
    CommandReply, CommandResult, CommandTracker, DataProvider, EngineActionEnvelope,
    FinishedCommand, OperationId, ReplyTarget, UndoId,
};
use nightfall_fixtures::prelude::{Fixture, FixtureDataProviderExt, FixtureElement};
use nightfall_undo::prelude::UndoManager;
use uuid::Uuid;

fn init_cue_runtime_resources(app: &mut App) {
    app.insert_resource(DataProvider::<Cue>::default());
    app.insert_resource(DataProvider::<Sequence>::default());
    app.insert_resource(DataProvider::<Blueprint>::default());
    app.insert_resource(DataProvider::<ColorPath>::default());
    app.insert_resource(DataProvider::<Group>::default());
    app.init_resource::<FixtureDataProviderExt>();
    app.init_resource::<UndoManager>();
    app.init_resource::<CommandTracker>();
    app.add_message::<CommandResult>();
    app.add_message::<CommandReply>();
    app.add_message::<FinishedCommand>();
    app.add_message::<CommandNotice>();
    app.add_message::<CueDefinitionChange>();
    app.add_message::<SequenceDefinitionChange>();
}

/// Registers test command envelopes before the domain handler observes them.
fn register_cue_commands(
    mut commands: MessageReader<CommandEnvelope<CueCommand>>,
    mut tracker: ResMut<CommandTracker>,
) {
    for command in commands.read() {
        tracker
            .register(command)
            .expect("test cue command should register");
    }
}

/// Wraps a cue command in detached semantic ingress context for handler tests.
fn cue_command_message(command: CueCommand) -> CommandEnvelope<CueCommand> {
    CommandEnvelope::new(command, CommandOrigin::Cli, ReplyTarget::Detached)
}

fn build_cue(id: u32, uid: Uuid, label: &str) -> Cue {
    Cue {
        identifiers: Identifiers {
            id,
            uid,
            label: label.to_string(),
        },
        ..Default::default()
    }
}

fn build_sequence(id: u32, uid: Uuid, label: &str, steps: Vec<Uuid>) -> Sequence {
    Sequence {
        identifiers: Identifiers {
            id,
            uid,
            label: label.to_string(),
        },
        steps: steps.into_iter().map(Into::into).collect(),
        ..Default::default()
    }
}

/// Builds a resolved fixture element reference for cue block tests.
fn element_fixture_ref(seed: u128, index: u32) -> FixtureRef {
    FixtureRef {
        fixture_uid: Uuid::from_u128(seed),
        index: Some(index),
    }
}

/// Builds a resolved fixture reference for cue block tests.
fn fixture_ref(seed: u128) -> FixtureRef {
    element_fixture_ref(seed, 1)
}

/// Builds a resolved whole-fixture reference for cue block tests.
fn whole_fixture_ref(seed: u128) -> FixtureRef {
    FixtureRef {
        fixture_uid: Uuid::from_u128(seed),
        index: None,
    }
}

/// Builds a fixture with multiple elements so block tests can validate element collapse.
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

/// Builds a single-attribute cue instruction for block test payloads.
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

/// Builds a bound instruction whose logical values are resolved from one live Blueprint.
fn referenced_blueprint_instruction(
    fixture: FixtureRef,
    blueprint_uid: Uuid,
    selector: BlueprintSelector,
) -> BoundCueInstruction {
    BoundCueInstruction {
        selection: SelectionExpr::Resolved(vec![fixture]).into(),
        cue_instruction: CueInstruction {
            blueprint_application: Some(BlueprintApplication {
                blueprint_uid,
                selector,
            }),
            ..Default::default()
        },
    }
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
        .add(Sequence {
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
        })
        .expect("sequence should insert");
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

/// Builds an assertion instruction from explicit value sources.
fn assertion_instruction(
    values: impl IntoIterator<Item = (Attribute, ValueSource)>,
) -> CueInstruction {
    CueInstruction {
        blueprint_application: None,
        values: values.into_iter().collect(),
        transitions: Default::default(),
        transitions_by_attribute: Default::default(),
        transitions_by_fixture_attribute: Default::default(),
        color_path_id: None,
    }
}

/// Builds a cue containing one complete RGB color instruction.
fn build_rgb_cue(id: u32, uid: Uuid, label: &str, fixture: FixtureRef) -> Cue {
    Cue {
        identifiers: Identifiers {
            id,
            uid,
            label: label.to_string(),
        },
        instructions: vec![BoundCueInstruction {
            selection: SelectionExpr::Resolved(vec![fixture]).into(),
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values: HashMap::from([
                    (
                        Attribute::Red,
                        ValueSource::Inline(ParameterValue::Absolute { value: 255.0 }),
                    ),
                    (
                        Attribute::Green,
                        ValueSource::Inline(ParameterValue::Absolute { value: 0.0 }),
                    ),
                    (
                        Attribute::Blue,
                        ValueSource::Inline(ParameterValue::Absolute { value: 0.0 }),
                    ),
                ]),
                ..Default::default()
            },
        }],
        ..Default::default()
    }
}

/// Builds a cue containing one complete CMY color instruction.
fn build_cmy_cue(id: u32, uid: Uuid, label: &str, fixture: FixtureRef) -> Cue {
    Cue {
        identifiers: Identifiers {
            id,
            uid,
            label: label.to_string(),
        },
        instructions: vec![BoundCueInstruction {
            selection: SelectionExpr::Resolved(vec![fixture]).into(),
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values: HashMap::from([
                    (
                        Attribute::Cyan,
                        ValueSource::Inline(ParameterValue::Absolute { value: 255.0 }),
                    ),
                    (
                        Attribute::Magenta,
                        ValueSource::Inline(ParameterValue::Absolute { value: 0.0 }),
                    ),
                    (
                        Attribute::Yellow,
                        ValueSource::Inline(ParameterValue::Absolute { value: 0.0 }),
                    ),
                ]),
                ..Default::default()
            },
        }],
        ..Default::default()
    }
}

/// Builds a cue containing one scalar color emitter instruction.
fn build_scalar_color_cue(id: u32, uid: Uuid, label: &str, fixture: FixtureRef) -> Cue {
    Cue {
        identifiers: Identifiers {
            id,
            uid,
            label: label.to_string(),
        },
        instructions: vec![BoundCueInstruction {
            selection: SelectionExpr::Resolved(vec![fixture]).into(),
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values: HashMap::from([(
                    Attribute::White,
                    ValueSource::Inline(ParameterValue::Absolute { value: 255.0 }),
                )]),
                ..Default::default()
            },
        }],
        ..Default::default()
    }
}

/// Creates an app with resources needed by cue CRUD handling.
fn setup_cue_crud_app() -> App {
    let mut app = App::new();
    app.add_message::<CommandEnvelope<CueCommand>>();
    init_cue_runtime_resources(&mut app);
    app.add_systems(Update, (register_cue_commands, cue_crud_events).chain());
    app
}

/// Emits a cue command and returns snapshots matching block test assertions.
fn run_cue_command(app: &mut App, command: CueCommand) -> Vec<CueAction> {
    app.world_mut()
        .write_message(cue_command_message(command.clone()));
    app.update();
    match command {
        CueCommand::BlockCue {
            sequence_id,
            cue_id,
            ..
        }
        | CueCommand::UnblockCue {
            sequence_id,
            cue_id,
            ..
        } => {
            if cue_id == 0 {
                let sequence = (*app
                    .world()
                    .resource::<DataProvider<Sequence>>()
                    .from_id(sequence_id)
                    .expect("sequence should exist after cue command"))
                .clone();
                vec![CueAction::StoreSequence(Box::new(sequence))]
            } else {
                let cue = (*app
                    .world()
                    .resource::<DataProvider<Cue>>()
                    .cue_by_sequence_id(
                        app.world().resource::<DataProvider<Sequence>>(),
                        sequence_id,
                        cue_id,
                    )
                    .expect("cue should exist after cue command"))
                .clone();
                vec![CueAction::StoreCue(Box::new(cue))]
            }
        }
        _ => Vec::new(),
    }
}

/// Extracts the cue snapshot stored by a cue action list.
fn stored_cue(actions: &[CueAction]) -> Cue {
    *actions
        .iter()
        .find_map(|action| match action {
            CueAction::StoreCue(cue) => Some(cue.clone()),
            _ => None,
        })
        .expect("cue store action should be queued")
}

/// Returns and clears command results emitted by the command system.
fn drain_command_results(app: &mut App) -> Vec<CommandResult> {
    app.world_mut()
        .resource_mut::<Messages<CommandResult>>()
        .drain()
        .collect()
}

/// Returns and clears committed cue definition changes emitted by cue systems.
fn drain_cue_definition_changes(app: &mut App) -> Vec<CueDefinitionChange> {
    app.world_mut()
        .resource_mut::<Messages<CueDefinitionChange>>()
        .drain()
        .collect()
}

/// Returns and clears committed sequence definition changes emitted by cue systems.
fn drain_sequence_definition_changes(app: &mut App) -> Vec<SequenceDefinitionChange> {
    app.world_mut()
        .resource_mut::<Messages<SequenceDefinitionChange>>()
        .drain()
        .collect()
}

/// Verifies cue color path commands assign built-in paths to RGB instructions.
#[test]
fn set_cue_color_path_assigns_path_to_rgb_instruction() {
    let mut app = setup_cue_crud_app();
    let cue_uid = Uuid::new_v4();
    let sequence_uid = Uuid::new_v4();
    let fixture = FixtureRef {
        fixture_uid: Uuid::new_v4(),
        index: Some(1),
    };

    app.world_mut()
        .resource_mut::<DataProvider<Cue>>()
        .add(build_rgb_cue(1, cue_uid, "rgb cue", fixture))
        .expect("cue should insert");
    app.world_mut()
        .resource_mut::<DataProvider<Sequence>>()
        .add(build_sequence(1, sequence_uid, "sequence", vec![cue_uid]))
        .expect("sequence should insert");

    app.world_mut()
        .write_message(cue_command_message(CueCommand::SetCueColorPath {
            sequence_id: 1,
            cue_id: 1,
            color_path_id: Some(ColorPathId(3)),
        }));
    app.update();

    let cue = app
        .world()
        .resource::<DataProvider<Cue>>()
        .get(cue_uid)
        .expect("cue should exist");
    assert_eq!(
        cue.instructions[0].cue_instruction.color_path_id,
        Some(ColorPathId(3))
    );
}

/// Verifies cue color path commands assign built-in paths to CMY instructions.
#[test]
fn set_cue_color_path_assigns_path_to_cmy_instruction() {
    let mut app = setup_cue_crud_app();
    let cue_uid = Uuid::new_v4();
    let sequence_uid = Uuid::new_v4();
    let fixture = FixtureRef {
        fixture_uid: Uuid::new_v4(),
        index: Some(1),
    };

    app.world_mut()
        .resource_mut::<DataProvider<Cue>>()
        .add(build_cmy_cue(1, cue_uid, "cmy cue", fixture))
        .expect("cue should insert");
    app.world_mut()
        .resource_mut::<DataProvider<Sequence>>()
        .add(build_sequence(1, sequence_uid, "sequence", vec![cue_uid]))
        .expect("sequence should insert");

    app.world_mut()
        .write_message(cue_command_message(CueCommand::SetCueColorPath {
            sequence_id: 1,
            cue_id: 1,
            color_path_id: Some(ColorPathId(3)),
        }));
    app.update();

    let cue = app
        .world()
        .resource::<DataProvider<Cue>>()
        .get(cue_uid)
        .expect("cue should exist");
    assert_eq!(
        cue.instructions[0].cue_instruction.color_path_id,
        Some(ColorPathId(3))
    );
}

/// Verifies cue color path commands assign built-in paths to scalar color emitter instructions.
#[test]
fn set_cue_color_path_assigns_path_to_scalar_color_instruction() {
    let mut app = setup_cue_crud_app();
    let cue_uid = Uuid::new_v4();
    let sequence_uid = Uuid::new_v4();
    let fixture = FixtureRef {
        fixture_uid: Uuid::new_v4(),
        index: Some(1),
    };

    app.world_mut()
        .resource_mut::<DataProvider<Cue>>()
        .add(build_scalar_color_cue(1, cue_uid, "white cue", fixture))
        .expect("cue should insert");
    app.world_mut()
        .resource_mut::<DataProvider<Sequence>>()
        .add(build_sequence(1, sequence_uid, "sequence", vec![cue_uid]))
        .expect("sequence should insert");

    app.world_mut()
        .write_message(cue_command_message(CueCommand::SetCueColorPath {
            sequence_id: 1,
            cue_id: 1,
            color_path_id: Some(ColorPathId(3)),
        }));
    app.update();

    let cue = app
        .world()
        .resource::<DataProvider<Cue>>()
        .get(cue_uid)
        .expect("cue should exist");
    assert_eq!(
        cue.instructions[0].cue_instruction.color_path_id,
        Some(ColorPathId(3))
    );
}

/// Verifies cue color path commands can clear an assigned path.
#[test]
fn set_cue_color_path_clears_existing_assignment() {
    let mut app = setup_cue_crud_app();
    let cue_uid = Uuid::new_v4();
    let sequence_uid = Uuid::new_v4();
    let fixture = FixtureRef {
        fixture_uid: Uuid::new_v4(),
        index: Some(1),
    };
    let mut cue = build_rgb_cue(1, cue_uid, "rgb cue", fixture);
    cue.instructions[0].cue_instruction.color_path_id = Some(ColorPathId(3));

    app.world_mut()
        .resource_mut::<DataProvider<Cue>>()
        .add(cue)
        .expect("cue should insert");
    app.world_mut()
        .resource_mut::<DataProvider<Sequence>>()
        .add(build_sequence(1, sequence_uid, "sequence", vec![cue_uid]))
        .expect("sequence should insert");

    app.world_mut()
        .write_message(cue_command_message(CueCommand::SetCueColorPath {
            sequence_id: 1,
            cue_id: 1,
            color_path_id: None,
        }));
    app.update();

    let cue = app
        .world()
        .resource::<DataProvider<Cue>>()
        .get(cue_uid)
        .expect("cue should exist");
    assert_eq!(cue.instructions[0].cue_instruction.color_path_id, None);
}

/// Verifies cue color path commands reject unknown path IDs.
#[test]
fn set_cue_color_path_rejects_unknown_path() {
    let mut app = setup_cue_crud_app();
    let cue_uid = Uuid::new_v4();
    let sequence_uid = Uuid::new_v4();
    let fixture = FixtureRef {
        fixture_uid: Uuid::new_v4(),
        index: Some(1),
    };

    app.world_mut()
        .resource_mut::<DataProvider<Cue>>()
        .add(build_rgb_cue(1, cue_uid, "rgb cue", fixture))
        .expect("cue should insert");
    app.world_mut()
        .resource_mut::<DataProvider<Sequence>>()
        .add(build_sequence(1, sequence_uid, "sequence", vec![cue_uid]))
        .expect("sequence should insert");

    app.world_mut()
        .write_message(cue_command_message(CueCommand::SetCueColorPath {
            sequence_id: 1,
            cue_id: 1,
            color_path_id: Some(ColorPathId(999)),
        }));
    app.update();

    let cue = app
        .world()
        .resource::<DataProvider<Cue>>()
        .get(cue_uid)
        .expect("cue should exist");
    assert_eq!(cue.instructions[0].cue_instruction.color_path_id, None);
}

/// Verifies color path definitions can be stored through cue CRUD commands.
#[test]
fn store_color_path_adds_color_path_definition() {
    let mut app = setup_cue_crud_app();
    let color_path = ColorPath::new(101, "No Green", ColorInterpolationSpace::Hsv);

    app.world_mut()
        .write_message(cue_command_message(CueCommand::StoreColorPath(
            color_path.clone(),
        )));
    app.update();

    let stored = app
        .world()
        .resource::<DataProvider<ColorPath>>()
        .from_id(101)
        .expect("color path should exist");
    assert_eq!(stored.identifiers.label, "No Green");
    assert_eq!(stored.interpolation_space, ColorInterpolationSpace::Hsv);
}

/// Verifies built-in color path IDs cannot be overwritten through store commands.
#[test]
fn store_color_path_rejects_builtin_id() {
    let mut app = setup_cue_crud_app();
    let builtin = builtin_color_paths()
        .into_iter()
        .find(|path| path.identifiers.id == 1)
        .expect("rgb built-in path should exist");
    app.world_mut()
        .resource_mut::<DataProvider<ColorPath>>()
        .add(builtin.clone())
        .expect("built-in path should insert");

    let replacement = ColorPath::new(1, "Replacement", ColorInterpolationSpace::Hsv);
    app.world_mut()
        .write_message(cue_command_message(CueCommand::StoreColorPath(replacement)));
    app.update();

    let stored = app
        .world()
        .resource::<DataProvider<ColorPath>>()
        .from_id(1)
        .expect("built-in color path should remain")
        .clone();
    assert_eq!(stored, builtin);

    let results = drain_command_results(&mut app);
    assert_eq!(results.len(), 1);
    match &results[0].outcome {
        CommandOutcome::Failed(error) => assert_eq!(
            error.message,
            "Failed to store color path 1: built-in color paths are read-only"
        ),
        other => panic!("Expected error result, got {:?}", other),
    }
}

/// Verifies color path labels can be updated without replacing path behavior.
#[test]
fn label_color_path_updates_existing_definition() {
    let mut app = setup_cue_crud_app();
    let color_path = ColorPath::new(101, "No Green", ColorInterpolationSpace::Hsv);
    let uid = color_path.identifiers.uid;
    app.world_mut()
        .resource_mut::<DataProvider<ColorPath>>()
        .add(color_path)
        .expect("color path should insert");

    app.world_mut()
        .write_message(cue_command_message(CueCommand::LabelColorPath {
            id: 101,
            label: "Better Amber".to_string(),
        }));
    app.update();

    let stored = app
        .world()
        .resource::<DataProvider<ColorPath>>()
        .from_id(101)
        .expect("color path should exist");
    assert_eq!(stored.identifiers.uid, uid);
    assert_eq!(stored.identifiers.label, "Better Amber");
    assert_eq!(stored.interpolation_space, ColorInterpolationSpace::Hsv);
}

/// Verifies built-in color path labels cannot be changed through cue CRUD commands.
#[test]
fn label_color_path_rejects_builtin_id() {
    let mut app = setup_cue_crud_app();
    let builtin = builtin_color_paths()
        .into_iter()
        .find(|path| path.identifiers.id == 2)
        .expect("hsv built-in path should exist");
    app.world_mut()
        .resource_mut::<DataProvider<ColorPath>>()
        .add(builtin.clone())
        .expect("built-in path should insert");

    app.world_mut()
        .write_message(cue_command_message(CueCommand::LabelColorPath {
            id: 2,
            label: "Mutable HSV".to_string(),
        }));
    app.update();

    let stored = app
        .world()
        .resource::<DataProvider<ColorPath>>()
        .from_id(2)
        .expect("built-in color path should remain")
        .clone();
    assert_eq!(stored, builtin);

    let results = drain_command_results(&mut app);
    assert_eq!(results.len(), 1);
    match &results[0].outcome {
        CommandOutcome::Failed(error) => assert_eq!(
            error.message,
            "Failed to label color path 2: built-in color paths are read-only"
        ),
        other => panic!("Expected error result, got {:?}", other),
    }
}

/// Verifies color path definitions can be duplicated through cue CRUD commands.
#[test]
fn duplicate_color_path_copies_definition_to_new_id() {
    let mut app = setup_cue_crud_app();
    let color_path = ColorPath::new(101, "No Green", ColorInterpolationSpace::Hsv);
    let source_uid = color_path.identifiers.uid;
    app.world_mut()
        .resource_mut::<DataProvider<ColorPath>>()
        .add(color_path)
        .expect("color path should insert");

    app.world_mut()
        .write_message(cue_command_message(CueCommand::DuplicateColorPath {
            id: 101,
            new_id: 202,
        }));
    app.update();

    let color_paths = app.world().resource::<DataProvider<ColorPath>>();
    let source = color_paths.from_id(101).expect("source path should exist");
    let duplicate = color_paths
        .from_id(202)
        .expect("duplicated path should exist");
    assert_eq!(source.identifiers.uid, source_uid);
    assert_ne!(duplicate.identifiers.uid, source_uid);
    assert_eq!(duplicate.identifiers.id, 202);
    assert_eq!(duplicate.identifiers.label, "No Green Copy");
    assert_eq!(duplicate.interpolation_space, source.interpolation_space);
    assert_eq!(duplicate.hue_direction, source.hue_direction);
    assert_eq!(duplicate.timing, source.timing);
    assert_eq!(duplicate.curve, source.curve);
}

/// Verifies duplicating a missing color path leaves the target ID unused.
#[test]
fn duplicate_color_path_rejects_missing_source() {
    let mut app = setup_cue_crud_app();

    app.world_mut()
        .write_message(cue_command_message(CueCommand::DuplicateColorPath {
            id: 101,
            new_id: 202,
        }));
    app.update();

    assert!(
        app.world()
            .resource::<DataProvider<ColorPath>>()
            .from_id(202)
            .is_err()
    );
}

/// Verifies duplicate commands cannot replace a built-in color path ID.
#[test]
fn duplicate_color_path_rejects_builtin_target_id() {
    let mut app = setup_cue_crud_app();
    let source = ColorPath::new(101, "No Green", ColorInterpolationSpace::Hsv);
    let builtin = builtin_color_paths()
        .into_iter()
        .find(|path| path.identifiers.id == 3)
        .expect("cmy built-in path should exist");
    {
        let mut color_paths = app.world_mut().resource_mut::<DataProvider<ColorPath>>();
        color_paths.add(source).expect("source path should insert");
        color_paths
            .add(builtin.clone())
            .expect("built-in path should insert");
    }

    app.world_mut()
        .write_message(cue_command_message(CueCommand::DuplicateColorPath {
            id: 101,
            new_id: 3,
        }));
    app.update();

    let stored = app
        .world()
        .resource::<DataProvider<ColorPath>>()
        .from_id(3)
        .expect("built-in color path should remain")
        .clone();
    assert_eq!(stored, builtin);

    let results = drain_command_results(&mut app);
    assert_eq!(results.len(), 1);
    match &results[0].outcome {
        CommandOutcome::Failed(error) => assert_eq!(
            error.message,
            "Failed to duplicate color path 101 to 3: built-in color paths are read-only"
        ),
        other => panic!("Expected error result, got {:?}", other),
    }
}

/// Verifies color path definitions can be listed through cue CRUD commands.
#[test]
fn list_color_paths_returns_sorted_message() {
    let mut app = setup_cue_crud_app();
    {
        let mut color_paths = app.world_mut().resource_mut::<DataProvider<ColorPath>>();
        color_paths
            .add(ColorPath::new(
                202,
                "Warm Route",
                ColorInterpolationSpace::Rgb,
            ))
            .expect("second path should insert");
        color_paths
            .add(ColorPath::new(
                101,
                "No Green",
                ColorInterpolationSpace::Hsv,
            ))
            .expect("first path should insert");
    }

    app.world_mut()
        .write_message(cue_command_message(CueCommand::ListColorPaths));
    app.update();

    let mut results = app.world_mut().resource_mut::<Messages<CommandResult>>();
    let messages = results.drain().collect::<Vec<_>>();
    assert_eq!(messages.len(), 1);
    match &messages[0].outcome {
        CommandOutcome::Succeeded {
            output: Some(CommandOutput { value }),
        } => assert_eq!(
            value,
            &serde_json::json!("Color Paths:\n101 No Green [Hsv]\n202 Warm Route [Rgb]")
        ),
        other => panic!("Expected message result, got {:?}", other),
    }
}

/// Verifies color path definitions can be deleted through cue CRUD commands.
#[test]
fn delete_color_path_removes_color_path_definition() {
    let mut app = setup_cue_crud_app();
    let color_path = ColorPath::new(101, "No Green", ColorInterpolationSpace::Hsv);
    app.world_mut()
        .resource_mut::<DataProvider<ColorPath>>()
        .add(color_path)
        .expect("color path should insert");

    app.world_mut()
        .write_message(cue_command_message(CueCommand::DeleteColorPath(101)));
    app.update();

    assert!(
        app.world()
            .resource::<DataProvider<ColorPath>>()
            .from_id(101)
            .is_err()
    );
}

/// Verifies deleting a color path clears cue assignments and fixture defaults.
#[test]
fn delete_color_path_clears_authored_references() {
    let mut app = setup_cue_crud_app();
    let fixture = FixtureRef {
        fixture_uid: Uuid::from_u128(0x1010),
        index: Some(1),
    };
    let cue_uid = Uuid::from_u128(0x2020);
    let mut cue = build_rgb_cue(1, cue_uid, "rgb cue", fixture.clone());
    cue.instructions[0].cue_instruction.color_path_id = Some(ColorPathId(101));
    cue.parts.push(CuePart {
        identifiers: Identifiers {
            id: 1,
            uid: Uuid::from_u128(0x3030),
            label: "part".to_string(),
        },
        instructions: vec![BoundCueInstruction {
            selection: SelectionExpr::Resolved(vec![fixture.clone()]).into(),
            cue_instruction: CueInstruction {
                blueprint_application: None,
                color_path_id: Some(ColorPathId(101)),
                ..Default::default()
            },
        }],
        ..Default::default()
    });

    app.world_mut()
        .resource_mut::<DataProvider<Cue>>()
        .add(cue)
        .expect("cue should insert");
    app.world_mut()
        .resource_mut::<DataProvider<ColorPath>>()
        .add(ColorPath::new(
            101,
            "No Green",
            ColorInterpolationSpace::Hsv,
        ))
        .expect("color path should insert");
    app.world_mut()
        .resource_mut::<FixtureDataProviderExt>()
        .set_color_path_default(fixture.clone(), Some(ColorPathId(101)));

    app.world_mut()
        .write_message(cue_command_message(CueCommand::DeleteColorPath(101)));
    app.update();

    let color_paths = app.world().resource::<DataProvider<ColorPath>>();
    assert!(color_paths.from_id(101).is_err());

    let cue = app
        .world()
        .resource::<DataProvider<Cue>>()
        .get(cue_uid)
        .expect("cue should remain stored");
    assert_eq!(cue.instructions[0].cue_instruction.color_path_id, None);
    assert_eq!(
        cue.parts[0].instructions[0].cue_instruction.color_path_id,
        None
    );
    assert_eq!(
        app.world()
            .resource::<FixtureDataProviderExt>()
            .color_path_default_for_element(&fixture),
        None
    );
}

/// Verifies built-in color path definitions cannot be removed through cue CRUD commands.
#[test]
fn delete_color_path_rejects_builtin_id() {
    let mut app = setup_cue_crud_app();
    let builtin = builtin_color_paths()
        .into_iter()
        .find(|path| path.identifiers.id == 3)
        .expect("cmy built-in path should exist");
    app.world_mut()
        .resource_mut::<DataProvider<ColorPath>>()
        .add(builtin.clone())
        .expect("built-in path should insert");

    app.world_mut()
        .write_message(cue_command_message(CueCommand::DeleteColorPath(3)));
    app.update();

    let stored = app
        .world()
        .resource::<DataProvider<ColorPath>>()
        .from_id(3)
        .expect("built-in color path should remain")
        .clone();
    assert_eq!(stored, builtin);

    let results = drain_command_results(&mut app);
    assert_eq!(results.len(), 1);
    match &results[0].outcome {
        CommandOutcome::Failed(error) => assert_eq!(
            error.message,
            "Failed to delete color path 3: built-in color paths are read-only"
        ),
        other => panic!("Expected error result, got {:?}", other),
    }
}

#[test]
fn delete_cue_removes_target_cue_and_updates_parent_sequence_steps() {
    let mut app = App::new();
    app.add_message::<CommandEnvelope<CueCommand>>();
    init_cue_runtime_resources(&mut app);
    app.add_systems(Update, (register_cue_commands, cue_crud_events).chain());

    let cue_uid_seq1 = Uuid::new_v4();
    let cue_uid_seq2 = Uuid::new_v4();
    let seq_uid_1 = Uuid::new_v4();
    let seq_uid_2 = Uuid::new_v4();

    {
        let mut cue_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_provider
            .add(build_cue(1, cue_uid_seq1, "seq1-cue-1"))
            .expect("store sequence 1 cue");
        cue_provider
            .add(build_cue(1, cue_uid_seq2, "seq2-cue-1"))
            .expect("store sequence 2 cue");
    }

    {
        let mut sequence_provider = app.world_mut().resource_mut::<DataProvider<Sequence>>();
        sequence_provider
            .add(build_sequence(
                1,
                seq_uid_1,
                "sequence-1",
                vec![cue_uid_seq1],
            ))
            .expect("store sequence-1");
        sequence_provider
            .add(build_sequence(
                2,
                seq_uid_2,
                "sequence-2",
                vec![cue_uid_seq2],
            ))
            .expect("store sequence-2");
    }

    app.world_mut()
        .write_message(cue_command_message(CueCommand::DeleteCue {
            sequence_id: 1,
            cue_id: 1,
        }));
    app.update();

    let results = drain_command_results(&mut app);
    assert_eq!(results.len(), 1, "delete should emit one terminal result");
    assert_eq!(results[0].outcome, CommandOutcome::succeeded());

    let cue_changes = drain_cue_definition_changes(&mut app);
    assert_eq!(cue_changes.len(), 1);
    match &cue_changes[0] {
        CueDefinitionChange::Removed { uid } => assert_eq!(
            *uid, cue_uid_seq1,
            "delete should emit a cue definition removal for the target cue"
        ),
        other => panic!("Expected cue removal change, got {:?}", other),
    }

    let sequence_changes = drain_sequence_definition_changes(&mut app);
    assert_eq!(sequence_changes.len(), 1);
    match &sequence_changes[0] {
        SequenceDefinitionChange::Updated(sequence) => {
            assert_eq!(
                sequence.identifiers.uid, seq_uid_1,
                "delete should emit an update for the parent sequence"
            );
            assert!(
                sequence.steps.is_empty(),
                "parent sequence update should omit the deleted cue"
            );
        }
        other => panic!("Expected parent sequence update, got {:?}", other),
    }

    {
        let cue_provider = app.world().resource::<DataProvider<Cue>>();
        assert!(
            cue_provider.get(cue_uid_seq1).is_err(),
            "deleted cue should no longer exist in cue data provider"
        );
        assert!(
            cue_provider.get(cue_uid_seq2).is_ok(),
            "cue with same id in another sequence must remain untouched"
        );
    }

    {
        let sequence_provider = app.world().resource::<DataProvider<Sequence>>();
        let sequence_1 = sequence_provider
            .from_id(1)
            .expect("sequence 1 should still exist after cue delete");
        let sequence_1_steps: Vec<Uuid> = sequence_1
            .steps
            .iter()
            .map(|step_uid| (*step_uid).into())
            .collect();
        assert!(
            sequence_1_steps.is_empty(),
            "deleted cue UID should be removed from parent sequence steps"
        );

        let sequence_2 = sequence_provider
            .from_id(2)
            .expect("sequence 2 should still exist after cue delete");
        let sequence_2_steps: Vec<Uuid> = sequence_2
            .steps
            .iter()
            .map(|step_uid| (*step_uid).into())
            .collect();
        assert_eq!(
            sequence_2_steps,
            vec![cue_uid_seq2],
            "non-target sequence steps should not be modified"
        );
    }
}

#[test]
fn rename_cue_within_same_sequence_updates_cue_id_and_keeps_steps() {
    let mut app = App::new();
    app.add_message::<CommandEnvelope<CueCommand>>();
    init_cue_runtime_resources(&mut app);
    app.add_systems(Update, (register_cue_commands, cue_crud_events).chain());

    let cue_uid = Uuid::new_v4();
    let seq_uid = Uuid::new_v4();

    {
        let mut cue_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_provider
            .add(build_cue(1, cue_uid, "cue-1"))
            .expect("store cue");
    }

    {
        let mut sequence_provider = app.world_mut().resource_mut::<DataProvider<Sequence>>();
        sequence_provider
            .add(build_sequence(1, seq_uid, "sequence-1", vec![cue_uid]))
            .expect("store sequence");
    }

    app.world_mut()
        .write_message(cue_command_message(CueCommand::RenameCue {
            sequence_id: 1,
            cue_id: 1,
            new_sequence_id: 1,
            new_cue_id: 5,
        }));
    app.update();

    let results = drain_command_results(&mut app);
    assert_eq!(results.len(), 1, "rename should emit one terminal result");
    assert_eq!(results[0].outcome, CommandOutcome::succeeded());

    {
        let cue_provider = app.world().resource::<DataProvider<Cue>>();
        let cue = cue_provider.get(cue_uid).expect("cue should still exist");
        assert_eq!(
            cue.identifiers.id, 5,
            "cue id should be updated after rename"
        );
    }

    {
        let sequence_provider = app.world().resource::<DataProvider<Sequence>>();
        let sequence = sequence_provider
            .from_id(1)
            .expect("sequence should still exist after cue rename");
        let steps: Vec<Uuid> = sequence
            .steps
            .iter()
            .map(|step_uid| (*step_uid).into())
            .collect();
        assert_eq!(
            steps,
            vec![cue_uid],
            "same-sequence cue rename should preserve sequence steps"
        );
    }
}

#[test]
fn rename_cue_to_new_sequence_moves_step_and_updates_target_id() {
    let mut app = App::new();
    app.add_message::<CommandEnvelope<CueCommand>>();
    init_cue_runtime_resources(&mut app);
    app.add_systems(Update, (register_cue_commands, cue_crud_events).chain());

    let moved_cue_uid = Uuid::new_v4();
    let existing_target_cue_uid = Uuid::new_v4();
    let seq_uid_1 = Uuid::new_v4();
    let seq_uid_2 = Uuid::new_v4();

    {
        let mut cue_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_provider
            .add(build_cue(1, moved_cue_uid, "source-cue"))
            .expect("store source cue");
        cue_provider
            .add(build_cue(3, existing_target_cue_uid, "target-cue"))
            .expect("store existing target cue");
    }

    {
        let mut sequence_provider = app.world_mut().resource_mut::<DataProvider<Sequence>>();
        sequence_provider
            .add(build_sequence(
                1,
                seq_uid_1,
                "sequence-1",
                vec![moved_cue_uid],
            ))
            .expect("store sequence-1");
        sequence_provider
            .add(build_sequence(
                2,
                seq_uid_2,
                "sequence-2",
                vec![existing_target_cue_uid],
            ))
            .expect("store sequence-2");
    }

    app.world_mut()
        .write_message(cue_command_message(CueCommand::RenameCue {
            sequence_id: 1,
            cue_id: 1,
            new_sequence_id: 2,
            new_cue_id: 5,
        }));
    app.update();

    let results = drain_command_results(&mut app);
    assert_eq!(results.len(), 1, "rename should emit one terminal result");
    assert_eq!(results[0].outcome, CommandOutcome::succeeded());

    {
        let cue_provider = app.world().resource::<DataProvider<Cue>>();
        let moved_cue = cue_provider
            .get(moved_cue_uid)
            .expect("moved cue should still exist");
        assert_eq!(
            moved_cue.identifiers.id, 5,
            "moved cue should be assigned its new cue id"
        );
        assert!(
            cue_provider.get(existing_target_cue_uid).is_ok(),
            "existing target sequence cues should remain intact"
        );
    }

    {
        let sequence_provider = app.world().resource::<DataProvider<Sequence>>();
        let source_sequence = sequence_provider
            .from_id(1)
            .expect("source sequence should still exist");
        let source_steps: Vec<Uuid> = source_sequence
            .steps
            .iter()
            .map(|step_uid| (*step_uid).into())
            .collect();
        assert!(
            source_steps.is_empty(),
            "source sequence should no longer reference moved cue"
        );

        let target_sequence = sequence_provider
            .from_id(2)
            .expect("target sequence should still exist");
        let target_steps: Vec<Uuid> = target_sequence
            .steps
            .iter()
            .map(|step_uid| (*step_uid).into())
            .collect();
        assert_eq!(
            target_steps,
            vec![existing_target_cue_uid, moved_cue_uid],
            "target sequence should retain existing steps and append moved cue"
        );
    }
}

#[test]
fn cue_action_store_cue_persists_cue_data() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<CueAction>>();
    init_cue_runtime_resources(&mut app);
    app.add_systems(Update, cue_action_events);

    let cue_uid = Uuid::new_v4();
    let cue = build_cue(7, cue_uid, "action-cue");

    app.world_mut()
        .write_message(EngineActionEnvelope::detached(CueAction::StoreCue(
            Box::new(cue.clone()),
        )));
    app.update();

    let cue_changes = drain_cue_definition_changes(&mut app);
    assert_eq!(cue_changes.len(), 1);
    match &cue_changes[0] {
        CueDefinitionChange::Updated(changed) => assert_eq!(
            changed.identifiers.uid, cue_uid,
            "store cue action should emit a committed cue definition update"
        ),
        other => panic!("Expected cue update change, got {:?}", other),
    }

    let cue_provider = app.world().resource::<DataProvider<Cue>>();
    let stored = cue_provider.get(cue_uid).expect("cue should be stored");
    assert_eq!(
        stored.identifiers.id, 7,
        "cue action should store cue definitions directly"
    );
}

#[test]
fn cue_action_store_sequence_persists_sequence_data() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<CueAction>>();
    init_cue_runtime_resources(&mut app);
    app.add_systems(Update, cue_action_events);

    let sequence_uid = Uuid::new_v4();
    let sequence = build_sequence(11, sequence_uid, "action-sequence", Vec::new());

    app.world_mut()
        .write_message(EngineActionEnvelope::detached(CueAction::StoreSequence(
            Box::new(sequence.clone()),
        )));
    app.update();

    let sequence_provider = app.world().resource::<DataProvider<Sequence>>();
    let stored = sequence_provider
        .from_id(11)
        .expect("sequence should be stored");
    assert_eq!(
        stored.identifiers.uid, sequence_uid,
        "cue action should store sequence definitions directly"
    );
}

/// Verifies cue definition action replays satisfy every delegated command completion.
#[test]
fn cue_definition_actions_finish_joined_command_lifecycle() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<CueAction>>();
    init_cue_runtime_resources(&mut app);
    app.add_systems(Update, cue_action_events);

    let command_id = CommandId::new();
    let undo_id = UndoId::from(command_id);
    app.world_mut()
        .resource_mut::<CommandTracker>()
        .register_context(
            command_id,
            undo_id,
            CommandOrigin::WebUi,
            ReplyTarget::Detached,
        )
        .expect("replay command should register");
    app.world_mut()
        .resource_mut::<CommandTracker>()
        .expect_completions(command_id, 2)
        .expect("replay command should join both definition actions");
    app.world_mut()
        .write_message(EngineActionEnvelope::for_command_context(
            command_id,
            undo_id,
            CueAction::StoreCue(Box::new(build_cue(7, Uuid::new_v4(), "action-cue"))),
        ));
    app.world_mut()
        .write_message(EngineActionEnvelope::for_command_context(
            command_id,
            undo_id,
            CueAction::StoreSequence(Box::new(build_sequence(
                11,
                Uuid::new_v4(),
                "action-sequence",
                Vec::new(),
            ))),
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

/// Verifies a rejected sequence definition replay terminates its owning command with failure.
#[test]
fn sequence_definition_action_failure_finishes_command_lifecycle() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<CueAction>>();
    init_cue_runtime_resources(&mut app);
    app.add_systems(Update, cue_action_events);

    app.world_mut()
        .resource_mut::<DataProvider<Sequence>>()
        .add(build_sequence(
            11,
            Uuid::new_v4(),
            "existing-sequence",
            Vec::new(),
        ))
        .expect("existing sequence should store");
    let command_id = CommandId::new();
    let undo_id = UndoId::from(command_id);
    app.world_mut()
        .resource_mut::<CommandTracker>()
        .register_context(
            command_id,
            undo_id,
            CommandOrigin::WebUi,
            ReplyTarget::Detached,
        )
        .expect("replay command should register");
    app.world_mut()
        .resource_mut::<CommandTracker>()
        .expect_completions(command_id, 1)
        .expect("replay command should join its definition action");
    app.world_mut()
        .write_message(EngineActionEnvelope::for_command_context(
            command_id,
            undo_id,
            CueAction::StoreSequence(Box::new(build_sequence(
                11,
                Uuid::new_v4(),
                "conflicting-sequence",
                Vec::new(),
            ))),
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
            outcome: CommandOutcome::Failed(error),
        }] if *result_command_id == command_id && error.code == "cues.command_failed"
    ));
}

/// Verifies same-drain cue appends allocate distinct IDs and record one undo entry each.
#[test]
fn cue_action_store_cue_in_sequence_resolves_next_ids_while_mutating() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<CueAction>>();
    init_cue_runtime_resources(&mut app);
    app.add_systems(Update, cue_action_events);

    let existing_cue_uid = Uuid::new_v4();
    let sequence_uid = Uuid::new_v4();
    {
        let mut cue_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_provider
            .add(build_cue(1, existing_cue_uid, "existing"))
            .expect("existing cue should store");
    }
    {
        let mut sequence_provider = app.world_mut().resource_mut::<DataProvider<Sequence>>();
        sequence_provider
            .add(build_sequence(
                10,
                sequence_uid,
                "sequence",
                vec![existing_cue_uid],
            ))
            .expect("sequence should store");
    }

    let batch_one = Uuid::new_v4();
    let batch_two = Uuid::new_v4();
    app.world_mut()
        .write_message(EngineActionEnvelope::with_context(
            OperationId::new(),
            None,
            Some(UndoId::from(batch_one)),
            CueAction::StoreCueInSequence {
                sequence_id: 10,
                cue_id: CueStoreTarget::Next,
                part_id: CuePartStoreTarget::Exact(0),
                part: Box::new(CuePart::default()),
                undo_label: "store cue 10.".to_string(),
            },
        ));
    app.world_mut()
        .write_message(EngineActionEnvelope::with_context(
            OperationId::new(),
            None,
            Some(UndoId::from(batch_two)),
            CueAction::StoreCueInSequence {
                sequence_id: 10,
                cue_id: CueStoreTarget::Next,
                part_id: CuePartStoreTarget::Exact(0),
                part: Box::new(CuePart::default()),
                undo_label: "store cue 10.".to_string(),
            },
        ));

    app.update();

    let cue_provider = app.world().resource::<DataProvider<Cue>>();
    let first_append_uid = cue_provider
        .from_id(2)
        .expect("first append cue should store")
        .identifiers
        .uid;
    let second_append_uid = cue_provider
        .from_id(3)
        .expect("second append cue should store")
        .identifiers
        .uid;
    {
        let sequence_provider = app.world().resource::<DataProvider<Sequence>>();
        let sequence = sequence_provider
            .from_id(10)
            .expect("sequence should remain stored");
        let steps: Vec<Uuid> = sequence.steps.iter().map(|step| (*step).into()).collect();
        assert_eq!(
            steps,
            vec![existing_cue_uid, first_append_uid, second_append_uid]
        );
    }

    let mut undo_manager = app.world_mut().resource_mut::<UndoManager>();
    undo_manager.finalize_detached_groups();
    let undo_group = undo_manager.peek_undo().expect("append should record undo");
    assert_eq!(undo_group.description, "store cue 10.");
    assert_eq!(undo_group.entries.len(), 1);
}

/// Verifies restoring a cue store snapshot removes a newly-created cue without sequence lookup failures.
#[test]
fn cue_action_restore_cue_store_state_removes_new_cue_and_restores_sequence() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<CueAction>>();
    init_cue_runtime_resources(&mut app);
    app.add_systems(Update, cue_action_events);

    let existing_cue_uid = Uuid::new_v4();
    let appended_cue_uid = Uuid::new_v4();
    let sequence_uid = Uuid::new_v4();
    let previous_sequence = build_sequence(10, sequence_uid, "sequence", vec![existing_cue_uid]);
    {
        let mut cue_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_provider
            .add(build_cue(1, existing_cue_uid, "existing"))
            .expect("existing cue should store");
        cue_provider
            .add(build_cue(2, appended_cue_uid, "appended"))
            .expect("appended cue should store");
    }
    {
        let mut sequence_provider = app.world_mut().resource_mut::<DataProvider<Sequence>>();
        sequence_provider
            .add(build_sequence(
                10,
                sequence_uid,
                "sequence",
                vec![existing_cue_uid, appended_cue_uid],
            ))
            .expect("mutated sequence should store");
    }

    app.world_mut()
        .write_message(EngineActionEnvelope::detached(
            CueAction::RestoreCueStoreState {
                sequence_id: 10,
                cue_uid: appended_cue_uid,
                previous_cue: None,
                previous_sequence: Some(Box::new(previous_sequence)),
                undo_label: "store cue 10.".to_string(),
            },
        ));

    app.update();

    let cue_provider = app.world().resource::<DataProvider<Cue>>();
    assert!(
        cue_provider.get(appended_cue_uid).is_err(),
        "restore should remove the appended cue by UID"
    );
    let sequence_provider = app.world().resource::<DataProvider<Sequence>>();
    let sequence = sequence_provider
        .from_id(10)
        .expect("sequence should be restored");
    let steps: Vec<Uuid> = sequence.steps.iter().map(|step| (*step).into()).collect();
    assert_eq!(steps, vec![existing_cue_uid]);
}

/// Verifies same-drain cue-part appends allocate distinct part IDs.
#[test]
fn cue_action_store_cue_part_in_sequence_resolves_next_ids_while_mutating() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<CueAction>>();
    init_cue_runtime_resources(&mut app);
    app.add_systems(Update, cue_action_events);

    let cue_uid = Uuid::new_v4();
    let sequence_uid = Uuid::new_v4();
    {
        let mut cue_provider = app.world_mut().resource_mut::<DataProvider<Cue>>();
        cue_provider
            .add(build_cue(1, cue_uid, "cue"))
            .expect("cue should store");
    }
    {
        let mut sequence_provider = app.world_mut().resource_mut::<DataProvider<Sequence>>();
        sequence_provider
            .add(build_sequence(10, sequence_uid, "sequence", vec![cue_uid]))
            .expect("sequence should store");
    }

    app.world_mut()
        .write_message(EngineActionEnvelope::detached(
            CueAction::StoreCueInSequence {
                sequence_id: 10,
                cue_id: CueStoreTarget::Exact(1),
                part_id: CuePartStoreTarget::Next,
                part: Box::new(CuePart::default()),
                undo_label: "store cue 10.1p".to_string(),
            },
        ));
    app.world_mut()
        .write_message(EngineActionEnvelope::detached(
            CueAction::StoreCueInSequence {
                sequence_id: 10,
                cue_id: CueStoreTarget::Exact(1),
                part_id: CuePartStoreTarget::Next,
                part: Box::new(CuePart::default()),
                undo_label: "store cue 10.1p".to_string(),
            },
        ));

    app.update();

    let cue_provider = app.world().resource::<DataProvider<Cue>>();
    let cue = cue_provider.get(cue_uid).expect("cue should remain stored");
    let part_ids: Vec<u32> = cue.parts.iter().map(|part| part.identifiers.id).collect();
    assert_eq!(part_ids, vec![1, 2]);
}

/// Verifies p0 cue-part stores create/update the parent cue without storing a real cue part.
#[test]
fn cue_action_store_cue_part_zero_updates_parent_cue() {
    let mut app = App::new();
    app.add_message::<EngineActionEnvelope<CueAction>>();
    init_cue_runtime_resources(&mut app);
    app.add_systems(Update, cue_action_events);

    let sequence_uid = Uuid::new_v4();
    {
        let mut sequence_provider = app.world_mut().resource_mut::<DataProvider<Sequence>>();
        sequence_provider
            .add(build_sequence(10, sequence_uid, "sequence", Vec::new()))
            .expect("sequence should store");
    }

    let mut stored_part_zero = CuePart::default();
    stored_part_zero.identifiers.id = 0;
    stored_part_zero.identifiers.label = "Part 0".to_string();
    app.world_mut()
        .write_message(EngineActionEnvelope::detached(
            CueAction::StoreCueInSequence {
                sequence_id: 10,
                cue_id: CueStoreTarget::Exact(1),
                part_id: CuePartStoreTarget::Exact(0),
                part: Box::new(stored_part_zero),
                undo_label: "store cue 10.1p0".to_string(),
            },
        ));

    app.update();

    let cue_provider = app.world().resource::<DataProvider<Cue>>();
    let cue = cue_provider
        .from_id(1)
        .expect("parent cue should be stored");
    assert_eq!(cue.identifiers.label, "Part 0");
    assert!(
        cue.parts.is_empty(),
        "p0 must not persist as a real cue part"
    );
    let sequence_provider = app.world().resource::<DataProvider<Sequence>>();
    let sequence = sequence_provider
        .from_id(10)
        .expect("sequence should remain stored");
    assert_eq!(sequence.steps, vec![cue.identifiers.uid.into()]);
}

/// Verifies block cue stores assertions for values tracked into a cue part.
#[test]
fn block_cue_part_asserts_values_tracked_into_target() {
    let mut app = setup_cue_crud_app();
    let fixture = fixture_ref(1);
    let cue_one = cue_with_instructions(
        1,
        vec![bound_instruction(fixture.clone(), Attribute::Red, 10.0)],
        Vec::new(),
    );
    let cue_two = cue_with_instructions(2, Vec::new(), vec![part_with_instructions(3, Vec::new())]);
    insert_sequence(&mut app, 5, &[cue_one, cue_two]);

    let actions = run_cue_command(
        &mut app,
        CueCommand::BlockCue {
            sequence_id: 5,
            cue_id: 2,
            part_id: Some(3),
            overwrite: false,
        },
    );

    let cue = stored_cue(&actions);
    let part = cue.part_by_id(3).expect("part should be stored");
    let instruction = instruction_for_fixture(&part.instructions, &fixture);
    assert_eq!(
        instruction.cue_instruction.values.get(&Attribute::Red),
        Some(&ValueSource::Inline(ParameterValue::Absolute {
            value: 10.0
        }))
    );
}

/// Verifies block planning captures the current definition behind tracked Blueprint references.
#[test]
fn block_cue_tracks_edited_blueprint_values() {
    let mut app = setup_cue_crud_app();
    let fixture = fixture_ref(1);
    let blueprint_uid = Uuid::from_u128(7001);
    let make_blueprint = |value| Blueprint {
        identifiers: Identifiers {
            id: 5,
            uid: blueprint_uid,
            label: "Tracked Red".to_owned(),
        },
        values: HashMap::from([(
            Attribute::Red,
            ValueSource::Inline(ParameterValue::Absolute { value }),
        )]),
        ..Default::default()
    };
    app.world_mut()
        .resource_mut::<DataProvider<Blueprint>>()
        .add(make_blueprint(10.0))
        .expect("Blueprint should insert");

    let cue_one = cue_with_instructions(
        1,
        vec![referenced_blueprint_instruction(
            fixture.clone(),
            blueprint_uid,
            BlueprintSelector::Attribute(Attribute::Red),
        )],
        Vec::new(),
    );
    let cue_two = cue_with_instructions(2, Vec::new(), Vec::new());
    insert_sequence(&mut app, 5, &[cue_one, cue_two.clone()]);

    let first_actions = run_cue_command(
        &mut app,
        CueCommand::BlockCue {
            sequence_id: 5,
            cue_id: 2,
            part_id: None,
            overwrite: false,
        },
    );
    let first_block = stored_cue(&first_actions);
    assert_eq!(
        instruction_for_fixture(&first_block.instructions, &fixture)
            .cue_instruction
            .values
            .get(&Attribute::Red),
        Some(&ValueSource::Inline(ParameterValue::Absolute {
            value: 10.0
        }))
    );

    app.world_mut()
        .resource_mut::<DataProvider<Blueprint>>()
        .add(make_blueprint(80.0))
        .expect("Blueprint should update");
    app.world_mut()
        .resource_mut::<DataProvider<Cue>>()
        .add(cue_two)
        .expect("empty block target should restore");

    let edited_actions = run_cue_command(
        &mut app,
        CueCommand::BlockCue {
            sequence_id: 5,
            cue_id: 2,
            part_id: None,
            overwrite: false,
        },
    );
    let edited_block = stored_cue(&edited_actions);
    assert_eq!(
        instruction_for_fixture(&edited_block.instructions, &fixture)
            .cue_instruction
            .values
            .get(&Attribute::Red),
        Some(&ValueSource::Inline(ParameterValue::Absolute {
            value: 80.0
        }))
    );
}

/// Verifies block cue parts intentionally track only up to the parent cue boundary.
#[test]
fn block_cue_part_ignores_parent_cue_assertions() {
    let mut app = setup_cue_crud_app();
    let fixture = fixture_ref(1);
    let cue_one = cue_with_instructions(
        1,
        vec![bound_instruction(fixture.clone(), Attribute::Red, 10.0)],
        Vec::new(),
    );
    let cue_two = cue_with_instructions(
        2,
        vec![bound_instruction(fixture.clone(), Attribute::Red, 75.0)],
        vec![part_with_instructions(3, Vec::new())],
    );
    insert_sequence(&mut app, 5, &[cue_one, cue_two]);

    let actions = run_cue_command(
        &mut app,
        CueCommand::BlockCue {
            sequence_id: 5,
            cue_id: 2,
            part_id: Some(3),
            overwrite: false,
        },
    );

    let cue = stored_cue(&actions);
    let part = cue.part_by_id(3).expect("part should be stored");
    let instruction = instruction_for_fixture(&part.instructions, &fixture);
    assert_eq!(
        instruction.cue_instruction.values.get(&Attribute::Red),
        Some(&ValueSource::Inline(ParameterValue::Absolute {
            value: 10.0
        })),
        "block cue part should capture the value tracked into the parent cue, not the parent cue's own assertion"
    );
}

/// Verifies block cue preserves explicit target values unless overwrite is requested.
#[test]
fn block_cue_preserves_existing_assertions_without_overwrite() {
    let mut app = setup_cue_crud_app();
    let fixture = fixture_ref(1);
    let cue_one = cue_with_instructions(
        1,
        vec![bound_instruction(fixture.clone(), Attribute::Red, 10.0)],
        Vec::new(),
    );
    let cue_two = cue_with_instructions(
        2,
        vec![bound_instruction(fixture.clone(), Attribute::Red, 75.0)],
        Vec::new(),
    );
    insert_sequence(&mut app, 5, &[cue_one, cue_two]);

    let actions = run_cue_command(
        &mut app,
        CueCommand::BlockCue {
            sequence_id: 5,
            cue_id: 2,
            part_id: None,
            overwrite: false,
        },
    );

    let cue = stored_cue(&actions);
    let instruction = instruction_for_fixture(&cue.instructions, &fixture);
    assert_eq!(
        instruction.cue_instruction.values.get(&Attribute::Red),
        Some(&ValueSource::Inline(ParameterValue::Absolute {
            value: 75.0
        }))
    );
}

/// Verifies the overwrite flag preserves the original block-cue replacement behavior.
#[test]
fn block_cue_overwrite_replaces_existing_assertions() {
    let mut app = setup_cue_crud_app();
    let fixture = fixture_ref(1);
    let cue_one = cue_with_instructions(
        1,
        vec![bound_instruction(fixture.clone(), Attribute::Red, 10.0)],
        Vec::new(),
    );
    let cue_two = cue_with_instructions(
        2,
        vec![bound_instruction(fixture.clone(), Attribute::Red, 75.0)],
        Vec::new(),
    );
    insert_sequence(&mut app, 5, &[cue_one, cue_two]);

    let actions = run_cue_command(
        &mut app,
        CueCommand::BlockCue {
            sequence_id: 5,
            cue_id: 2,
            part_id: None,
            overwrite: true,
        },
    );

    let cue = stored_cue(&actions);
    let instruction = instruction_for_fixture(&cue.instructions, &fixture);
    assert_eq!(
        instruction.cue_instruction.values.get(&Attribute::Red),
        Some(&ValueSource::Inline(ParameterValue::Absolute {
            value: 10.0
        }))
    );
}

/// Verifies block cue collapses identical tracked element values into one fixture row.
#[test]
fn block_cue_collapses_identical_complete_fixture_element_rows() {
    let mut app = setup_cue_crud_app();
    insert_multi_element_fixtures(&mut app, [323], 4);
    let fixture = whole_fixture_ref(323);
    let cue_one = cue_with_instructions(
        1,
        vec![bound_instruction(fixture.clone(), Attribute::Red, 10.0)],
        Vec::new(),
    );
    let cue_two = cue_with_instructions(2, Vec::new(), Vec::new());
    insert_sequence(&mut app, 5, &[cue_one, cue_two]);

    let actions = run_cue_command(
        &mut app,
        CueCommand::BlockCue {
            sequence_id: 5,
            cue_id: 2,
            part_id: None,
            overwrite: false,
        },
    );

    let cue = stored_cue(&actions);
    assert_eq!(cue.instructions.len(), 1);
    let instruction = instruction_for_fixture(&cue.instructions, &fixture);
    assert_eq!(
        instruction.cue_instruction.values.get(&Attribute::Red),
        Some(&ValueSource::Inline(ParameterValue::Absolute {
            value: 10.0
        }))
    );
}

/// Verifies block cue keeps per-element rows when tracked values differ.
#[test]
fn block_cue_preserves_different_element_values() {
    let mut app = setup_cue_crud_app();
    insert_multi_element_fixtures(&mut app, [323], 2);
    let first_element = element_fixture_ref(323, 1);
    let second_element = element_fixture_ref(323, 2);
    let cue_one = cue_with_instructions(
        1,
        vec![
            bound_instruction(first_element.clone(), Attribute::Red, 10.0),
            bound_instruction(second_element.clone(), Attribute::Red, 20.0),
        ],
        Vec::new(),
    );
    let cue_two = cue_with_instructions(2, Vec::new(), Vec::new());
    insert_sequence(&mut app, 5, &[cue_one, cue_two]);

    let actions = run_cue_command(
        &mut app,
        CueCommand::BlockCue {
            sequence_id: 5,
            cue_id: 2,
            part_id: None,
            overwrite: false,
        },
    );

    let cue = stored_cue(&actions);
    assert_eq!(cue.instructions.len(), 2);
    assert_eq!(
        instruction_for_fixture(&cue.instructions, &first_element)
            .cue_instruction
            .values
            .get(&Attribute::Red),
        Some(&ValueSource::Inline(ParameterValue::Absolute {
            value: 10.0
        }))
    );
    assert_eq!(
        instruction_for_fixture(&cue.instructions, &second_element)
            .cue_instruction
            .values
            .get(&Attribute::Red),
        Some(&ValueSource::Inline(ParameterValue::Absolute {
            value: 20.0
        }))
    );
}

/// Verifies block cue setup does not treat setup values as values tracked into itself.
#[test]
fn block_setup_cue_does_not_assert_its_own_values() {
    let mut app = setup_cue_crud_app();
    let fixture = fixture_ref(1);
    let mut sequence = Sequence {
        identifiers: Identifiers {
            id: 5,
            uid: Uuid::new_v4(),
            label: "Sequence 5".to_string(),
        },
        ..Default::default()
    };
    sequence.setup_cue = cue_with_instructions(
        0,
        vec![bound_instruction(fixture, Attribute::Red, 10.0)],
        Vec::new(),
    );
    app.world_mut()
        .resource_mut::<DataProvider<Sequence>>()
        .add(sequence)
        .expect("sequence should insert");

    let actions = run_cue_command(
        &mut app,
        CueCommand::BlockCue {
            sequence_id: 5,
            cue_id: 0,
            part_id: None,
            overwrite: false,
        },
    );

    let CueAction::StoreSequence(sequence) = actions
        .iter()
        .find(|action| matches!(action, CueAction::StoreSequence(_)))
        .expect("setup block should store the containing sequence")
    else {
        panic!("expected sequence store action");
    };
    assert_eq!(sequence.setup_cue.instructions.len(), 1);
    assert_eq!(
        sequence.setup_cue.instructions[0]
            .cue_instruction
            .values
            .get(&Attribute::Red),
        Some(&ValueSource::Inline(ParameterValue::Absolute {
            value: 10.0
        }))
    );
}

/// Verifies unblock cue removes only assertions that match current tracked-in values.
#[test]
fn unblock_cue_removes_only_matching_tracked_assertions() {
    let mut app = setup_cue_crud_app();
    let fixture = fixture_ref(1);
    let cue_one = cue_with_instructions(
        1,
        vec![bound_instruction(fixture.clone(), Attribute::Red, 10.0)],
        Vec::new(),
    );
    let cue_two = cue_with_instructions(
        2,
        vec![BoundCueInstruction {
            selection: SelectionExpr::Resolved(vec![fixture.clone()]).into(),
            cue_instruction: assertion_instruction([
                (
                    Attribute::Red,
                    ValueSource::Inline(ParameterValue::Absolute { value: 10.0 }),
                ),
                (
                    Attribute::Green,
                    ValueSource::Inline(ParameterValue::Absolute { value: 20.0 }),
                ),
            ]),
        }],
        Vec::new(),
    );
    insert_sequence(&mut app, 5, &[cue_one, cue_two]);

    let actions = run_cue_command(
        &mut app,
        CueCommand::UnblockCue {
            sequence_id: 5,
            cue_id: 2,
            part_id: None,
        },
    );

    let cue = stored_cue(&actions);
    let instruction = instruction_for_fixture(&cue.instructions, &fixture);
    assert_eq!(
        instruction.cue_instruction.values.get(&Attribute::Red),
        None
    );
    assert_eq!(
        instruction.cue_instruction.values.get(&Attribute::Green),
        Some(&ValueSource::Inline(ParameterValue::Absolute {
            value: 20.0
        }))
    );
}

/// Verifies unblock cue removes collapsed whole-fixture assertions matching tracked element values.
#[test]
fn unblock_cue_removes_collapsed_assertions_matching_tracked_elements() {
    let mut app = setup_cue_crud_app();
    insert_multi_element_fixtures(&mut app, [323], 4);
    let fixture = whole_fixture_ref(323);
    let element_instructions = (1..=4)
        .map(|index| bound_instruction(element_fixture_ref(323, index), Attribute::Red, 10.0))
        .collect::<Vec<_>>();
    let cue_one = cue_with_instructions(1, element_instructions, Vec::new());
    let cue_two = cue_with_instructions(
        2,
        vec![BoundCueInstruction {
            selection: SelectionExpr::Resolved(vec![fixture.clone()]).into(),
            cue_instruction: assertion_instruction([
                (
                    Attribute::Red,
                    ValueSource::Inline(ParameterValue::Absolute { value: 10.0 }),
                ),
                (
                    Attribute::Green,
                    ValueSource::Inline(ParameterValue::Absolute { value: 20.0 }),
                ),
            ]),
        }],
        Vec::new(),
    );
    insert_sequence(&mut app, 5, &[cue_one, cue_two]);

    let actions = run_cue_command(
        &mut app,
        CueCommand::UnblockCue {
            sequence_id: 5,
            cue_id: 2,
            part_id: None,
        },
    );

    let cue = stored_cue(&actions);
    let instruction = instruction_for_fixture(&cue.instructions, &fixture);
    assert_eq!(
        instruction.cue_instruction.values.get(&Attribute::Red),
        None
    );
    assert_eq!(
        instruction.cue_instruction.values.get(&Attribute::Green),
        Some(&ValueSource::Inline(ParameterValue::Absolute {
            value: 20.0
        }))
    );
}
