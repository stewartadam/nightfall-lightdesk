// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Live commands and updates an engine accepted, recorded so a backup can replay them as they
//! happen instead of waiting for the next live state checkpoint.
//!
//! Domains choose which of their commands are forwarded: playback and programmer changes that
//! a checkpoint also carries, never edits to the stored show, which reach a backup as a show
//! copy, nor commands about this computer or its connections. Every recorded entry takes the
//! next number of a process-wide sequence, which a checkpoint also captures, so a backup can
//! tell whether a checkpoint already reflects a forwarded command.

use std::{
    any::{Any, TypeId},
    collections::{HashMap, HashSet},
    sync::atomic::{AtomicU64, Ordering},
};

use bevy_app::App;
use bevy_ecs::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::prelude::*;

/// A forwarded command or update, in the same JSON form clients send.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ForwardedEntry {
    /// A tracked client command.
    Command {
        /// Command module, such as `ClipCommand`.
        module: String,
        /// The command, tagged by its `type`.
        command: Value,
    },
    /// An untracked high-frequency update, such as a fader move.
    Update {
        /// Update module, such as `FaderUpdate`.
        module: String,
        /// The update payload.
        update: Value,
    },
}

/// One recorded entry with where it came from.
#[derive(Debug, Clone)]
pub struct RecordedEntry {
    /// Number from the process-wide forwarding sequence.
    pub sequence: u64,
    /// Who submitted it, so a backup can leave out what its own show reproduces, such as
    /// timeline events.
    pub origin: Option<CommandOrigin>,
    /// The command or update.
    pub entry: ForwardedEntry,
}

/// Turns a forwardable command into its client JSON, or `None` when its type is not forwarded.
type ForwardFn = Box<dyn Fn(&dyn Any) -> Option<ForwardedEntry> + Send + Sync>;

/// Remote source name of commands a backup replays from its primary. Undo leaves them out, so
/// after a takeover the operator's undo history starts with their own changes.
pub const FORWARDED_COMMAND_SOURCE: &str = "Primary";

/// Returns whether `origin` is a command a backup replays from its primary.
pub fn is_forwarded_origin(origin: &CommandOrigin) -> bool {
    matches!(origin, CommandOrigin::Remote(source) if source == FORWARDED_COMMAND_SOURCE)
}

/// Process-wide forwarding sequence, so numbers keep increasing across show loads.
static FORWARD_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// Returns the number of the newest recorded entry, or 0 before the first.
pub fn latest_forwarded_sequence() -> u64 {
    FORWARD_SEQUENCE.load(Ordering::Acquire)
}

/// Which commands and updates are forwarded, and the entries recorded since a backup host last
/// collected them.
#[derive(Resource, Default)]
pub struct CommandForwarding {
    commands: HashMap<TypeId, ForwardFn>,
    updates: HashSet<String>,
    recording: bool,
    recorded: Vec<RecordedEntry>,
}

impl CommandForwarding {
    /// Starts or stops recording. Only a host that can serve a backup records, so nothing piles
    /// up where no one collects it.
    pub fn set_recording(&mut self, recording: bool) {
        self.recording = recording;
        if !recording {
            self.recorded.clear();
        }
    }

    /// Returns whether accepted commands are being recorded.
    pub fn is_recording(&self) -> bool {
        self.recording
    }

    /// Takes the entries recorded since the previous call, oldest first.
    pub fn take_recorded(&mut self) -> Vec<RecordedEntry> {
        std::mem::take(&mut self.recorded)
    }

    /// Records an accepted command of type `T` when recording is on and `T` forwards its type.
    ///
    /// Commands normally pass through dispatch, which records them. A domain that consumes a
    /// command before dispatch, as fader flash buttons do, records it here instead.
    pub fn record_command<T: 'static>(&mut self, command: &T, origin: Option<CommandOrigin>) {
        if !self.recording {
            return;
        }
        let Some(forward) = self.commands.get(&TypeId::of::<T>()) else {
            return;
        };
        if let Some(entry) = forward(command) {
            self.record(origin, entry);
        }
    }

    /// Records `entry` under the next sequence number.
    fn record(&mut self, origin: Option<CommandOrigin>, entry: ForwardedEntry) {
        let sequence = FORWARD_SEQUENCE.fetch_add(1, Ordering::AcqRel) + 1;
        self.recorded.push(RecordedEntry {
            sequence,
            origin,
            entry,
        });
    }
}

/// Serializes a command of type `T` when its `type` tag is one of `types`.
fn forward_typed<T: Serialize + EngineIngressMeta + 'static>(
    command: &dyn Any,
    types: &[&str],
) -> Option<ForwardedEntry> {
    let command = serde_json::to_value(command.downcast_ref::<T>()?).ok()?;
    let command_type = command.get("type")?.as_str()?;
    types
        .contains(&command_type)
        .then(|| ForwardedEntry::Command {
            module: T::COMMAND_MODULE.to_string(),
            command,
        })
}

/// Registers which commands and updates of a domain a backup replays.
pub trait CommandForwardingAppExt {
    /// Forwards commands of type `T` whose `type` tag is listed in `types`.
    fn forward_commands_to_backup<T>(&mut self, types: &'static [&'static str]) -> &mut Self
    where
        T: Serialize + EngineIngressMeta + 'static;

    /// Forwards every update sent under `module`.
    fn forward_updates_to_backup(&mut self, module: &'static str) -> &mut Self;
}

impl CommandForwardingAppExt for App {
    fn forward_commands_to_backup<T>(&mut self, types: &'static [&'static str]) -> &mut Self
    where
        T: Serialize + EngineIngressMeta + 'static,
    {
        self.world_mut()
            .get_resource_or_init::<CommandForwarding>()
            .commands
            .insert(
                TypeId::of::<T>(),
                Box::new(move |command| forward_typed::<T>(command, types)),
            );
        self
    }

    fn forward_updates_to_backup(&mut self, module: &'static str) -> &mut Self {
        self.world_mut()
            .get_resource_or_init::<CommandForwarding>()
            .updates
            .insert(module.to_string());
        self
    }
}

/// Records an accepted command of type `T` when forwarding is on and `T` forwards its type.
pub(crate) fn record_forwarded_command<T: 'static>(
    world: &mut World,
    command: &T,
    origin: &CommandOrigin,
) {
    if let Some(mut forwarding) = world.get_resource_mut::<CommandForwarding>()
        && forwarding.recording
    {
        forwarding.record_command(command, Some(origin.clone()));
    }
}

/// Returns whether an update from `module` would be recorded, so ingress copies only those.
pub(crate) fn forwards_update(world: &World, module: &str) -> bool {
    world
        .get_resource::<CommandForwarding>()
        .is_some_and(|forwarding| forwarding.recording && forwarding.updates.contains(module))
}

/// Records an accepted update when forwarding is on and its module is forwarded.
pub(crate) fn record_forwarded_update(world: &mut World, module: String, update: Value) {
    if !forwards_update(world, &module) {
        return;
    }
    world
        .resource_mut::<CommandForwarding>()
        .record(None, ForwardedEntry::Update { module, update });
}

/// Applies a command or update forwarded by the primary, past the read-only gate that keeps
/// this backup's own clients from changing the show.
pub fn apply_forwarded_entry(world: &mut World, entry: ForwardedEntry) -> Result<(), String> {
    match entry {
        ForwardedEntry::Command { module, command } => {
            let command_id = CommandId::new();
            let undo_id = UndoId::from(command_id);
            world
                .resource_mut::<CommandTracker>()
                .register_context(
                    command_id,
                    undo_id,
                    CommandOrigin::Remote(FORWARDED_COMMAND_SOURCE.to_string()),
                    ReplyTarget::Detached,
                )
                .map_err(|error| error.to_string())?;
            let result =
                world.resource_scope(|world, registry: Mut<CommandDeserializerRegistry>| {
                    match registry.get(&module) {
                        Some(deserializer) => deserializer(world, command, command_id, undo_id),
                        None => Err(format!("No command module {module} is registered")),
                    }
                });
            if let Err(error) = &result {
                let _ = finish_command_in_world(
                    world,
                    command_id,
                    CommandOutcome::failed(CommandError::new(
                        "backup.forwarded_command_failed",
                        error.clone(),
                    )),
                );
            }
            result
        }
        ForwardedEntry::Update { module, update } => world.resource_scope(
            |world, registry: Mut<UpdateDeserializerRegistry>| match registry.get(&module) {
                Some(deserializer) => deserializer(world, update, Audience::All),
                None => Err(format!("No update module {module} is registered")),
            },
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Command used to verify which tagged variants are forwarded.
    #[derive(Debug, Clone, Serialize)]
    #[serde(tag = "type", content = "data")]
    enum TestCommand {
        Play(u32),
        Store(u32),
    }

    impl EngineIngressMeta for TestCommand {
        const COMMAND_MODULE: &'static str = "TestCommand";
    }

    /// Only listed command types are recorded, only while recording, each under a new sequence
    /// number, and updates are recorded by module.
    #[test]
    fn records_listed_commands_and_updates_while_recording() {
        let mut app = App::new();
        app.forward_commands_to_backup::<TestCommand>(&["Play"]);
        app.forward_updates_to_backup("TestUpdate");
        let world = app.world_mut();
        let origin = CommandOrigin::WebUi;

        record_forwarded_command(world, &TestCommand::Play(1), &origin);
        assert!(
            world
                .resource_mut::<CommandForwarding>()
                .take_recorded()
                .is_empty()
        );

        world
            .resource_mut::<CommandForwarding>()
            .set_recording(true);
        record_forwarded_command(world, &TestCommand::Play(2), &origin);
        record_forwarded_command(world, &TestCommand::Store(3), &origin);
        record_forwarded_update(world, "TestUpdate".to_string(), serde_json::json!(4));
        record_forwarded_update(world, "OtherUpdate".to_string(), serde_json::json!(5));

        let recorded = world.resource_mut::<CommandForwarding>().take_recorded();
        assert_eq!(recorded.len(), 2);
        assert_eq!(
            recorded[0].entry,
            ForwardedEntry::Command {
                module: "TestCommand".to_string(),
                command: serde_json::json!({"type": "Play", "data": 2}),
            }
        );
        assert_eq!(
            recorded[1].entry,
            ForwardedEntry::Update {
                module: "TestUpdate".to_string(),
                update: serde_json::json!(4),
            }
        );
        assert!(recorded[1].sequence > recorded[0].sequence);
        assert_eq!(latest_forwarded_sequence(), recorded[1].sequence);
    }
}
