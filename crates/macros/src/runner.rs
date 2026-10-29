// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Runs macro bodies one statement at a time through the desk command path.
//!
//! Each statement is submitted as its own tracked `DeskCommand::Eval`, and the next one waits
//! for its terminal result, so `sleep` and nested macros pause the run like they pause the
//! console. The command that started a run stays open until the run ends and reports how it
//! ended, so the console, a MIDI pad and a parent macro all see the same result.
//!
//! Every statement of a run shares the starting command's undo ID and commits as soon as it
//! finishes. The undo manager merges consecutive entries that share an ID, so an uninterrupted
//! run undoes as one step, while an edit the operator makes mid-run lands between two parts of
//! the macro in the order things happened.

use bevy_ecs::prelude::*;
use nightfall::prelude::*;
use nightfall_cmd_parse::split_command_statements;
use nightfall_desk::prelude::DeskCommand;
use nightfall_engine::prelude::*;
use serde::Serialize;
use uuid::Uuid;

/// Deepest chain of macros starting macros before a start is refused.
pub const MAX_MACRO_NESTING: usize = 8;

/// Which body of a macro a run executes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[typeshare::typeshare]
pub enum MacroRunPhase {
    /// The body run when the macro starts.
    Press,
    /// The body run when a held button that started the macro is let go.
    Release,
}

impl MacroRunPhase {
    /// Returns the body of `definition` that this phase runs.
    pub fn body(self, definition: &Macro) -> &str {
        match self {
            MacroRunPhase::Press => &definition.commands,
            MacroRunPhase::Release => &definition.release_commands,
        }
    }
}

/// One statement of a macro body and the line it was typed on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MacroStatement {
    /// One-based line number within the body.
    pub line: usize,
    /// Statement text submitted as a desk command.
    pub text: String,
}

/// Splits a macro body into statements, keeping the line each one came from.
///
/// Statements are separated by line breaks and by `;`, and blank statements are skipped.
pub fn macro_statements(body: &str) -> Vec<MacroStatement> {
    body.lines()
        .enumerate()
        .flat_map(|(index, line)| {
            split_command_statements(line)
                .into_iter()
                .map(move |text| MacroStatement {
                    line: index + 1,
                    text: text.to_string(),
                })
        })
        .collect()
}

/// One macro body being executed.
#[derive(Debug)]
struct MacroRun {
    /// Macro whose body runs.
    macro_uid: Uuid,
    /// Macro ID at start, used in messages when the macro no longer exists.
    macro_id: u32,
    /// Which body runs.
    phase: MacroRunPhase,
    /// Body text the run started from, compared against the stored macro to notice edits.
    body: String,
    /// Statements captured when the run started.
    statements: Vec<MacroStatement>,
    /// Index of the statement to submit next, or of the one in flight.
    next: usize,
    /// Command submitted for the current statement while it has not finished.
    in_flight: Option<CommandId>,
    /// Result of the in-flight statement, recorded once it finishes and consumed when the run
    /// advances.
    settled: Option<CommandOutcome>,
    /// Command that started the run; it finishes when the run ends.
    owner: CommandId,
    /// Undo group shared by every statement of the run.
    undo_id: UndoId,
    /// Surface that started the run, inherited by its statements.
    origin: CommandOrigin,
    /// Macros on the path from the outermost run to this one, including this macro.
    chain: Vec<Uuid>,
}

/// Why a run could not start.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MacroStartRefusal {
    /// The macro is already running, so the start is ignored.
    AlreadyRunning,
    /// A macro further up the chain of nested starts is this macro.
    Cycle,
    /// The chain of nested starts is deeper than [`MAX_MACRO_NESTING`].
    TooDeep,
}

/// Live macro runs, in the order they started.
#[derive(Resource, Default, Debug)]
pub struct MacroRuns {
    runs: Vec<MacroRun>,
    /// Set when a show load discards the commands runs wait on, so the next advance ends them.
    end_all_requested: bool,
}

/// Live state of one run, published to clients.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[typeshare::typeshare]
pub struct MacroRunStatus {
    /// Macro whose body runs.
    #[serde(with = "nightfall::serde_uuid_simple")]
    #[typeshare(serialized_as = "String")]
    pub macro_uid: Uuid,
    /// Which body runs.
    pub phase: MacroRunPhase,
    /// One-based line of the statement running now.
    pub line: u32,
    /// Zero-based position of the statement running now.
    pub statement: u32,
    /// Number of statements in the run.
    pub statement_count: u32,
}

impl MacroRuns {
    /// Returns whether any body of the macro is running.
    pub fn is_running(&self, macro_uid: Uuid) -> bool {
        self.runs.iter().any(|run| run.macro_uid == macro_uid)
    }

    /// Returns whether no run is live.
    pub fn is_empty(&self) -> bool {
        self.runs.is_empty()
    }

    /// Returns whether `command_id` is a statement a run submitted and still waits on.
    pub fn is_statement(&self, command_id: CommandId) -> bool {
        self.runs
            .iter()
            .any(|run| run.in_flight == Some(command_id))
    }

    /// Ends every run on the next advance.
    ///
    /// A show load drops pending and delayed commands, so statements in flight never finish
    /// and their runs would otherwise wait forever. The load can't finish commands itself, so
    /// [`advance_macro_runs`] reports the stops.
    pub fn end_all_for_show_load(&mut self) {
        if !self.runs.is_empty() {
            self.end_all_requested = true;
        }
    }

    /// Returns one status per live run, in start order.
    pub fn statuses(&self) -> Vec<MacroRunStatus> {
        self.runs
            .iter()
            .map(|run| MacroRunStatus {
                macro_uid: run.macro_uid,
                phase: run.phase,
                line: run
                    .statements
                    .get(run.next)
                    .map_or(0, |statement| saturating_u32(statement.line)),
                statement: saturating_u32(run.next),
                statement_count: saturating_u32(run.statements.len()),
            })
            .collect()
    }

    /// Starts a run of one macro body on behalf of `envelope`'s command.
    ///
    /// The command stays open until the run ends. When the command was submitted by a
    /// statement of another run, the new run is nested under it and refused if that would
    /// repeat a macro or exceed [`MAX_MACRO_NESTING`].
    pub fn start<T>(
        &mut self,
        definition: &Macro,
        phase: MacroRunPhase,
        envelope: &CommandEnvelope<T>,
    ) -> Result<(), MacroStartRefusal> {
        let macro_uid = definition.identifiers.uid;
        let mut chain = self
            .runs
            .iter()
            .find(|run| run.in_flight == Some(envelope.command_id))
            .map(|parent| parent.chain.clone())
            .unwrap_or_default();
        if chain.contains(&macro_uid) {
            return Err(MacroStartRefusal::Cycle);
        }
        if self.is_running(macro_uid) {
            return Err(MacroStartRefusal::AlreadyRunning);
        }
        if chain.len() >= MAX_MACRO_NESTING {
            return Err(MacroStartRefusal::TooDeep);
        }
        chain.push(macro_uid);
        let body = phase.body(definition);
        self.runs.push(MacroRun {
            macro_uid,
            macro_id: definition.identifiers.id,
            phase,
            body: body.to_string(),
            statements: macro_statements(body),
            next: 0,
            in_flight: None,
            settled: None,
            owner: envelope.command_id,
            undo_id: envelope.undo_id,
            origin: envelope.origin.clone(),
            chain,
        });
        Ok(())
    }

    /// Ends the macro's runs in `phase`, or in every phase when `phase` is `None`, reporting
    /// success for the commands that started them. Statements still in flight finish on their
    /// own, and nothing after them runs, including the rest of any macro they started.
    pub fn stop(
        &mut self,
        macro_uid: Uuid,
        phase: Option<MacroRunPhase>,
        responder: &mut CommandResponder,
    ) {
        self.finish_where(
            |run| run.macro_uid == macro_uid && phase.is_none_or(|phase| run.phase == phase),
            responder,
        );
    }

    /// Ends every run, reporting success for the commands that started them.
    pub fn stop_all(&mut self, responder: &mut CommandResponder) {
        self.finish_where(|_| true, responder);
    }

    /// Ends runs whose macro was deleted, or whose running body was edited or replaced by a
    /// show load or import, so a run never keeps executing text the show no longer holds.
    fn stop_outdated(&mut self, macros: &DataProvider<Macro>, responder: &mut CommandResponder) {
        self.finish_where(
            |run| {
                !macros
                    .get(run.macro_uid)
                    .is_ok_and(|definition| run.phase.body(&definition) == run.body)
            },
            responder,
        );
    }

    /// Removes the runs matching `predicate`, along with every macro those runs started, and
    /// reports success for their starting commands.
    ///
    /// A nested run's starting command is a statement of its parent, so a parent's in-flight
    /// statement identifies the child runs to end with it.
    fn finish_where(
        &mut self,
        predicate: impl Fn(&MacroRun) -> bool,
        responder: &mut CommandResponder,
    ) {
        let (mut finished, mut kept) = std::mem::take(&mut self.runs)
            .into_iter()
            .partition::<Vec<_>, _>(|run| predicate(run));
        let mut checked = 0;
        while checked < finished.len() {
            let parents: Vec<CommandId> = finished[checked..]
                .iter()
                .filter_map(|run| run.in_flight)
                .collect();
            checked = finished.len();
            let (children, rest) = kept
                .into_iter()
                .partition::<Vec<_>, _>(|run| parents.contains(&run.owner));
            kept = rest;
            finished.extend(children);
        }
        self.runs = kept;
        for run in finished.iter().rev() {
            succeed(responder, run);
        }
    }
}

/// Converts a count or position to the `u32` clients receive, saturating on overflow.
fn saturating_u32(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

/// Reports success for the command that started a run.
fn succeed(responder: &mut CommandResponder, run: &MacroRun) {
    if let Err(error) = responder.succeed(run.owner) {
        tracing::error!(command_id = %run.owner, %error, "macro_run_completion_failed");
    }
}

/// Reports the statement failure that ended a run on the command that started it.
///
/// The message names the macro's current ID, so a rename during the run doesn't point the
/// operator at the wrong macro.
fn fail(
    responder: &mut CommandResponder,
    macros: &DataProvider<Macro>,
    run: &MacroRun,
    error: &CommandError,
) {
    let macro_id = macros
        .get(run.macro_uid)
        .map_or(run.macro_id, |definition| definition.identifiers.id);
    let statement = &run.statements[run.next];
    let failure = CommandError::new(
        "macro.statement_failed",
        format!(
            "Macro {macro_id} stopped at line {} ({}): {}",
            statement.line, statement.text, error.message
        ),
    )
    .with_details(serde_json::json!({
        "macro_id": macro_id,
        "line": statement.line,
        "statement": statement.text,
        "code": error.code,
    }));
    if let Err(error) = responder.fail(run.owner, failure) {
        tracing::error!(command_id = %run.owner, %error, "macro_run_failure_failed");
    }
}

/// Records the results of statements that finished since the last frame on the runs waiting
/// for them.
///
/// Kept apart from [`advance_macro_runs`] because reading finished commands and finishing
/// commands through a [`CommandResponder`] cannot share one system.
pub fn record_statement_results(
    mut runs: ResMut<MacroRuns>,
    mut finished_commands: MessageReader<FinishedCommand>,
) {
    for finished in finished_commands.read() {
        if let Some(run) = runs
            .bypass_change_detection()
            .runs
            .iter_mut()
            .find(|run| run.in_flight == Some(finished.command_id))
        {
            run.settled = Some(finished.outcome.clone());
        }
    }
}

/// Moves every run forward: ends finished or failed runs, and submits the next statement of
/// each run that is waiting.
///
/// Runs after event handling, so a stop, release or undo handled this frame takes effect before
/// another statement is submitted. A submitted statement dispatches on the next frame.
pub fn advance_macro_runs(
    mut runs: ResMut<MacroRuns>,
    macros: Res<DataProvider<Macro>>,
    mut pending: ResMut<PendingCommandBuffer>,
    mut responder: CommandResponder,
) {
    if runs.is_empty() {
        return;
    }
    if std::mem::take(&mut runs.bypass_change_detection().end_all_requested) {
        runs.stop_all(&mut responder);
    }
    if macros.is_changed() {
        runs.stop_outdated(&macros, &mut responder);
    }

    // Runs waiting on a statement change nothing, so only a settled or submitted statement
    // marks the resource changed and republishes run progress.
    let mut progressed = false;
    let live = runs.bypass_change_detection();
    let mut index = 0;
    while index < live.runs.len() {
        let run = &mut live.runs[index];
        if let Some(outcome) = run.settled.take() {
            progressed = true;
            run.in_flight = None;
            if let CommandOutcome::Failed(error) = outcome {
                let run = live.runs.remove(index);
                fail(&mut responder, &macros, &run, &error);
                continue;
            }
            run.next += 1;
        }
        if run.in_flight.is_some() {
            index += 1;
            continue;
        }
        progressed = true;
        let Some(statement) = run.statements.get(run.next) else {
            let run = live.runs.remove(index);
            succeed(&mut responder, &run);
            continue;
        };
        let command_id = CommandId::new();
        if let Err(error) = responder.register_context(
            command_id,
            run.undo_id,
            run.origin.clone(),
            ReplyTarget::Detached,
        ) {
            tracing::error!(%command_id, %error, "macro_statement_registration_failed");
            let run = live.runs.remove(index);
            fail(
                &mut responder,
                &macros,
                &run,
                &CommandError::new("macro.statement_untracked", error.to_string()),
            );
            continue;
        }
        pending.push(PayloadEnvelope::with_context(
            command_id,
            run.undo_id,
            Box::new(DeskCommand::Eval(statement.text.clone())),
        ));
        run.in_flight = Some(command_id);
        index += 1;
    }
    if progressed {
        runs.set_changed();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Statements keep their line numbers, `;` splits a line, and blank lines are skipped.
    #[test]
    fn statements_split_lines_and_semicolons() {
        let statements = macro_statements("group 1 int 50\n\nsleep 2s; group 1 int 0\n");
        assert_eq!(
            statements,
            vec![
                MacroStatement {
                    line: 1,
                    text: "group 1 int 50".to_string(),
                },
                MacroStatement {
                    line: 3,
                    text: "sleep 2s".to_string(),
                },
                MacroStatement {
                    line: 3,
                    text: "group 1 int 0".to_string(),
                },
            ]
        );
    }
}
