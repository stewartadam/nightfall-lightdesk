// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Handles engine commands for timecode
use bevy_ecs::prelude::*;
use nightfall_engine::prelude::*;

use crate::{
    TimecodeAction, TimecodeCommand, TimecodeEvent, components::TimecodeGenerator,
    timecode::Timecode,
};

/// Handles engine commands for timecode
pub fn handle_events(
    mut timecode_gen_query: Query<(Entity, &mut TimecodeGenerator)>,
    mut event_reader: MessageReader<CommandEnvelope<TimecodeCommand>>,
    mut timecode_events: MessageWriter<TimecodeEvent>,
    mut responder: CommandResponder,
) {
    for event in event_reader.read() {
        let Some(action) = runtime_action_from_command(&event.command) else {
            continue;
        };
        let found = apply_runtime_action(&mut timecode_gen_query, &action);
        if found {
            timecode_events.write(runtime_event(&action));
        }
        let result = if found {
            responder.succeed(event.command_id)
        } else {
            responder.fail(
                event.command_id,
                CommandError::new(
                    "timecode.not_found",
                    format!(
                        "Timecode {} does not exist",
                        runtime_command_id(&event.command)
                    ),
                ),
            )
        };
        if let Err(error) = result {
            tracing::error!(command_id = %event.command_id, %error, "timecode_command_completion_failed");
        }
    }
}

/// Applies detached runtime actions and publishes facts for downstream observers.
pub fn handle_actions(
    mut timecode_gen_query: Query<(Entity, &mut TimecodeGenerator)>,
    mut actions: MessageReader<EngineActionEnvelope<TimecodeAction>>,
    mut timecode_events: MessageWriter<TimecodeEvent>,
) {
    for envelope in actions.read() {
        if apply_runtime_action(&mut timecode_gen_query, &envelope.action) {
            timecode_events.write(runtime_event(&envelope.action));
        } else {
            tracing::warn!(action = ?envelope.action, "timecode_action_target_not_found");
        }
    }
}

/// Converts the runtime subset of user commands into domain-owned actions.
fn runtime_action_from_command(command: &TimecodeCommand) -> Option<TimecodeAction> {
    match command {
        TimecodeCommand::StartTimecode(id) => Some(TimecodeAction::Start(*id)),
        TimecodeCommand::PauseTimecode(id) => Some(TimecodeAction::Pause(*id)),
        TimecodeCommand::StopTimecode(id) => Some(TimecodeAction::Stop(*id)),
        TimecodeCommand::SeekTimecode { id, position } => Some(TimecodeAction::Seek {
            id: *id,
            position: *position,
        }),
        _ => None,
    }
}

/// Applies one runtime timecode action and reports whether its target existed.
fn apply_runtime_action(
    timecode_gen_query: &mut Query<(Entity, &mut TimecodeGenerator)>,
    action: &TimecodeAction,
) -> bool {
    let id = match action {
        TimecodeAction::Start(id) | TimecodeAction::Pause(id) | TimecodeAction::Stop(id) => *id,
        TimecodeAction::Seek { id, .. } => *id,
    };
    let mut found = false;
    for (entity, mut generator) in timecode_gen_query
        .iter_mut()
        .filter(|(_, generator)| generator.timecode.identifiers.id == id)
    {
        found = true;
        tracing::trace!(%entity, timecode_id = id, ?action, "Applying timecode runtime action");
        match action {
            TimecodeAction::Start(_) => generator.start(),
            TimecodeAction::Pause(_) => generator.pause(),
            TimecodeAction::Stop(_) => generator.stop(),
            TimecodeAction::Seek { position, .. } => generator.seek(*position),
        }
    }
    found
}

/// Converts an applied runtime action into its observable domain fact.
fn runtime_event(action: &TimecodeAction) -> TimecodeEvent {
    match action {
        TimecodeAction::Start(id) => TimecodeEvent::Started(*id),
        TimecodeAction::Pause(id) => TimecodeEvent::Paused(*id),
        TimecodeAction::Stop(id) => TimecodeEvent::Stopped(*id),
        TimecodeAction::Seek { id, position } => TimecodeEvent::Seeked {
            id: *id,
            position: *position,
        },
    }
}

/// Returns the numeric target shared by timecode runtime commands.
fn runtime_command_id(command: &TimecodeCommand) -> u32 {
    match command {
        TimecodeCommand::StartTimecode(id)
        | TimecodeCommand::PauseTimecode(id)
        | TimecodeCommand::StopTimecode(id)
        | TimecodeCommand::SeekTimecode { id, .. } => *id,
        _ => unreachable!("runtime command ID requested for a CRUD command"),
    }
}

/// CRUD operations for timecodes
pub fn crud_events(
    mut commands: Commands,
    mut timecodes: Query<(Entity, &mut TimecodeGenerator)>,
    mut timecode_data_provider: ResMut<DataProvider<Timecode>>,
    mut events: MessageReader<CommandEnvelope<TimecodeCommand>>,
    mut timecode_events: MessageWriter<TimecodeEvent>,
    mut responder: CommandResponder,
) {
    for event in events.read() {
        let outcome = match &event.command {
            TimecodeCommand::StoreTimecode(timecode) => {
                tracing::debug!("Storing timecode with ID: {}", timecode.identifiers.id);

                if let Err(error) = timecode_data_provider.add(timecode.clone()) {
                    tracing::warn!("Failed to store timecode: {}", error);
                    Some(Err(CommandError::new(
                        "timecode.store_failed",
                        format!("Failed to store timecode: {error}"),
                    )))
                } else {
                    let mut found = false;
                    for (_, mut generator) in timecodes.iter_mut().filter(|(_, generator)| {
                        generator.timecode.identifiers.uid == timecode.identifiers.uid
                    }) {
                        found = true;
                        generator.timecode = timecode.clone();
                        generator.state.timecode_id = timecode.identifiers.id;
                    }
                    if !found {
                        commands.spawn(TimecodeGenerator::new(timecode.clone()));
                    }
                    Some(Ok(()))
                }
            }

            TimecodeCommand::RenameTimecode { id, new_id } => {
                tracing::debug!("Renaming timecode with ID: {} to {}", id, new_id);
                if timecode_data_provider.from_id(*new_id).is_ok() {
                    Some(Err(CommandError::new(
                        "timecode.destination_exists",
                        format!("Timecode {new_id} already exists"),
                    )))
                } else {
                    let timecode = timecode_data_provider
                        .from_id(*id)
                        .map(|value| value.clone());
                    match timecode {
                        Ok(mut timecode) => {
                            let uid = timecode.identifiers.uid;
                            timecode.identifiers.id = *new_id;
                            match timecode_data_provider.add(timecode) {
                                Ok(()) => {
                                    for (_, mut generator) in
                                        timecodes.iter_mut().filter(|(_, generator)| {
                                            generator.timecode.identifiers.uid == uid
                                        })
                                    {
                                        generator.timecode.identifiers.id = *new_id;
                                        generator.state.timecode_id = *new_id;
                                    }
                                    Some(Ok(()))
                                }
                                Err(error) => Some(Err(CommandError::new(
                                    "timecode.rename_failed",
                                    format!("Failed to rename timecode {id} to {new_id}: {error}"),
                                ))),
                            }
                        }
                        Err(_) => Some(Err(CommandError::new(
                            "timecode.not_found",
                            format!("Timecode {id} does not exist"),
                        ))),
                    }
                }
            }

            TimecodeCommand::DeleteTimecode(id) => {
                tracing::debug!("Deleting timecode with ID: {}", id);
                let uid = timecode_data_provider
                    .from_id(*id)
                    .map(|value| value.identifiers.uid);
                match uid {
                    Ok(uid) => match timecode_data_provider.remove(&uid) {
                        Ok(_) => {
                            for (entity, _) in timecodes
                                .iter_mut()
                                .filter(|(_, generator)| generator.timecode.identifiers.uid == uid)
                            {
                                commands.entity(entity).despawn();
                            }
                            timecode_events.write(TimecodeEvent::Deleted(*id));
                            Some(Ok(()))
                        }
                        Err(error) => Some(Err(CommandError::new(
                            "timecode.delete_failed",
                            format!("Failed to delete timecode {id}: {error}"),
                        ))),
                    },
                    Err(_) => Some(Err(CommandError::new(
                        "timecode.not_found",
                        format!("Timecode {id} does not exist"),
                    ))),
                }
            }

            _ => None,
        };
        let Some(outcome) = outcome else {
            continue;
        };
        let result = match outcome {
            Ok(()) => responder.succeed(event.command_id),
            Err(error) => responder.fail(event.command_id, error),
        };
        if let Err(error) = result {
            tracing::error!(command_id = %event.command_id, %error, "timecode_command_completion_failed");
        }
    }
}

#[cfg(test)]
mod tests {
    use bevy_app::{App, Update};
    use bevy_ecs::message::Messages;
    use nightfall::prelude::Identifiers;

    use super::*;

    /// Creates a focused app containing semantic timecode command handlers.
    fn timecode_app() -> App {
        let mut app = App::new();
        app.init_resource::<DataProvider<Timecode>>();
        app.init_resource::<CommandTracker>();
        app.add_message::<CommandEnvelope<TimecodeCommand>>();
        app.add_message::<EngineActionEnvelope<TimecodeAction>>();
        app.add_message::<TimecodeEvent>();
        app.add_message::<CommandResult>();
        app.add_message::<CommandReply>();
        app.add_message::<FinishedCommand>();
        app.add_message::<CommandNotice>();
        app.add_systems(Update, (handle_events, handle_actions, crud_events));
        app
    }

    /// Registers and submits one timecode command to the focused app.
    fn submit(app: &mut App, command: TimecodeCommand) -> CommandId {
        let envelope = CommandEnvelope::new(command, CommandOrigin::WebUi, ReplyTarget::Detached);
        let command_id = envelope.command_id;
        app.world_mut()
            .resource_mut::<CommandTracker>()
            .register(&envelope)
            .expect("timecode command should register");
        app.world_mut().write_message(envelope);
        command_id
    }

    /// Drains the single terminal result emitted by a focused command update.
    fn take_result(app: &mut App) -> CommandResult {
        app.world_mut()
            .resource_mut::<Messages<CommandResult>>()
            .drain()
            .next()
            .expect("timecode command should return a terminal result")
    }

    /// Creates one deterministic stored timecode.
    fn timecode(id: u32) -> Timecode {
        Timecode {
            identifiers: Identifiers {
                id,
                label: format!("Timecode {id}"),
                ..Default::default()
            },
            ..Default::default()
        }
    }

    /// Verifies storing a timecode mutates authoritative state before success.
    #[test]
    fn store_timecode_mutates_before_success() {
        let mut app = timecode_app();
        let timecode = timecode(7);
        let uid = timecode.identifiers.uid;
        let command_id = submit(&mut app, TimecodeCommand::StoreTimecode(timecode));

        app.update();

        assert!(
            app.world()
                .resource::<DataProvider<Timecode>>()
                .get(uid)
                .is_ok()
        );
        let result = take_result(&mut app);
        assert_eq!(result.command_id, command_id);
        assert_eq!(result.outcome, CommandOutcome::succeeded());
    }

    /// Verifies runtime control of an unknown timecode returns a structured failure.
    #[test]
    fn start_missing_timecode_returns_failure() {
        let mut app = timecode_app();
        submit(&mut app, TimecodeCommand::StartTimecode(99));

        app.update();

        assert!(matches!(
            take_result(&mut app).outcome,
            CommandOutcome::Failed(CommandError { ref code, .. }) if code == "timecode.not_found"
        ));
    }

    /// Verifies detached automation actions mutate timecode state and publish domain facts.
    #[test]
    fn detached_start_action_publishes_started_event() {
        let mut app = timecode_app();
        app.world_mut().spawn(TimecodeGenerator::new(timecode(7)));
        app.world_mut()
            .write_message(EngineActionEnvelope::detached(TimecodeAction::Start(7)));

        app.update();

        let generator = app
            .world_mut()
            .query::<&TimecodeGenerator>()
            .single(app.world())
            .expect("timecode generator should remain present");
        assert!(generator.state.is_active);
        let events = app
            .world_mut()
            .resource_mut::<Messages<TimecodeEvent>>()
            .drain()
            .collect::<Vec<_>>();
        assert!(matches!(events.as_slice(), [TimecodeEvent::Started(7)]));
    }
}
