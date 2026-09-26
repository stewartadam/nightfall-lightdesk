// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::collections::HashMap;

use bevy_app::prelude::*;
use bevy_ecs::prelude::Messages;
use nightfall::command_types::{DmxChannelExpr, DmxChannelRef};
use nightfall::prelude::{
    FixtureRef, Group, GroupRefExpr, Identifiers, SelectionExpr, UnresolvedFixtureRef, ValueSource,
};
use nightfall_cues::prelude::{BoundCueInstruction, CueInstruction};
use nightfall_desk::prelude::{DeskSettings, SelectionFlattenPolicy};
use nightfall_dmx::prelude::{Attribute, ParameterValue};
use nightfall_engine::prelude::{
    CommandId, CommandNotice, CommandOrigin, CommandOutcome, CommandReply, CommandResult,
    CommandTracker, DataProvider, FinishedCommand, PayloadEnvelope, PendingCommandBuffer,
    PendingEngineActionBuffer, ReplyTarget, UndoId,
};
use nightfall_fixtures::prelude::{Fixture, FixtureDataProviderExt, FixtureElement};
use nightfall_programmer::events::{
    PendingUserCommandPlans, ProgrammerCommand, SelectionFlattenApprovals, StoreCueId,
    StoreCuePartId, StoreMode, plan_pending_user_commands,
};
use nightfall_programmer::prelude::{
    AttributeFilter, ClearCommand, ClearTarget, Programmer, ProgrammerAction, ReleaseCommand,
    ReleaseTarget, Scope, UserCommand,
};
use uuid::Uuid;

/// Builds the minimal planning schedule and its command/action queues.
fn setup_app() -> App {
    let mut app = App::new();
    app.add_message::<CommandResult>();
    app.add_message::<CommandReply>();
    app.add_message::<FinishedCommand>();
    app.add_message::<CommandNotice>();
    app.insert_resource(Programmer::default());
    app.insert_resource(DeskSettings::default());
    app.insert_resource(FixtureDataProviderExt::default());
    app.insert_resource(DataProvider::<Group>::default());
    app.insert_resource(PendingCommandBuffer::default());
    app.insert_resource(PendingEngineActionBuffer::default());
    app.init_resource::<CommandTracker>();
    app.init_resource::<SelectionFlattenApprovals>();
    app.init_resource::<PendingUserCommandPlans>();
    app.add_systems(Update, plan_pending_user_commands);
    app
}

/// Creates one fixture with stable identifiers for planner confirmation tests.
fn test_fixture(id: u32) -> Fixture {
    Fixture {
        identifiers: Identifiers {
            id,
            uid: Uuid::from_u128(u128::from(id)),
            label: format!("Fixture {id}"),
        },
        make: "Test".to_string(),
        model: "Fixture".to_string(),
        mode: "Mode".to_string(),
        elements: vec![FixtureElement::default()],
        ..Default::default()
    }
}

/// Verifies confirmation preflight rejects a complete multi-action plan before dispatch.
#[test]
fn rejects_multi_action_plan_atomically_when_one_action_requires_confirmation() {
    let mut app = setup_app();
    app.world_mut()
        .resource_mut::<DeskSettings>()
        .selection_flatten_policy = SelectionFlattenPolicy::Prompt;

    let fixture_a = test_fixture(801);
    let fixture_b = test_fixture(802);
    let group_selection = vec![
        FixtureRef {
            fixture_uid: fixture_a.identifiers.uid,
            index: None,
        },
        FixtureRef {
            fixture_uid: fixture_b.identifiers.uid,
            index: None,
        },
    ];
    {
        let mut fixtures = app.world_mut().resource_mut::<FixtureDataProviderExt>();
        fixtures.inner.add(fixture_a.clone()).unwrap();
        fixtures.inner.add(fixture_b).unwrap();
    }
    app.world_mut()
        .resource_mut::<DataProvider<Group>>()
        .add(Group {
            identifiers: Identifiers {
                id: 41,
                uid: Uuid::from_u128(41),
                label: "Group 41".to_string(),
            },
            selection: SelectionExpr::Resolved(group_selection).into(),
            ..Default::default()
        })
        .unwrap();
    {
        let mut programmer = app.world_mut().resource_mut::<Programmer>();
        programmer.set_active_selection(SelectionExpr::Group(GroupRefExpr::ById(41)));
        programmer.add_instruction(BoundCueInstruction {
            selection: SelectionExpr::Group(GroupRefExpr::ById(41)).into(),
            cue_instruction: CueInstruction {
                blueprint_application: None,
                values: HashMap::from([(
                    Attribute::Red,
                    ValueSource::Inline(ParameterValue::Absolute { value: 255.0 }),
                )]),
                ..Default::default()
            },
        });
    }

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
        .unwrap();
    app.world_mut()
        .resource_mut::<PendingCommandBuffer>()
        .push(PayloadEnvelope::with_context(
            command_id,
            undo_id,
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

    assert!(
        app.world_mut()
            .resource_mut::<PendingEngineActionBuffer>()
            .drain()
            .is_empty(),
        "no sibling action may dispatch when confirmation rejects the plan",
    );
    let results = app
        .world_mut()
        .resource_mut::<Messages<CommandResult>>()
        .drain()
        .collect::<Vec<_>>();
    let [
        CommandResult {
            command_id: result_command_id,
            outcome: CommandOutcome::Failed(error),
        },
    ] = results.as_slice()
    else {
        panic!("confirmation preflight should publish one rejection");
    };
    assert_eq!(*result_command_id, command_id);
    assert_eq!(
        error.code,
        "programmer.selection_flatten_confirmation_required"
    );
    let details = error
        .details
        .as_ref()
        .expect("atomic rejection should include the full approved retry");
    assert_eq!(details["module"], "UserCommand");
    let retry: UserCommand = serde_json::from_value(details["command"].clone()).unwrap();
    let duplicate_retry = retry.clone();
    let mut tampered_retry = retry.clone();
    let UserCommand::Clear(tampered_command) = &mut tampered_retry else {
        panic!("expected a clear retry");
    };
    tampered_command.targets.push(ClearTarget::Values);

    let tampered_id = CommandId::new();
    app.world_mut()
        .resource_mut::<CommandTracker>()
        .register_context(
            tampered_id,
            tampered_id.into(),
            CommandOrigin::WebUi,
            ReplyTarget::Detached,
        )
        .unwrap();
    app.world_mut()
        .resource_mut::<PendingCommandBuffer>()
        .push(PayloadEnvelope::with_context(
            tampered_id,
            tampered_id,
            Box::new(tampered_retry),
        ));
    app.update();

    let tampered_results = app
        .world_mut()
        .resource_mut::<Messages<CommandResult>>()
        .drain()
        .collect::<Vec<_>>();
    assert!(matches!(
        tampered_results.as_slice(),
        [CommandResult {
            command_id,
            outcome: CommandOutcome::Failed(error),
        }] if *command_id == tampered_id
            && error.code == "programmer.selection_flatten_approval_invalid"
    ));

    let retry_id = CommandId::new();
    app.world_mut()
        .resource_mut::<CommandTracker>()
        .register_context(
            retry_id,
            retry_id.into(),
            CommandOrigin::WebUi,
            ReplyTarget::Detached,
        )
        .unwrap();
    app.world_mut()
        .resource_mut::<PendingCommandBuffer>()
        .push(PayloadEnvelope::with_context(
            retry_id,
            retry_id,
            Box::new(retry),
        ));
    app.update();

    let approved_actions = app
        .world_mut()
        .resource_mut::<PendingEngineActionBuffer>()
        .drain();
    assert_eq!(approved_actions.len(), 2);
    assert!(approved_actions.iter().all(|envelope| {
        matches!(
            envelope.action.as_any().downcast_ref::<ProgrammerAction>(),
            Some(ProgrammerAction::ClearSelection)
                | Some(ProgrammerAction::ReleaseValues {
                    allow_selection_flatten: true,
                    ..
                })
        )
    }));

    let duplicate_id = CommandId::new();
    app.world_mut()
        .resource_mut::<CommandTracker>()
        .register_context(
            duplicate_id,
            duplicate_id.into(),
            CommandOrigin::WebUi,
            ReplyTarget::Detached,
        )
        .unwrap();
    app.world_mut()
        .resource_mut::<PendingCommandBuffer>()
        .push(PayloadEnvelope::with_context(
            duplicate_id,
            duplicate_id,
            Box::new(duplicate_retry),
        ));
    app.update();

    let duplicate_results = app
        .world_mut()
        .resource_mut::<Messages<CommandResult>>()
        .drain()
        .collect::<Vec<_>>();
    assert!(matches!(
        duplicate_results.as_slice(),
        [CommandResult {
            command_id,
            outcome: CommandOutcome::Failed(error),
        }] if *command_id == duplicate_id
            && error.code == "programmer.selection_flatten_approval_invalid"
    ));
}

/// Verifies DMX-only user commands do not retain programmer dispatch state.
#[test]
fn dmx_release_does_not_retain_programmer_plan() {
    let mut app = setup_app();
    let command_id = CommandId::new();
    app.world_mut()
        .resource_mut::<PendingCommandBuffer>()
        .push(PayloadEnvelope::with_context(
            command_id,
            UndoId::from(command_id),
            Box::new(UserCommand::Release(ReleaseCommand {
                target: Some(ReleaseTarget::Channels {
                    channels: DmxChannelExpr::Single(DmxChannelRef {
                        universe: 1,
                        address: 1,
                    }),
                }),
                allow_selection_flatten: false,
                selection_flatten_approval: None,
            })),
        ));

    app.update();

    assert!(
        app.world().resource::<PendingUserCommandPlans>().is_empty(),
        "non-programmer plans must not remain queued for programmer dispatch",
    );
}

/// Verifies a command that plans to two actions waits for both action successes.
#[test]
fn expands_success_join_for_multi_action_plan() {
    let mut app = setup_app();
    let command_id = CommandId::new();
    let undo_id = UndoId::new();
    app.world_mut()
        .resource_mut::<CommandTracker>()
        .register_context(
            command_id,
            undo_id,
            CommandOrigin::WebUi,
            ReplyTarget::Detached,
        )
        .unwrap();
    app.world_mut()
        .resource_mut::<PendingCommandBuffer>()
        .push(PayloadEnvelope::with_context(
            command_id,
            undo_id,
            Box::new(UserCommand::Clear(ClearCommand {
                targets: vec![ClearTarget::Selection, ClearTarget::Values],
                allow_selection_flatten: false,
                selection_flatten_approval: None,
            })),
        ));

    app.update();

    let mut tracker = app.world_mut().resource_mut::<CommandTracker>();
    assert!(tracker.record_success(command_id, None).unwrap().is_none());
    assert!(tracker.record_success(command_id, None).unwrap().is_some());
}

/// Verifies user intent is removed from the command queue and emitted as a typed action.
#[test]
fn plans_pending_user_command_into_actions() {
    let mut app = setup_app();
    let correlation_id = Uuid::new_v4();
    let undo_id = Uuid::new_v4();

    app.world_mut()
        .resource_mut::<PendingCommandBuffer>()
        .push(PayloadEnvelope::with_context(
            correlation_id,
            undo_id,
            Box::new(UserCommand::Release(ReleaseCommand::default())),
        ));

    app.update();

    let planned = app
        .world_mut()
        .resource_mut::<PendingEngineActionBuffer>()
        .drain();
    assert_eq!(
        planned.len(),
        1,
        "release should plan to one runtime action"
    );

    for action_envelope in planned {
        assert_eq!(
            action_envelope.command_id,
            Some(CommandId::from(correlation_id))
        );
        assert_eq!(action_envelope.undo_id, Some(UndoId::from(undo_id)));
        let action = action_envelope
            .action
            .as_any()
            .downcast_ref::<ProgrammerAction>()
            .expect("expected programmer action after planning");
        assert_eq!(
            action,
            &ProgrammerAction::ReleaseValues {
                scope: Scope::All,
                attributes: AttributeFilter::All,
                allow_selection_flatten: false,
            }
        );
    }
}

/// Verifies unrelated command payloads remain queued for their registered handlers.
#[test]
fn leaves_non_user_pending_commands_unchanged() {
    let mut app = setup_app();
    let correlation_id = Uuid::new_v4();
    let undo_id = Uuid::new_v4();

    app.world_mut()
        .resource_mut::<PendingCommandBuffer>()
        .push(PayloadEnvelope::with_context(
            correlation_id,
            undo_id,
            Box::new(ProgrammerCommand::StoreCue {
                sequence_id: 1,
                cue_id: StoreCueId::Exact(1),
                part_id: StoreCuePartId::Exact(0),
                mode: StoreMode::Replace,
                label: None,
            }),
        ));

    app.update();

    let pending = app
        .world_mut()
        .resource_mut::<PendingCommandBuffer>()
        .drain();
    assert_eq!(pending.len(), 1);
    assert!(
        pending[0]
            .payload
            .as_any()
            .downcast_ref::<ProgrammerCommand>()
            .is_some(),
        "expected non-user command to remain in pending buffer",
    );
}

/// Verifies earlier planned selection changes affect later commands in the same drain.
#[test]
fn plans_second_clear_against_updated_selection_context() {
    let mut app = setup_app();
    let correlation_id = Uuid::new_v4();
    let undo_id = Uuid::new_v4();

    {
        let mut programmer = app.world_mut().resource_mut::<Programmer>();
        programmer.set_active_selection(SelectionExpr::Fixture(UnresolvedFixtureRef {
            fixture_id: 1,
            element_index: None,
        }));
    }

    app.world_mut()
        .resource_mut::<PendingCommandBuffer>()
        .push(PayloadEnvelope::with_context(
            correlation_id,
            undo_id,
            Box::new(UserCommand::Clear(ClearCommand {
                targets: vec![ClearTarget::Selection],
                allow_selection_flatten: false,
                selection_flatten_approval: None,
            })),
        ));
    app.world_mut()
        .resource_mut::<PendingCommandBuffer>()
        .push(PayloadEnvelope::with_context(
            correlation_id,
            undo_id,
            Box::new(UserCommand::Clear(ClearCommand::default())),
        ));

    app.update();

    let pending = app
        .world_mut()
        .resource_mut::<PendingCommandBuffer>()
        .drain();
    let planned = app
        .world_mut()
        .resource_mut::<PendingEngineActionBuffer>()
        .drain();
    assert_eq!(
        planned.len(),
        2,
        "two clear commands should plan into two actions"
    );
    assert!(pending.is_empty());

    let first = planned[0]
        .action
        .as_any()
        .downcast_ref::<ProgrammerAction>()
        .expect("expected first planned programmer action");
    assert_eq!(
        first,
        &ProgrammerAction::ClearSelection,
        "first clear should clear selection",
    );

    let second = planned[1]
        .action
        .as_any()
        .downcast_ref::<ProgrammerAction>()
        .expect("expected second planned programmer action");
    assert_eq!(
        second,
        &ProgrammerAction::ClearValues {
            scope: Scope::All,
            attributes: AttributeFilter::All,
            allow_selection_flatten: false,
        },
        "second clear should see empty selection and clear values",
    );
}

/// Verifies queued programmer commands contribute to projected planner context.
#[test]
fn plans_clear_after_pending_selection_command_using_projected_context() {
    let mut app = setup_app();
    let correlation_id = Uuid::new_v4();
    let undo_id = Uuid::new_v4();
    let selection = SelectionExpr::Fixture(UnresolvedFixtureRef {
        fixture_id: 1,
        element_index: None,
    });

    app.world_mut()
        .resource_mut::<PendingCommandBuffer>()
        .push(PayloadEnvelope::with_context(
            correlation_id,
            undo_id,
            Box::new(ProgrammerCommand::SetProgrammerSelection(selection.clone())),
        ));
    app.world_mut()
        .resource_mut::<PendingCommandBuffer>()
        .push(PayloadEnvelope::with_context(
            correlation_id,
            undo_id,
            Box::new(UserCommand::Clear(ClearCommand::default())),
        ));

    app.update();

    let planned = app
        .world_mut()
        .resource_mut::<PendingCommandBuffer>()
        .drain();
    assert_eq!(planned.len(), 1);
    assert!(
        planned[0]
            .payload
            .as_any()
            .downcast_ref::<ProgrammerCommand>()
            .is_some(),
        "selection command should remain pending",
    );
    let actions = app
        .world_mut()
        .resource_mut::<PendingEngineActionBuffer>()
        .drain();
    assert_eq!(actions.len(), 1);
    let clear_action = actions[0]
        .action
        .as_any()
        .downcast_ref::<ProgrammerAction>()
        .expect("clear should be planned into a programmer action");
    assert_eq!(
        clear_action,
        &ProgrammerAction::ClearSelection,
        "clear should treat pending selection command as active selection",
    );
}
