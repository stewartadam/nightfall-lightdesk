// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! A sample-data desk driven through the full command path, shared by end-to-end tests.

use std::time::{Duration, Instant};

use bevy::prelude::{App, Messages};
use nightfall_engine::prelude::{
    CommandId, CommandOrigin, CommandOutcome, CommandResult, CommandTracker, EngineCommand,
    IngressCommand, PayloadEnvelope, PendingCommandBuffer, ReplyTarget, UndoId,
};
use nightfall_undo::prelude::UndoManager;

use super::sample_app;

/// Sample world plus every command result seen so far, so tests can wait on any command.
pub(super) struct DeskHarness {
    /// The desk's app, stepped one frame at a time.
    pub(super) app: App,
    /// Every command result drained so far.
    results: Vec<CommandResult>,
}

impl DeskHarness {
    /// Builds a sample-data world with an empty undo history.
    pub(super) fn new() -> Self {
        Self {
            app: sample_app(),
            results: Vec::new(),
        }
    }

    /// Submits a command the way a client does, with undo capture and a broadcast result.
    pub(super) fn submit<C: IngressCommand + Clone + 'static>(&mut self, command: C) -> CommandId {
        let command_id = CommandId::new();
        let undo_id = UndoId::from(command_id);
        self.app
            .world_mut()
            .resource_mut::<CommandTracker>()
            .register_context(
                command_id,
                undo_id,
                CommandOrigin::Cli,
                ReplyTarget::ClientBroadcast,
            )
            .expect("test command should register");
        self.app
            .world_mut()
            .resource_mut::<PendingCommandBuffer>()
            .push(PayloadEnvelope::with_context(
                command_id,
                undo_id,
                Box::new(command),
            ));
        command_id
    }

    /// Submits command-line text as one `EngineCommand::Eval` command.
    pub(super) fn eval(&mut self, text: &str) -> CommandId {
        self.submit(EngineCommand::Eval(text.to_string()))
    }

    /// Runs one frame and records the command results it produced.
    pub(super) fn step(&mut self) {
        self.app.update();
        self.results.extend(
            self.app
                .world_mut()
                .resource_mut::<Messages<CommandResult>>()
                .drain(),
        );
    }

    /// Returns a command's result if it has finished.
    pub(super) fn result(&self, command_id: CommandId) -> Option<CommandOutcome> {
        self.results
            .iter()
            .find(|result| result.command_id == command_id)
            .map(|result| result.outcome.clone())
    }

    /// Steps frames until a command finishes, giving up after two seconds.
    pub(super) fn wait(&mut self, command_id: CommandId) -> CommandOutcome {
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            self.step();
            if let Some(outcome) = self.result(command_id) {
                return outcome;
            }
            assert!(
                Instant::now() < deadline,
                "command {command_id} did not finish"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    /// Steps frames for at least `duration` of wall-clock time, so `sleep` statements elapse.
    pub(super) fn run_for(&mut self, duration: Duration) {
        let until = Instant::now() + duration;
        while Instant::now() < until {
            self.step();
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    /// Returns the undo IDs of the history, oldest first.
    pub(super) fn undo_ids(&self) -> Vec<UndoId> {
        self.app
            .world()
            .resource::<UndoManager>()
            .undo_stack()
            .map(|group| group.undo_id)
            .collect()
    }
}
