// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Event handlers for Blueprint CRUD operations

use bevy_ecs::prelude::*;
use nightfall::prelude::*;
use nightfall_engine::prelude::*;
use nightfall_undo::prelude::{UndoEntry, UndoManager, UndoableOperation};

use crate::object_crud::apply_object_crud_command;
use crate::prelude::*;

/// Rejects deletion of a Blueprint that still has registered live dependents.
fn validate_blueprint_delete(
    command: &BlueprintCommand,
    provider: &DataProvider<Blueprint>,
    reference_index: &BlueprintReferenceIndex,
) -> Result<(), CommandError> {
    let BlueprintCommand::DeleteBlueprint(id) = command else {
        return Ok(());
    };
    let Ok(blueprint) = provider.from_id(*id) else {
        return Ok(());
    };
    let dependents = reference_index.dependents(blueprint.identifiers.uid);
    if dependents.is_empty() {
        return Ok(());
    }
    Err(CommandError::new(
        "blueprint.delete_referenced",
        format!(
            "Cannot delete Blueprint because it is referenced by: {}",
            dependents.join(", ")
        ),
    ))
}

/// Handles BlueprintAction runtime operations.
pub fn action_events(
    mut actions_reader: MessageReader<EngineActionEnvelope<BlueprintAction>>,
    mut blueprint_data_provider: ResMut<DataProvider<Blueprint>>,
    mut undo_manager: ResMut<UndoManager>,
    mut results: MessageWriter<OperationResult<(), CommandError>>,
    mut definition_changes: MessageWriter<BlueprintDefinitionChange>,
) {
    for event in actions_reader.read() {
        let result = match &event.action {
            BlueprintAction::StoreBlueprint(blueprint) => {
                let inverse = blueprint_data_provider
                    .from_id(blueprint.identifiers.id)
                    .ok()
                    .map(|existing| BlueprintCommand::StoreBlueprint(existing.clone()))
                    .unwrap_or(BlueprintCommand::DeleteBlueprint(blueprint.identifiers.id));
                match blueprint_data_provider.add(blueprint.clone()) {
                    Ok(()) => {
                        if let Some(undo_id) = event.undo_id {
                            undo_manager.push(
                                UndoEntry {
                                    command: Box::new(inverse) as Box<dyn UndoableOperation>,
                                    description: format!(
                                        "Store Blueprint {}",
                                        blueprint.identifiers.id
                                    ),
                                    command_id: event.command_id,
                                },
                                undo_id,
                                event.command_id.is_some(),
                            );
                        }
                        definition_changes.write(BlueprintDefinitionChange {
                            uid: blueprint.identifiers.uid,
                        });
                        Ok(())
                    }
                    Err(error) => Err(CommandError::new(
                        "blueprint.store_failed",
                        format!("Failed to store blueprint: {error}"),
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

/// Handles BlueprintCommand CRUD operations
pub fn crud_events(
    mut events_reader: MessageReader<CommandEnvelope<BlueprintCommand>>,
    mut blueprint_data_provider: ResMut<DataProvider<Blueprint>>,
    reference_index: Res<BlueprintReferenceIndex>,
    mut definition_changes: MessageWriter<BlueprintDefinitionChange>,
    mut responder: CommandResponder,
) {
    for event in events_reader.read() {
        let affected_uid = match &event.command {
            BlueprintCommand::StoreBlueprint(blueprint) => Some(blueprint.identifiers.uid),
            BlueprintCommand::RenameBlueprint { id, .. }
            | BlueprintCommand::DeleteBlueprint(id) => blueprint_data_provider
                .from_id(*id)
                .ok()
                .map(|blueprint| blueprint.identifiers.uid),
        };
        let result = if let Err(error) =
            validate_blueprint_delete(&event.command, &blueprint_data_provider, &reference_index)
        {
            Err(error)
        } else {
            apply_object_crud_command::<Blueprint>(&event.command, &mut blueprint_data_provider)
                .expect("every BlueprintCommand variant is a CRUD command")
        };
        let response = match result {
            Ok(()) => {
                if let Some(uid) = affected_uid {
                    definition_changes.write(BlueprintDefinitionChange { uid });
                }
                responder.succeed(event.command_id)
            }
            Err(error) => responder.fail(event.command_id, error),
        };
        if let Err(error) = response {
            tracing::error!(
                command_id = %event.command_id,
                %error,
                "blueprint_command_completion_failed"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use uuid::Uuid;

    use super::*;

    /// Deletion validation reports the dependent object and keeps the definition addressable.
    #[test]
    fn referenced_blueprint_cannot_be_deleted() {
        let uid = uuid::Uuid::new_v4();
        let mut provider = DataProvider::<Blueprint>::default();
        provider
            .add(Blueprint {
                identifiers: Identifiers {
                    id: 5,
                    uid,
                    label: "Color".to_owned(),
                },
                ..Default::default()
            })
            .expect("blueprint should be insertable");
        let mut index = BlueprintReferenceIndex::default();
        index.replace_source("cues", [(uid, "cue 1 (Look)".to_owned())]);

        let error =
            validate_blueprint_delete(&BlueprintCommand::DeleteBlueprint(5), &provider, &index)
                .expect_err("referenced Blueprint deletion should fail");
        assert_eq!(error.code, "blueprint.delete_referenced");
        assert!(error.message.contains("cue 1 (Look)"));
        assert!(provider.from_id(5).is_ok());
    }

    /// Reverse dependency snapshots remain stable and retain subsystem-qualified descriptions.
    #[test]
    fn blueprint_reference_snapshot_is_sorted() {
        let first_uid = Uuid::from_u128(1);
        let second_uid = Uuid::from_u128(2);
        let mut index = BlueprintReferenceIndex::default();
        index.replace_source(
            "programmer",
            [
                (second_uid, "live programmer".to_owned()),
                (first_uid, "blind programmer".to_owned()),
            ],
        );
        index.replace_source("cues", [(first_uid, "cue 2 (Look)".to_owned())]);

        assert_eq!(
            index.snapshot(),
            vec![
                (
                    first_uid,
                    vec![
                        "cues:cue 2 (Look)".to_owned(),
                        "programmer:blind programmer".to_owned(),
                    ],
                ),
                (second_uid, vec!["programmer:live programmer".to_owned()],),
            ],
        );
    }
}
