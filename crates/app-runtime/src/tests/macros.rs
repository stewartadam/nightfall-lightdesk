// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! End-to-end macro runs through the full desk command path in a sample-data world.

use std::time::{Duration, Instant};

use bevy::prelude::{App, Messages};
use nightfall::prelude::{Identifiers, Macro};
use nightfall_actions::{ActionInvocation, ActionSurface};
use nightfall_clips::Clip;
use nightfall_desk::prelude::DeskCommand;
use nightfall_engine::prelude::{
    CommandId, CommandOrigin, CommandOutcome, CommandResult, CommandTracker, DataProvider,
    IngressCommand, PayloadEnvelope, PendingCommandBuffer, ReplyTarget, UndoId,
};
use nightfall_macros::prelude::*;
use nightfall_undo::prelude::{UndoCommand, UndoManager};

use super::sample_app;

/// Sample world plus every command result seen so far, so tests can wait on any command.
struct MacroHarness {
    app: App,
    results: Vec<CommandResult>,
}

impl MacroHarness {
    /// Builds a sample world holding the given macros as `(id, press body, release body)`.
    fn new(macros: &[(u32, &str, &str)]) -> Self {
        let mut harness = Self {
            app: sample_app(),
            results: Vec::new(),
        };
        for (id, commands, release_commands) in macros {
            let stored = harness.submit(MacroCommand::StoreMacro(Macro {
                identifiers: Identifiers {
                    id: *id,
                    label: format!("Macro {id}"),
                    ..Default::default()
                },
                commands: (*commands).to_string(),
                release_commands: (*release_commands).to_string(),
            }));
            assert_eq!(harness.wait(stored), CommandOutcome::succeeded());
        }
        harness
            .app
            .world_mut()
            .resource_mut::<UndoManager>()
            .clear();
        harness
    }

    /// Submits a command the way a client does, with undo capture and a broadcast result.
    fn submit<C: IngressCommand + Clone + 'static>(&mut self, command: C) -> CommandId {
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

    /// Submits command-line text as one desk eval command.
    fn eval(&mut self, text: &str) -> CommandId {
        self.submit(DeskCommand::Eval(text.to_string()))
    }

    /// Runs one frame and records the command results it produced.
    fn step(&mut self) {
        self.app.update();
        self.results.extend(
            self.app
                .world_mut()
                .resource_mut::<Messages<CommandResult>>()
                .drain(),
        );
    }

    /// Returns a command's result if it has finished.
    fn result(&self, command_id: CommandId) -> Option<CommandOutcome> {
        self.results
            .iter()
            .find(|result| result.command_id == command_id)
            .map(|result| result.outcome.clone())
    }

    /// Steps frames until a command finishes, giving up after two seconds.
    fn wait(&mut self, command_id: CommandId) -> CommandOutcome {
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
    fn run_for(&mut self, duration: Duration) {
        let until = Instant::now() + duration;
        while Instant::now() < until {
            self.step();
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    /// Returns whether a clip with this ID exists.
    fn has_clip(&mut self, id: u32) -> bool {
        self.app
            .world_mut()
            .query::<&Clip>()
            .iter(self.app.world())
            .any(|clip| clip.identifiers.id == id)
    }

    /// Returns whether any body of the macro with this ID is running.
    fn is_running(&self, id: u32) -> bool {
        let uid = self.macro_uid(id);
        self.app.world().resource::<MacroRuns>().is_running(uid)
    }

    /// Returns the UID of the macro with this ID.
    fn macro_uid(&self, id: u32) -> uuid::Uuid {
        self.app
            .world()
            .resource::<DataProvider<Macro>>()
            .from_id(id)
            .expect("macro should exist")
            .identifiers
            .uid
    }

    /// Returns the undo IDs of the history, oldest first.
    fn undo_ids(&self) -> Vec<UndoId> {
        self.app
            .world()
            .resource::<UndoManager>()
            .undo_stack()
            .map(|group| group.undo_id)
            .collect()
    }
}

/// Typing `macro 1 start` runs every statement in order, finishes when the run ends, and the
/// whole run undoes as one step.
#[tokio::test]
async fn macro_start_runs_statements_in_order_as_one_undo_step() {
    let mut harness = MacroHarness::new(&[(1, "rename clip 1 901\nrename clip 901 902", "")]);

    let started = harness.eval("macro 1 start");
    assert_eq!(harness.wait(started), CommandOutcome::succeeded());

    assert!(
        harness.has_clip(902),
        "both renames should have run in order"
    );
    assert!(!harness.has_clip(1) && !harness.has_clip(901));
    assert_eq!(harness.undo_ids(), vec![UndoId::from(started)]);
    assert!(!harness.is_running(1));

    let undo = harness.submit(UndoCommand::Undo {});
    assert_eq!(harness.wait(undo), CommandOutcome::succeeded());
    assert!(
        harness.has_clip(1),
        "one undo should reverse the whole macro"
    );
}

/// A failing statement stops the run, names the macro and line, and keeps earlier statements.
#[tokio::test]
async fn failed_statement_stops_macro_and_names_the_line() {
    let mut harness =
        MacroHarness::new(&[(1, "rename clip 1 901\nnot a command\nrename clip 2 902", "")]);

    let started = harness.eval("macro 1 start");
    let CommandOutcome::Failed(error) = harness.wait(started) else {
        panic!("a failing statement should fail the macro");
    };

    assert_eq!(error.code, "macro.statement_failed");
    assert!(
        error
            .message
            .starts_with("Macro 1 stopped at line 2 (not a command)"),
        "unexpected message: {}",
        error.message
    );
    assert!(
        harness.has_clip(901),
        "statements before the failure stay applied"
    );
    assert!(
        harness.has_clip(2),
        "statements after the failure never run"
    );
}

/// An edit made while a macro waits lands between the macro's undo steps instead of under them.
#[tokio::test]
async fn operator_edit_mid_run_splits_the_macro_undo_step() {
    let mut harness =
        MacroHarness::new(&[(1, "rename clip 1 901\nsleep 150ms\nrename clip 2 902", "")]);

    let started = harness.eval("macro 1 start");
    while !harness.has_clip(901) {
        harness.step();
    }
    let edit = harness.eval("rename clip 3 903");
    assert_eq!(harness.wait(edit), CommandOutcome::succeeded());
    assert_eq!(harness.wait(started), CommandOutcome::succeeded());

    let macro_step = UndoId::from(started);
    assert_eq!(
        harness.undo_ids(),
        vec![macro_step, UndoId::from(edit), macro_step]
    );

    let undo = harness.submit(UndoCommand::Undo {});
    assert_eq!(harness.wait(undo), CommandOutcome::succeeded());
    assert!(harness.has_clip(2) && harness.has_clip(903) && harness.has_clip(901));
}

/// Undo while a macro is running stops the run before its remaining statements apply.
#[tokio::test]
async fn undo_stops_a_running_macro() {
    let mut harness =
        MacroHarness::new(&[(1, "rename clip 1 901\nsleep 150ms\nrename clip 2 902", "")]);

    let started = harness.eval("macro 1 start");
    while !harness.has_clip(901) {
        harness.step();
    }
    let undo = harness.submit(UndoCommand::Undo {});
    assert_eq!(harness.wait(undo), CommandOutcome::succeeded());
    assert_eq!(harness.wait(started), CommandOutcome::succeeded());
    harness.run_for(Duration::from_millis(250));

    assert!(
        harness.has_clip(1),
        "undo should reverse the statement that ran"
    );
    assert!(
        harness.has_clip(2),
        "the statement after the sleep should never run"
    );
}

/// `macro 1 stop` ends a run during a sleep, and the starting command reports success.
#[tokio::test]
async fn macro_stop_ends_a_run_during_sleep() {
    let mut harness = MacroHarness::new(&[(1, "sleep 150ms\nrename clip 1 901", "")]);

    let started = harness.eval("macro 1 start");
    harness.step();
    harness.step();
    assert!(harness.is_running(1));
    let stopped = harness.eval("macro 1 stop");
    assert_eq!(harness.wait(stopped), CommandOutcome::succeeded());
    assert_eq!(harness.wait(started), CommandOutcome::succeeded());
    harness.run_for(Duration::from_millis(250));

    assert!(
        harness.has_clip(1),
        "a stopped macro should not run its remaining statements"
    );
}

/// Starting a macro that is already running is ignored rather than running a second copy.
#[tokio::test]
async fn starting_a_running_macro_is_ignored() {
    let mut harness = MacroHarness::new(&[(1, "sleep 100ms\nrename clip 1 901", "")]);

    let first = harness.eval("macro 1 start");
    harness.step();
    let second = harness.eval("macro 1 start");
    assert_eq!(harness.wait(second), CommandOutcome::succeeded());
    assert!(
        harness.result(first).is_none(),
        "the first run should still be going"
    );
    assert_eq!(harness.wait(first), CommandOutcome::succeeded());
    assert!(harness.has_clip(901));
}

/// A held button's release stops the press body and runs the release body.
#[tokio::test]
async fn release_stops_press_body_and_runs_release_body() {
    let mut harness =
        MacroHarness::new(&[(1, "sleep 150ms\nrename clip 1 901", "rename clip 2 902")]);
    let uid = harness.macro_uid(1);

    harness
        .app
        .world_mut()
        .write_message(ActionInvocation::trigger(
            start_macro_action(uid),
            ActionSurface::Midi,
        ));
    harness.step();
    harness.step();
    assert!(harness.is_running(1));
    harness
        .app
        .world_mut()
        .write_message(ActionInvocation::trigger(
            release_macro_action(uid),
            ActionSurface::Midi,
        ));
    harness.run_for(Duration::from_millis(250));

    assert!(harness.has_clip(902), "the release body should run");
    assert!(
        harness.has_clip(1),
        "the rest of the press body should not run"
    );
    assert!(!harness.is_running(1));
}

/// Without a release body, letting go leaves the press body running to the end, so a quick tap
/// on a pad runs the whole macro.
#[tokio::test]
async fn release_without_release_body_lets_press_body_finish() {
    let mut harness = MacroHarness::new(&[(1, "sleep 50ms\nrename clip 1 901", "")]);

    let started = harness.eval("macro 1 start");
    harness.step();
    let released = harness.submit(MacroCommand::ReleaseMacro(1));
    assert_eq!(harness.wait(released), CommandOutcome::succeeded());
    assert_eq!(harness.wait(started), CommandOutcome::succeeded());

    assert!(harness.has_clip(901));
}

/// A macro may start another macro and waits for it, while a loop back to itself is refused.
#[tokio::test]
async fn nested_macros_wait_for_each_other_and_refuse_cycles() {
    let mut harness = MacroHarness::new(&[
        (1, "macro 2 start\nrename clip 2 902", ""),
        (2, "rename clip 1 901", ""),
        (3, "macro 4 start", ""),
        (4, "macro 3 start", ""),
    ]);

    let nested = harness.eval("macro 1 start");
    assert_eq!(harness.wait(nested), CommandOutcome::succeeded());
    assert!(harness.has_clip(901) && harness.has_clip(902));
    assert_eq!(
        harness.undo_ids(),
        vec![UndoId::from(nested)],
        "a nested macro shares its parent's undo step"
    );

    let cycle = harness.eval("macro 3 start");
    let CommandOutcome::Failed(error) = harness.wait(cycle) else {
        panic!("a macro starting itself through another macro should fail");
    };
    assert_eq!(error.code, "macro.statement_failed");
    assert!(
        error
            .message
            .contains("already running further up this chain"),
        "unexpected message: {}",
        error.message
    );
}

/// Stopping a macro also stops the macro its current statement started, so none of the
/// child's remaining statements run either.
#[tokio::test]
async fn stopping_a_macro_stops_the_macros_it_started() {
    let mut harness = MacroHarness::new(&[
        (1, "macro 2 start\nrename clip 2 902", ""),
        (2, "sleep 150ms\nrename clip 1 901", ""),
    ]);

    let started = harness.eval("macro 1 start");
    while !harness.is_running(2) {
        harness.step();
    }
    let stopped = harness.eval("macro 1 stop");
    assert_eq!(harness.wait(stopped), CommandOutcome::succeeded());
    assert_eq!(harness.wait(started), CommandOutcome::succeeded());
    harness.run_for(Duration::from_millis(250));

    assert!(
        !harness.is_running(2),
        "the child run should end with its parent"
    );
    assert!(
        harness.has_clip(1) && harness.has_clip(2),
        "neither macro should run its remaining statements"
    );
}

/// Editing a running macro stops it, so a run never keeps executing text the show no longer
/// holds.
#[tokio::test]
async fn editing_a_running_macro_stops_it() {
    let mut harness = MacroHarness::new(&[(1, "sleep 150ms\nrename clip 1 901", "")]);

    let started = harness.eval("macro 1 start");
    while !harness.is_running(1) {
        harness.step();
    }
    let edited = harness.submit(MacroCommand::StoreMacro(Macro {
        identifiers: Identifiers {
            id: 1,
            uid: harness.macro_uid(1),
            label: "Macro 1".to_string(),
        },
        commands: "rename clip 2 902".to_string(),
        release_commands: String::new(),
    }));
    assert_eq!(harness.wait(edited), CommandOutcome::succeeded());
    assert_eq!(harness.wait(started), CommandOutcome::succeeded());
    harness.run_for(Duration::from_millis(250));

    assert!(!harness.is_running(1));
    assert!(harness.has_clip(1) && harness.has_clip(2));
}

/// An `undo` typed in a macro's body steps the history without stopping the macro itself.
#[tokio::test]
async fn undo_in_a_macro_body_keeps_the_macro_running() {
    let mut harness = MacroHarness::new(&[(1, "rename clip 1 901\nundo\nrename clip 2 902", "")]);

    let started = harness.eval("macro 1 start");
    assert_eq!(harness.wait(started), CommandOutcome::succeeded());

    assert!(
        harness.has_clip(1),
        "the macro's undo should reverse its first line"
    );
    assert!(
        harness.has_clip(902),
        "the line after the undo should still run"
    );
}

/// A show load ends every run, because it discards the statements the runs wait on, and the
/// starting commands still get a result.
#[tokio::test]
async fn show_load_ends_running_macros() {
    let mut harness = MacroHarness::new(&[(1, "sleep 150ms\nrename clip 1 901", "")]);

    let started = harness.eval("macro 1 start");
    while !harness.is_running(1) {
        harness.step();
    }
    harness
        .app
        .world_mut()
        .resource_mut::<MacroRuns>()
        .end_all_for_show_load();
    assert_eq!(harness.wait(started), CommandOutcome::succeeded());
    assert!(!harness.is_running(1));
}
