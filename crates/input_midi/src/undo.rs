// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Undo and redo for MIDI mapping edits, through the shared binding restore operation.

use nightfall_actions::{ActionRegistry, capture_binding_edit};
use nightfall_undo::prelude::*;

use crate::command::MidiCommand;
use crate::mapping::MidiMappings;

impl Undoable for MidiCommand {
    /// Snapshots the mappings an edit will change, including mappings an upsert displaces.
    fn inverse(&self, ctx: &UndoContext) -> Option<Box<dyn Undoable>> {
        match self {
            Self::UpsertMapping(mapping) => {
                let registry = ctx.world.get_resource::<ActionRegistry>()?;
                capture_binding_edit::<MidiMappings>(ctx.world, self.description(), |mappings| {
                    let displaced =
                        mappings.upsert(mapping.clone(), |action| registry.input_kind(&action.id));
                    Some(
                        displaced
                            .iter()
                            .map(|displaced| displaced.id)
                            .chain([mapping.id])
                            .collect(),
                    )
                })
            }
            Self::DeleteMapping(id) => {
                capture_binding_edit::<MidiMappings>(ctx.world, self.description(), |mappings| {
                    mappings.delete(*id).then(|| vec![*id])
                })
            }
        }
    }

    /// Names the mapping edit for undo history.
    fn description(&self) -> String {
        match self {
            Self::UpsertMapping(_) => "Map MIDI control".to_string(),
            Self::DeleteMapping(_) => "Delete MIDI mapping".to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use bevy_app::prelude::*;
    use bevy_ecs::prelude::*;
    use nightfall_actions::{
        ActionDescriptor, ActionReference, ActionsPlugin, ControlBehavior, InvocationDispatch,
        register_binding_undo,
    };
    use nightfall_engine::EnginePlugin;
    use nightfall_engine::prelude::*;
    use nightfall_undo::UndoPlugin;
    use uuid::Uuid;

    use super::*;
    use crate::command::{MidiMapping, MidiSource};

    /// Terminal results collected across frames, keyed by command.
    #[derive(Resource, Default)]
    struct Results(Vec<CommandResult>);

    /// Records every terminal command result for assertions.
    fn collect_results(mut reader: MessageReader<CommandResult>, mut results: ResMut<Results>) {
        results.0.extend(reader.read().cloned());
    }

    /// Builds an app with the engine, undo, and actions plugins and MIDI mapping edits.
    fn undo_app() -> App {
        let mut app = App::new();
        app.add_plugins((EnginePlugin, UndoPlugin, ClientBridgePlugin, ActionsPlugin));
        app.world_mut()
            .resource_mut::<ActionRegistry>()
            .register::<serde::de::IgnoredAny, _>(
                ActionDescriptor::new("test.trigger", "Test", "Tests"),
                |_world, _arguments, _invocation| Ok(InvocationDispatch::succeeded()),
            );
        app.init_resource::<MidiMappings>();
        app.init_resource::<Results>();
        register_ingress_command::<MidiCommand>(&mut app);
        register_binding_undo::<MidiMappings, MidiCommand>(&mut app);
        app.add_systems(Update, crate::handle_midi_crud.in_set(EventHandling));
        app.add_systems(Last, collect_results);
        app
    }

    /// Submits one ingress command through undo capture and returns its terminal result.
    fn run(app: &mut App, command: impl IngressCommand + Clone) -> CommandOutcome {
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
            .expect("command should register");
        app.world_mut()
            .resource_mut::<PendingCommandBuffer>()
            .push(PayloadEnvelope::with_context(
                command_id,
                undo_id,
                Box::new(command),
            ));
        for _ in 0..3 {
            app.update();
        }
        app.world()
            .resource::<Results>()
            .0
            .iter()
            .find(|result| result.command_id == command_id)
            .map(|result| result.outcome.clone())
            .expect("command should finish")
    }

    /// Builds a pad mapping with a deterministic ID.
    fn pad(id: u128, note: u8) -> MidiMapping {
        MidiMapping {
            id: Uuid::from_u128(id),
            device_name: "Pad".to_string(),
            source: MidiSource::Note { channel: 0, note },
            behavior: ControlBehavior::Press,
            action: ActionReference::new("test.trigger", serde_json::json!({ "n": id })),
        }
    }

    /// Returns the stored mapping IDs in list order.
    fn stored_ids(app: &App) -> Vec<u128> {
        app.world()
            .resource::<MidiMappings>()
            .mappings()
            .iter()
            .map(|mapping| mapping.id.as_u128())
            .collect()
    }

    /// Seeds the store with three pads on notes 60, 61, and 62.
    fn seeded_app() -> App {
        let mut app = undo_app();
        app.world_mut()
            .resource_mut::<MidiMappings>()
            .set_mappings(vec![pad(1, 60), pad(2, 61), pad(3, 62)]);
        app
    }

    /// Verifies undo restores a displaced mapping at its position and redo displaces it again.
    #[test]
    fn upsert_with_displacement_undoes_and_redoes_in_order() {
        let mut app = seeded_app();

        let outcome = run(&mut app, MidiCommand::UpsertMapping(pad(4, 61)));
        assert!(matches!(outcome, CommandOutcome::Succeeded { .. }));
        assert_eq!(stored_ids(&app), vec![1, 3, 4]);

        assert!(matches!(
            run(&mut app, UndoCommand::Undo {}),
            CommandOutcome::Succeeded { .. }
        ));
        assert_eq!(stored_ids(&app), vec![1, 2, 3]);
        assert_eq!(
            app.world().resource::<MidiMappings>().mappings()[1],
            pad(2, 61)
        );

        assert!(matches!(
            run(&mut app, UndoCommand::Redo {}),
            CommandOutcome::Succeeded { .. }
        ));
        assert_eq!(stored_ids(&app), vec![1, 3, 4]);
    }

    /// Verifies undoing an in-place edit restores the edited and displaced mappings in order.
    #[test]
    fn upsert_edit_in_place_undoes_in_order() {
        let mut app = seeded_app();

        run(&mut app, MidiCommand::UpsertMapping(pad(1, 62)));
        assert_eq!(stored_ids(&app), vec![1, 2]);

        run(&mut app, UndoCommand::Undo {});
        assert_eq!(
            app.world().resource::<MidiMappings>().mappings(),
            &[pad(1, 60), pad(2, 61), pad(3, 62)]
        );
    }

    /// Verifies undoing a delete restores the mapping at its former position.
    #[test]
    fn delete_undo_restores_position() {
        let mut app = seeded_app();

        run(&mut app, MidiCommand::DeleteMapping(Uuid::from_u128(2)));
        assert_eq!(stored_ids(&app), vec![1, 3]);

        run(&mut app, UndoCommand::Undo {});
        assert_eq!(stored_ids(&app), vec![1, 2, 3]);

        run(&mut app, UndoCommand::Redo {});
        assert_eq!(stored_ids(&app), vec![1, 3]);
    }

    /// Verifies undo refuses when the mapping changed outside undo history since the edit.
    #[test]
    fn undo_refuses_when_mapping_changed_since() {
        let mut app = seeded_app();
        run(&mut app, MidiCommand::UpsertMapping(pad(4, 61)));
        let changed = vec![pad(1, 60), pad(3, 62), pad(4, 63)];
        app.world_mut()
            .resource_mut::<MidiMappings>()
            .set_mappings(changed.clone());

        let outcome = run(&mut app, UndoCommand::Undo {});

        assert!(matches!(
            outcome,
            CommandOutcome::Failed(CommandError { ref code, .. }) if code == "undo.state_conflict"
        ));
        assert_eq!(app.world().resource::<MidiMappings>().mappings(), &changed);
    }
}
