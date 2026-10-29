// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Macro CRUD commands and the commands that start, release and stop runs.

use bevy_ecs::prelude::*;
use nightfall::prelude::*;
use nightfall_desk::object_crud::{ObjectCrud, apply_object_crud_command};
use nightfall_engine::prelude::*;
use nightfall_undo::prelude::*;
use serde::{Deserialize, Serialize};

use crate::runner::{
    MAX_MACRO_NESTING, MacroRunPhase, MacroRuns, MacroStartRefusal, macro_statements,
};

/// User commands that edit macros and control their runs.
#[derive(Debug, Clone, Serialize, Deserialize, EnginePayload)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
#[serde(deny_unknown_fields)]
pub enum MacroCommand {
    /// Store or replace a macro definition (used to create and edit macros, and by undo).
    StoreMacro(Macro),
    /// Change a macro's numeric ID.
    RenameMacro {
        /// Existing macro ID.
        id: u32,
        /// New macro ID.
        new_id: u32,
    },
    /// Delete a macro by numeric ID, stopping it if it runs.
    DeleteMacro(u32),
    /// Run a macro's press body. Ignored while any body of the macro runs.
    ///
    /// The command finishes when the run ends, and fails when a statement fails.
    StartMacro(u32),
    /// Let go of a held button that started a macro: stop the press body and run the release
    /// body. Does nothing for a macro without a release body.
    ReleaseMacro(u32),
    /// Stop every running body of a macro.
    StopMacro(u32),
}

impl IngressCommand for MacroCommand {}

impl ObjectCrud<MacroCommand> for Macro {
    fn type_name() -> &'static str {
        "macro"
    }

    fn extract_store(command: &MacroCommand) -> Option<Self> {
        match command {
            MacroCommand::StoreMacro(definition) => Some(definition.clone()),
            _ => None,
        }
    }

    fn extract_rename(command: &MacroCommand) -> Option<(u32, u32)> {
        match command {
            MacroCommand::RenameMacro { id, new_id } => Some((*id, *new_id)),
            _ => None,
        }
    }

    fn extract_delete(command: &MacroCommand) -> Option<u32> {
        match command {
            MacroCommand::DeleteMacro(id) => Some(*id),
            _ => None,
        }
    }

    fn set_id(&mut self, new_id: u32) {
        self.identifiers.id = new_id;
    }
}

/// Applies macro commands, and stops every run when the operator undoes or redoes.
///
/// An `undo` or `redo` typed in a macro's own body doesn't stop runs, so a macro can step the
/// history on purpose.
///
/// Edits finish at once. A start or release leaves its command open until the run it starts
/// ends; [`crate::runner::advance_macro_runs`] reports that result.
pub fn handle_macro_commands(
    mut events: MessageReader<CommandEnvelope<MacroCommand>>,
    mut undo_events: MessageReader<CommandEnvelope<UndoCommand>>,
    mut macros: ResMut<DataProvider<Macro>>,
    mut runs: ResMut<MacroRuns>,
    mut responder: CommandResponder,
) {
    let history_moved = undo_events.read().any(|event| {
        matches!(event.command, UndoCommand::Undo {} | UndoCommand::Redo {})
            && !runs.is_statement(event.command_id)
    });
    if history_moved {
        runs.stop_all(&mut responder);
    }

    for event in events.read() {
        let result = match &event.command {
            MacroCommand::StartMacro(id) => {
                start_run(event, *id, MacroRunPhase::Press, &macros, &mut runs)
            }
            MacroCommand::ReleaseMacro(id) => {
                release(event, *id, &macros, &mut runs, &mut responder)
            }
            MacroCommand::StopMacro(id) => resolve(&macros, *id).map(|definition| {
                runs.stop(definition.identifiers.uid, None, &mut responder);
                RunStart::Finished
            }),
            command => {
                let deleted = deleted_uid(command, &macros);
                apply_object_crud_command::<Macro, _>(command, &mut macros)
                    .expect("remaining macro commands are CRUD")
                    .map(|()| {
                        if let Some(uid) = deleted {
                            runs.stop(uid, None, &mut responder);
                        }
                        RunStart::Finished
                    })
            }
        };
        let response = match result {
            Ok(RunStart::Started) => continue,
            Ok(RunStart::Finished) => responder.succeed(event.command_id),
            Ok(RunStart::Ignored(message)) => responder
                .notice(event.command_id, NoticeLevel::Info, message)
                .and_then(|()| responder.succeed(event.command_id)),
            Err(error) => responder.fail(event.command_id, error),
        };
        if let Err(error) = response {
            tracing::error!(command_id = %event.command_id, %error, "macro_command_completion_failed");
        }
    }
}

/// Whether a command left a run going or is finished now.
enum RunStart {
    /// A run started and finishes the command when it ends.
    Started,
    /// The command did its work and finishes now.
    Finished,
    /// Nothing ran; the command finishes now with this notice.
    Ignored(String),
}

/// Returns the UID a delete command removes, read before the delete applies.
fn deleted_uid(command: &MacroCommand, macros: &DataProvider<Macro>) -> Option<uuid::Uuid> {
    match command {
        MacroCommand::DeleteMacro(id) => macros.from_id(*id).ok().map(|m| m.identifiers.uid),
        _ => None,
    }
}

/// Looks up a macro by ID, failing with an operator-facing error when it does not exist.
fn resolve(macros: &DataProvider<Macro>, id: u32) -> Result<Macro, CommandError> {
    macros
        .from_id(id)
        .map(|definition| definition.clone())
        .map_err(|_| CommandError::new("macro.not_found", format!("Macro {id} does not exist")))
}

/// Starts one body of a macro, translating a refusal into a notice or a failure.
fn start_run(
    event: &CommandEnvelope<MacroCommand>,
    id: u32,
    phase: MacroRunPhase,
    macros: &DataProvider<Macro>,
    runs: &mut MacroRuns,
) -> Result<RunStart, CommandError> {
    let definition = resolve(macros, id)?;
    match runs.start(&definition, phase, event) {
        Ok(()) => Ok(RunStart::Started),
        Err(MacroStartRefusal::AlreadyRunning) => {
            Ok(RunStart::Ignored(format!("Macro {id} is already running")))
        }
        Err(MacroStartRefusal::Cycle) => Err(CommandError::new(
            "macro.cycle",
            format!("Macro {id} is already running further up this chain of macros"),
        )),
        Err(MacroStartRefusal::TooDeep) => Err(CommandError::new(
            "macro.nesting_too_deep",
            format!("Macros can start other macros at most {MAX_MACRO_NESTING} levels deep"),
        )),
    }
}

/// Stops a macro's press body and runs its release body, if it has one.
fn release(
    event: &CommandEnvelope<MacroCommand>,
    id: u32,
    macros: &DataProvider<Macro>,
    runs: &mut MacroRuns,
    responder: &mut CommandResponder,
) -> Result<RunStart, CommandError> {
    let definition = resolve(macros, id)?;
    if macro_statements(&definition.release_commands).is_empty() {
        return Ok(RunStart::Finished);
    }
    runs.stop(
        definition.identifiers.uid,
        Some(MacroRunPhase::Press),
        responder,
    );
    start_run(event, id, MacroRunPhase::Release, macros, runs)
}
