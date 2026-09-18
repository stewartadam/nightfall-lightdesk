// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Event handlers for Group CRUD operations

use bevy_ecs::prelude::*;
use nightfall::prelude::*;
use nightfall_engine::prelude::*;
use nightfall_fixtures::selection::SpatialSelectionResolver;
use nightfall_undo::prelude::{UndoEntry, UndoManager, UndoableOperation};

use crate::object_crud::apply_object_crud_command;
use crate::prelude::*;

/// Rewrites authored group aliases in one group definition before persistence.
fn stabilized_group(group: &Group, resolver: &SpatialSelectionResolver) -> Group {
    let mut group = group.clone();
    let stabilized = resolver.stabilize_group_refs_selection(&group.selection);
    for warning in &stabilized.issues {
        tracing::warn!("{}", warning);
    }
    group.selection = stabilized.value;
    group
}

/// Handles GroupAction runtime operations.
pub fn action_events(
    mut actions_reader: MessageReader<EngineActionEnvelope<GroupAction>>,
    mut group_storage: ParamSet<(SpatialSelectionResolver, ResMut<DataProvider<Group>>)>,
    mut undo_manager: ResMut<UndoManager>,
    mut results: MessageWriter<OperationResult<(), CommandError>>,
) {
    for event in actions_reader.read() {
        let result = match &event.action {
            GroupAction::StoreGroup(group) => {
                let group = {
                    let resolver = group_storage.p0();
                    stabilized_group(group, &resolver)
                };
                let mut group_data_provider = group_storage.p1();
                let inverse = group_data_provider
                    .from_id(group.identifiers.id)
                    .ok()
                    .map(|existing| GroupCommand::StoreGroup(existing.clone()))
                    .unwrap_or(GroupCommand::DeleteGroup(group.identifiers.id));
                match group_data_provider.add(group.clone()) {
                    Ok(()) => {
                        if let Some(undo_id) = event.undo_id {
                            undo_manager.push(
                                UndoEntry {
                                    command: Box::new(inverse) as Box<dyn UndoableOperation>,
                                    description: format!("Store Group {}", group.identifiers.id),
                                    command_id: event.command_id,
                                },
                                undo_id,
                                event.command_id.is_some(),
                            );
                        }
                        Ok(())
                    }
                    Err(error) => Err(CommandError::new(
                        "group.store_failed",
                        format!("Failed to store group: {error}"),
                    )),
                }
            }
        };
        results.write(match result {
            Ok(()) => OperationResult::succeeded(event.operation_id, ()),
            Err(error) => OperationResult::failed(event.operation_id, error),
        });
    }
}

/// Handles GroupCommand CRUD operations
pub fn crud_events(
    mut events_reader: MessageReader<CommandEnvelope<GroupCommand>>,
    mut group_storage: ParamSet<(SpatialSelectionResolver, ResMut<DataProvider<Group>>)>,
    mut responder: CommandResponder,
) {
    for event in events_reader.read() {
        let command = match &event.command {
            GroupCommand::StoreGroup(group) => {
                let resolver = group_storage.p0();
                GroupCommand::StoreGroup(stabilized_group(group, &resolver))
            }
            command => command.clone(),
        };
        let result = apply_object_crud_command::<Group>(&command, &mut group_storage.p1())
            .expect("every GroupCommand variant is a CRUD command");
        let response = match result {
            Ok(()) => responder.succeed(event.command_id),
            Err(error) => responder.fail(event.command_id, error),
        };
        if let Err(error) = response {
            tracing::error!(
                command_id = %event.command_id,
                %error,
                "group_command_completion_failed"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use bevy_app::{App, Update};
    use nightfall_fixtures::prelude::FixtureDataProviderExt;
    use uuid::Uuid;

    use super::*;

    /// Builds the focused lifecycle resources required by the group command handler.
    fn group_app() -> App {
        let mut app = App::new();
        app.init_resource::<DataProvider<Group>>();
        app.init_resource::<FixtureDataProviderExt>();
        app.init_resource::<CommandTracker>();
        app.add_message::<CommandEnvelope<GroupCommand>>();
        app.add_message::<CommandResult>();
        app.add_message::<CommandReply>();
        app.add_message::<FinishedCommand>();
        app.add_message::<CommandNotice>();
        app.add_systems(Update, crud_events);
        app
    }

    /// Registers and submits one group command to the focused handler app.
    fn submit(app: &mut App, command: GroupCommand) -> CommandId {
        let envelope = CommandEnvelope::new(command, CommandOrigin::WebUi, ReplyTarget::Detached);
        let command_id = envelope.command_id;
        app.world_mut()
            .resource_mut::<CommandTracker>()
            .register(&envelope)
            .expect("group command should register");
        app.world_mut().write_message(envelope);
        command_id
    }

    /// Drains the single terminal group result emitted by one update.
    fn take_result(app: &mut App) -> CommandResult {
        app.world_mut()
            .resource_mut::<Messages<CommandResult>>()
            .drain()
            .next()
            .expect("group command should return a terminal result")
    }

    /// Verifies group storage mutates the provider before reporting success.
    #[test]
    fn store_group_mutates_before_success() {
        let mut app = group_app();
        let group_uid = Uuid::new_v4();
        let mut group = Group::default();
        group.identifiers.id = 7;
        group.identifiers.uid = group_uid;
        let command_id = submit(&mut app, GroupCommand::StoreGroup(group));

        app.update();

        assert!(
            app.world()
                .resource::<DataProvider<Group>>()
                .get(group_uid)
                .is_ok()
        );
        let result = take_result(&mut app);
        assert_eq!(result.command_id, command_id);
        assert!(matches!(result.outcome, CommandOutcome::Succeeded { .. }));
    }

    /// Verifies direct group stores stabilize nested authored aliases.
    #[test]
    fn store_group_stabilizes_nested_group_aliases() {
        let mut app = group_app();
        let referenced_uid = Uuid::from_u128(3);
        let mut referenced = Group::default();
        referenced.identifiers.id = 3;
        referenced.identifiers.uid = referenced_uid;
        app.world_mut()
            .resource_mut::<DataProvider<Group>>()
            .add(referenced)
            .expect("referenced group should store");

        let stored_uid = Uuid::from_u128(7);
        let mut stored = Group::default();
        stored.identifiers.id = 7;
        stored.identifiers.uid = stored_uid;
        stored.selection = SpatialSelection::identity(SelectionExpr::Group(GroupRefExpr::ById(3)));
        submit(&mut app, GroupCommand::StoreGroup(stored));

        app.update();

        let stored = app
            .world()
            .resource::<DataProvider<Group>>()
            .get(stored_uid)
            .expect("group should store");
        assert_eq!(
            stored.selection.source,
            SelectionExpr::Group(GroupRefExpr::ByUid {
                uid: referenced_uid,
            })
        );
    }

    /// Verifies missing group deletion returns one stable structured failure.
    #[test]
    fn delete_missing_group_returns_failure() {
        let mut app = group_app();
        submit(&mut app, GroupCommand::DeleteGroup(99));

        app.update();

        let result = take_result(&mut app);
        assert!(matches!(
            result.outcome,
            CommandOutcome::Failed(error) if error.code == "group.not_found"
        ));
        assert_eq!(
            app.world_mut()
                .resource_mut::<Messages<CommandResult>>()
                .drain()
                .count(),
            0,
            "group command should finish exactly once"
        );
    }
}
