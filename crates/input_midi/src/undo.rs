// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Conditional mapping inverses that preserve unrelated bindings and persistent identity.

use bevy_app::{App, Update};
use bevy_ecs::prelude::*;
use nightfall_engine::prelude::*;
use nightfall_undo::prelude::*;

use crate::{command::MidiMapping, mapping::MidiMappings};

/// Internal replay operation; both sides describe the exact version of one binding.
#[derive(Clone, Debug, EnginePayload)]
struct MappingChange {
    expected: Option<MidiMapping>,
    replacement: Option<MidiMapping>,
}

impl IngressCommand for MappingChange {}

impl MappingChange {
    /// Builds an atomic replacement only when the saved binding version still matches.
    fn proposed(&self, mappings: &MidiMappings) -> Result<Vec<MidiMapping>, CommandError> {
        let id = self
            .expected
            .as_ref()
            .or(self.replacement.as_ref())
            .expect("mapping changes contain a binding")
            .id;
        let mut matching = mappings
            .mappings()
            .iter()
            .filter(|mapping| mapping.id == id);
        let current = matching.next();
        if matching.next().is_some() || current != self.expected.as_ref() {
            return Err(CommandError::new(
                "midi.mapping_changed",
                "The binding changed since this operation was recorded",
            ));
        }
        let mut proposed = mappings.mappings().to_vec();
        proposed.retain(|mapping| mapping.id != id);
        if let Some(mapping) = &self.replacement {
            if proposed
                .iter()
                .any(|other| MidiMappings::bindings_conflict(mapping, other))
            {
                return Err(CommandError::new(
                    "midi.mapping_conflict",
                    "Another binding now uses this identity or controller source",
                ));
            }
            proposed.push(mapping.clone());
        }
        Ok(proposed)
    }
}

impl UndoableOperation for MappingChange {
    /// Rejects stale undo/redo before history changes, then swaps the recorded versions.
    fn inverse(&self, ctx: &UndoContext) -> Option<Box<dyn UndoableOperation>> {
        self.proposed(ctx.world.resource::<MidiMappings>()).ok()?;
        Some(Box::new(Self {
            expected: self.replacement.clone(),
            replacement: self.expected.clone(),
        }))
    }

    /// Labels learned binding changes consistently in the shared history UI.
    fn description(&self) -> String {
        "Map MIDI controller".into()
    }
}

/// Registers private replay behavior without adding mapping-specific knowledge to undo infrastructure.
pub(crate) fn install(app: &mut App) {
    register_ingress_command::<MappingChange>(app);
    app.world_mut()
        .resource_mut::<UndoRegistry>()
        .register::<MappingChange>();
    app.add_systems(Update, replay.in_set(EventHandling));
}

/// Records the actual saved version after validation, including its backend-generated identity.
pub(crate) fn record(
    manager: &mut UndoManager,
    command_id: CommandId,
    undo_id: UndoId,
    before: Option<MidiMapping>,
    after: Option<MidiMapping>,
) {
    manager.push(
        UndoEntry {
            command: Box::new(MappingChange {
                expected: after,
                replacement: before,
            }),
            description: "Map MIDI controller".into(),
            command_id: Some(command_id),
        },
        undo_id,
        true,
    );
}

/// Rechecks the expected version at execution and completes the originating undo/redo command.
fn replay(
    mut events: MessageReader<CommandEnvelope<MappingChange>>,
    mut mappings: ResMut<MidiMappings>,
    mut responder: CommandResponder,
) {
    for event in events.read() {
        let result = match event.command.proposed(&mappings) {
            Ok(proposed) => {
                mappings.set_mappings(proposed);
                responder.succeed(event.command_id)
            }
            Err(error) => responder.fail(event.command_id, error),
        };
        if let Err(error) = result {
            tracing::error!(%error, "midi_mapping_replay_completion_failed");
        }
    }
}

#[cfg(test)]
mod tests {
    use nightfall_actions::ActionRegistry;
    use nightfall_actions::{
        ActionDescriptor, ActionId, ActionInputKind, ActionReference, ActionSurface,
        InvocationDispatch,
    };
    use nightfall_engine::controller_learning::{
        ControllerLearning, ControllerLearningCommand, LearnedControllerSource, LearnedGesture,
    };

    use super::*;
    use crate::command::MidiCommand;

    /// Runs the real tracked command route until the command publishes a terminal result.
    fn submit<C: IngressCommand>(app: &mut App, command: C) -> CommandOutcome {
        let envelope = CommandEnvelope::new(command, CommandOrigin::WebUi, ReplyTarget::Detached);
        let id = envelope.command_id;
        app.world_mut()
            .resource_mut::<CommandTracker>()
            .register(&envelope)
            .unwrap();
        app.world_mut().write_message(envelope);
        for _ in 0..4 {
            app.update();
            if let Some(result) = app
                .world_mut()
                .resource_mut::<Messages<CommandResult>>()
                .drain()
                .find(|result| result.command_id == id)
            {
                return result.outcome;
            }
        }
        panic!("command did not complete");
    }

    /// Learns through the production adapter so history captures the backend-created mapping.
    fn learn(app: &mut App, action: &str, replace: Option<MidiMapping>) -> MidiMapping {
        let session_id = uuid::Uuid::new_v4();
        assert_eq!(
            submit(
                app,
                ControllerLearningCommand::Begin {
                    session_id,
                    surface: ActionSurface::Midi
                }
            ),
            CommandOutcome::succeeded()
        );
        assert!(
            app.world_mut()
                .resource_mut::<ControllerLearning>()
                .capture(LearnedControllerSource {
                    surface: ActionSurface::Midi,
                    selector: serde_json::json!({"device_name":"Test", "channel":176, "note":7}),
                    label: "Test control".into(),
                    gesture: LearnedGesture::Continuous,
                })
        );
        let result = submit(
            app,
            MidiCommand::BindLearned {
                session_id,
                action: ActionReference::new(action, serde_json::json!({})),
                replace,
            },
        );
        assert!(
            matches!(result, CommandOutcome::Succeeded { .. }),
            "{result:?}"
        );
        app.world()
            .resource::<MidiMappings>()
            .mappings()
            .iter()
            .find(|mapping| mapping.action.id.as_str() == action)
            .unwrap()
            .clone()
    }

    /// Creation and replacement round-trip through shared undo/redo without overwriting later edits.
    #[test]
    fn learned_mapping_undo_redo_retains_identity_and_rejects_stale_state() {
        let mut app = App::new();
        app.add_plugins(EnginePlugin);
        app.add_plugins(UndoPlugin);
        app.add_plugins(ClientBridgePlugin);
        app.init_resource::<MidiMappings>();
        app.init_resource::<ActionRegistry>();
        for id in ["test.first", "test.second"] {
            app.world_mut()
                .resource_mut::<ActionRegistry>()
                .register::<serde_json::Value, _>(
                    ActionDescriptor {
                        id: ActionId::new(id),
                        capabilities: vec![],
                        label: id.into(),
                        allowed_surfaces: vec![ActionSurface::Midi],
                        input_kind: ActionInputKind::Trigger,
                        argument_schema: serde_json::json!({"type":"object"}),
                    },
                    |_, _, _| Ok(InvocationDispatch::succeeded()),
                );
        }
        register_ingress_command::<MidiCommand>(&mut app);
        app.add_systems(Update, crate::handle_midi_crud.in_set(EventHandling));
        install(&mut app);
        let first = learn(&mut app, "test.first", None);
        let mut unrelated = first.clone();
        unrelated.id = uuid::Uuid::new_v4();
        unrelated.action.id = ActionId::new("unavailable.loaded-action");
        unrelated.note = 8;
        app.world_mut()
            .resource_mut::<MidiMappings>()
            .set_mappings(vec![first.clone(), unrelated.clone()]);
        assert_eq!(
            submit(&mut app, UndoCommand::Undo {}),
            CommandOutcome::succeeded()
        );
        assert_eq!(
            app.world().resource::<MidiMappings>().mappings(),
            &[unrelated.clone()]
        );
        assert_eq!(
            submit(&mut app, UndoCommand::Redo {}),
            CommandOutcome::succeeded()
        );
        assert!(
            app.world()
                .resource::<MidiMappings>()
                .mappings()
                .contains(&first)
        );
        let second = learn(&mut app, "test.second", Some(first.clone()));
        assert_eq!(first.id, second.id);
        assert_eq!(
            submit(&mut app, UndoCommand::Undo {}),
            CommandOutcome::succeeded()
        );
        assert!(
            app.world()
                .resource::<MidiMappings>()
                .mappings()
                .contains(&first)
        );
        assert_eq!(
            submit(&mut app, UndoCommand::Redo {}),
            CommandOutcome::succeeded()
        );
        assert!(
            app.world()
                .resource::<MidiMappings>()
                .mappings()
                .contains(&second)
        );
        app.world_mut()
            .resource_mut::<MidiMappings>()
            .set_mappings(vec![first.clone(), unrelated.clone()]);
        let depth = app.world().resource::<UndoManager>().undo_depth();
        assert!(
            matches!(submit(&mut app, UndoCommand::Undo {}), CommandOutcome::Failed(error) if error.code == "undo.state_conflict")
        );
        assert_eq!(app.world().resource::<UndoManager>().undo_depth(), depth);
        assert_eq!(
            app.world().resource::<MidiMappings>().mappings(),
            &[first.clone(), unrelated.clone()]
        );
        assert_eq!(
            submit(
                &mut app,
                MidiCommand::StoreMapping {
                    expected: Some(first.clone()),
                    mapping: second.clone()
                }
            ),
            CommandOutcome::succeeded()
        );
        assert!(
            matches!(submit(&mut app, MidiCommand::StoreMapping { expected: Some(first.clone()), mapping: first.clone() }), CommandOutcome::Failed(error) if error.code == "midi.mapping_changed")
        );
        assert!(
            matches!(submit(&mut app, MidiCommand::StoreMapping { expected: None, mapping: second.clone() }), CommandOutcome::Failed(error) if error.code == "midi.mapping_changed")
        );
        assert_eq!(
            submit(
                &mut app,
                MidiCommand::RemoveMapping {
                    expected: second.clone()
                }
            ),
            CommandOutcome::succeeded()
        );
        assert_eq!(
            app.world().resource::<MidiMappings>().mappings(),
            &[unrelated.clone()]
        );
        assert_eq!(
            submit(&mut app, UndoCommand::Undo {}),
            CommandOutcome::succeeded()
        );
        assert!(
            app.world()
                .resource::<MidiMappings>()
                .mappings()
                .contains(&second)
        );
        assert_eq!(
            submit(&mut app, UndoCommand::Undo {}),
            CommandOutcome::succeeded()
        );
        assert!(
            app.world()
                .resource::<MidiMappings>()
                .mappings()
                .contains(&first)
        );
        assert_eq!(
            submit(
                &mut app,
                MidiCommand::RemoveMapping {
                    expected: unrelated.clone()
                }
            ),
            CommandOutcome::succeeded()
        );
        assert_eq!(
            submit(&mut app, UndoCommand::Undo {}),
            CommandOutcome::succeeded()
        );
        assert!(
            app.world()
                .resource::<MidiMappings>()
                .mappings()
                .contains(&unrelated)
        );
        assert_eq!(
            submit(&mut app, UndoCommand::Redo {}),
            CommandOutcome::succeeded()
        );
        let mut conflict = unrelated.clone();
        conflict.id = uuid::Uuid::new_v4();
        let mut current = app.world().resource::<MidiMappings>().mappings().to_vec();
        current.push(conflict);
        app.world_mut()
            .resource_mut::<MidiMappings>()
            .set_mappings(current.clone());
        let depth = app.world().resource::<UndoManager>().undo_depth();
        assert!(
            matches!(submit(&mut app, UndoCommand::Undo {}), CommandOutcome::Failed(error) if error.code == "undo.state_conflict")
        );
        assert_eq!(app.world().resource::<UndoManager>().undo_depth(), depth);
        assert_eq!(app.world().resource::<MidiMappings>().mappings(), current);
    }
}
