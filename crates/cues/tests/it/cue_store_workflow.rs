// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use bevy_app::{App, Update};
use bevy_ecs::prelude::Messages;
use bevy_ecs::schedule::IntoScheduleConfigs;
use nightfall::prelude::{Group, HasIdentifiers, Identifiers};
use nightfall_cues::events::cue_store_operations;
use nightfall_cues::prelude::{
    Cue, CuePart, CuePartStoreTarget, CueStoreError, CueStoreOperation, CueStoreSuccess,
    CueStoreTarget, Sequence,
};
use nightfall_cues::websocket::{CueDefinitionChange, SequenceDefinitionChange};
use nightfall_engine::prelude::{
    CommandId, CommandOrigin, CommandOutcome, CommandTracker, DataProvider, EngineActionEnvelope,
    FinishedCommand, OperationId, OperationResult, ReplyTarget, UndoId,
};
use nightfall_fixtures::prelude::FixtureDataProviderExt;
use nightfall_undo::prelude::UndoManager;
use nightfall_undo::systems::finish_command_undo_groups;
use uuid::Uuid;

/// Creates an app containing only the resources required by typed cue store operations.
fn setup_app() -> App {
    let mut app = App::new();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Sequence>>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<FixtureDataProviderExt>();
    app.init_resource::<UndoManager>();
    app.init_resource::<CommandTracker>();
    app.add_message::<EngineActionEnvelope<CueStoreOperation>>();
    app.add_message::<OperationResult<CueStoreSuccess, CueStoreError>>();
    app.add_message::<FinishedCommand>();
    app.add_message::<CueDefinitionChange>();
    app.add_message::<SequenceDefinitionChange>();
    app.add_systems(
        Update,
        (cue_store_operations, finish_command_undo_groups).chain(),
    );
    app
}

/// Creates a stable empty sequence for store-operation tests.
fn sequence(id: u32) -> Sequence {
    Sequence {
        identifiers: Identifiers {
            id,
            uid: Uuid::new_v4(),
            label: format!("Sequence {id}"),
        },
        ..Default::default()
    }
}

/// Writes one command-owned cue store operation to the app.
fn write_operation(app: &mut App, action: CueStoreOperation) -> OperationId {
    write_operation_with_context(app, action).0
}

/// Writes one command-owned store operation and returns all lifecycle identities.
fn write_operation_with_context(
    app: &mut App,
    action: CueStoreOperation,
) -> (OperationId, CommandId, UndoId) {
    let operation_id = OperationId::new();
    let command_id = CommandId::new();
    let undo_id = UndoId::from(command_id);
    app.world_mut()
        .resource_mut::<CommandTracker>()
        .register_context(
            command_id,
            undo_id,
            CommandOrigin::WebUi,
            ReplyTarget::ClientBroadcast,
        )
        .unwrap();
    app.world_mut().write_message(EngineActionEnvelope {
        operation_id,
        command_id: Some(command_id),
        undo_id: Some(undo_id),
        action,
    });
    (operation_id, command_id, undo_id)
}

/// Verifies persistence and operation success happen before the workflow can resume.
#[test]
fn cue_store_operation_persists_cue_and_sequence_before_success() {
    let mut app = setup_app();
    app.world_mut()
        .resource_mut::<DataProvider<Sequence>>()
        .add(sequence(11))
        .unwrap();
    let operation_id = write_operation(
        &mut app,
        CueStoreOperation::StoreCueInSequence {
            sequence_id: 11,
            cue_id: CueStoreTarget::Exact(1),
            part_id: CuePartStoreTarget::Exact(0),
            part: Box::new(CuePart::default()),
            undo_label: "store cue 11.1".to_string(),
        },
    );

    app.update();

    let result = app
        .world_mut()
        .resource_mut::<Messages<OperationResult<CueStoreSuccess, CueStoreError>>>()
        .drain()
        .next()
        .unwrap();
    assert_eq!(result.operation_id, operation_id);
    assert_eq!(
        result.result,
        Ok(CueStoreSuccess {
            sequence_id: 11,
            cue_id: 1,
            part_id: 0,
        })
    );
    let cue_uid = app
        .world()
        .resource::<DataProvider<Cue>>()
        .from_id(1)
        .unwrap()
        .identifiers()
        .uid;
    let stored_sequence = app
        .world()
        .resource::<DataProvider<Sequence>>()
        .from_id(11)
        .unwrap();
    assert!(stored_sequence.steps.contains(&cue_uid.into()));
}

/// Verifies validation failure leaves both cue and sequence providers unchanged.
#[test]
fn cue_store_operation_conflict_does_not_partially_mutate() {
    let mut app = setup_app();
    let existing_sequence = sequence(11);
    app.world_mut()
        .resource_mut::<DataProvider<Sequence>>()
        .add(existing_sequence.clone())
        .unwrap();
    let mut conflicting_sequence = sequence(11);
    conflicting_sequence.identifiers.label = "Conflicting sequence".to_string();
    write_operation(
        &mut app,
        CueStoreOperation::StoreSequence {
            sequence: Box::new(conflicting_sequence),
            undo_label: "store cue 11.1".to_string(),
        },
    );

    app.update();

    let result = app
        .world_mut()
        .resource_mut::<Messages<OperationResult<CueStoreSuccess, CueStoreError>>>()
        .drain()
        .next()
        .unwrap();
    assert!(matches!(
        result.result,
        Err(CueStoreError {
            code: "cue.sequence_store_conflict",
            ..
        })
    ));
    assert!(
        app.world()
            .resource::<DataProvider<Cue>>()
            .iter()
            .next()
            .is_none()
    );
    let stored_sequence = app
        .world()
        .resource::<DataProvider<Sequence>>()
        .from_id(11)
        .unwrap();
    assert_eq!(
        stored_sequence.identifiers().uid,
        existing_sequence.identifiers.uid
    );
    assert_eq!(stored_sequence.identifiers().label, "Sequence 11");
}

/// Verifies a workflow undo group remains open until terminal command success arrives later.
#[test]
fn cue_store_undo_group_finishes_with_command_lifecycle() {
    let mut app = setup_app();
    app.world_mut()
        .resource_mut::<DataProvider<Sequence>>()
        .add(sequence(11))
        .unwrap();
    let (_, command_id, undo_id) = write_operation_with_context(
        &mut app,
        CueStoreOperation::StoreCueInSequence {
            sequence_id: 11,
            cue_id: CueStoreTarget::Exact(1),
            part_id: CuePartStoreTarget::Exact(0),
            part: Box::new(CuePart::default()),
            undo_label: "store cue 11.1".to_string(),
        },
    );

    app.update();

    let manager = app.world().resource::<UndoManager>();
    assert_eq!(manager.undo_depth(), 0);
    assert!(manager.has_pending_groups());

    let finished = app
        .world_mut()
        .resource_mut::<CommandTracker>()
        .finish(command_id, CommandOutcome::succeeded())
        .unwrap();
    app.world_mut().write_message(finished);
    app.update();

    let manager = app.world().resource::<UndoManager>();
    assert_eq!(manager.undo_depth(), 1);
    assert!(!manager.has_pending_groups());
    let group = manager
        .peek_undo()
        .expect("store should create one undo group");
    assert_eq!(group.undo_id, undo_id);
    assert_eq!(group.entries.len(), 1);
}
