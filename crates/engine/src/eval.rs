// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Command-language evaluation and delayed command scheduling.
//!
//! `EngineCommand::Eval` carries one statement of the command language. These systems parse it
//! through the registered AST converters and queue the commands it produces under the eval's
//! own command identity, so the caller's result waits for all of them.

use bevy_ecs::prelude::*;
use nightfall_cmd_parse::split_command_statements;
use web_time::Instant;

use crate::prelude::*;

/// Command origin for statements evaluated on behalf of playback and automation rather than a
/// person, so the commands they produce can tell the two apart.
pub const INTERNAL_ACTION_ORIGIN: &str = "InternalDeskAction";

/// Matches `debug panic worker <target>` and returns the target name.
fn parse_debug_panic_worker_command(input: &str) -> Option<&str> {
    let mut tokens = input.split_whitespace();
    match (
        tokens.next(),
        tokens.next(),
        tokens.next(),
        tokens.next(),
        tokens.next(),
    ) {
        (Some(cmd), Some(action), Some(scope), Some(target), None)
            if cmd.eq_ignore_ascii_case("debug")
                && action.eq_ignore_ascii_case("panic")
                && scope.eq_ignore_ascii_case("worker") =>
        {
            Some(target)
        }
        _ => None,
    }
}

/// Moves delayed commands whose time has arrived into the pending buffer, and completes sleeps
/// whose delay has passed.
pub fn process_scheduled_commands(
    mut scheduled: ResMut<DelayedCommandQueue>,
    mut pending: ResMut<PendingCommandBuffer>,
    mut responder: CommandResponder,
) {
    let ready_commands = scheduled.take_ready();
    let ready_completions = scheduled.take_ready_completions();

    if !ready_commands.is_empty() {
        tracing::debug!("Processing {} scheduled commands", ready_commands.len());
        for cmd in ready_commands {
            pending.push(cmd);
        }
    }

    for command_id in ready_completions {
        if let Err(error) = responder.succeed(command_id) {
            tracing::error!(%command_id, %error, "delayed_command_finish_failed");
        }
    }
}

/// Handles eval requests that arrive as messages rather than through the pending buffer.
///
/// Covers `EngineCommand::Eval` envelopes written directly and [`EvalOperation`]s emitted by
/// playback and automation. Terminal success comes from the delegated handlers; this system only
/// resolves parse, validation, debug-injection, and asynchronous sleep outcomes itself.
pub fn handle_eval(
    mut scheduled: ResMut<DelayedCommandQueue>,
    mut events: MessageReader<CommandEnvelope<EngineCommand>>,
    mut actions: MessageReader<EngineOperationEnvelope<EvalOperation>>,
    mut responder: CommandResponder,
) {
    let mut evals = events
        .read()
        .filter(|event| matches!(event.command, EngineCommand::Eval(_)))
        .cloned()
        .collect::<Vec<_>>();
    for event in actions.read() {
        let EvalOperation(command) = &event.operation;
        let command_id: CommandId = event.operation_id.0.into();
        let undo_id = event
            .undo_id
            .unwrap_or_else(|| UndoId::from(event.operation_id.0));
        let origin = CommandOrigin::Remote(INTERNAL_ACTION_ORIGIN.to_owned());
        // Registered so the commands the eval produces keep this origin, which tells clip
        // launches from a timeline apart from a person's.
        if !responder.is_active(command_id)
            && let Err(error) = responder.register_context(
                command_id,
                undo_id,
                origin.clone(),
                ReplyTarget::Detached,
            )
        {
            tracing::warn!(%command_id, %error, "eval_action_registration_failed");
        }
        evals.push(CommandEnvelope::with_context(
            command_id,
            undo_id,
            origin,
            ReplyTarget::Detached,
            EngineCommand::Eval(command.clone()),
        ));
    }

    for event in &evals {
        tracing::debug!(?event, "Received eval event");
        let EngineCommand::Eval(command) = &event.command else {
            continue;
        };
        for command in prepare_eval_commands(
            event.command_id,
            event.undo_id,
            command,
            &mut scheduled,
            &mut responder,
        ) {
            scheduled.schedule_now(command);
        }
    }
}

/// Expands queued eval wrappers before command dispatch closes for the current update.
///
/// WebSocket ingress reaches the pending buffer during `InputHandling`. Expanding there
/// allows parsed domain commands to pass through planning, undo capture, and typed
/// dispatch in the same update instead of waiting for a second engine frame.
pub fn expand_pending_eval_commands(
    mut pending: ResMut<PendingCommandBuffer>,
    mut scheduled: ResMut<DelayedCommandQueue>,
    mut responder: CommandResponder,
) {
    let queued = pending.drain();
    for envelope in queued {
        let eval = envelope
            .payload
            .as_any()
            .downcast_ref::<EngineCommand>()
            .and_then(|command| match command {
                EngineCommand::Eval(command) => Some(command.clone()),
                _ => None,
            });
        let Some(eval) = eval else {
            pending.push(envelope);
            continue;
        };

        for command in prepare_eval_commands(
            envelope.command_id,
            envelope.undo_id,
            &eval,
            &mut scheduled,
            &mut responder,
        ) {
            pending.push(command);
        }
    }
}

/// Parses one eval wrapper and prepares domain commands under its lifecycle identity.
fn prepare_eval_commands(
    command_id: CommandId,
    undo_id: UndoId,
    command: &str,
    scheduled: &mut DelayedCommandQueue,
    responder: &mut CommandResponder,
) -> Vec<PayloadEnvelope> {
    tracing::debug!("Received eval command: {}", command);
    let statements = split_command_statements(command);
    let [command_str] = statements.as_slice() else {
        let message = if statements.is_empty() {
            "Eval requires one command statement"
        } else {
            "Submit semicolon-separated statements as independent awaited commands"
        };
        fail_eval(responder, command_id, "desk.eval.statement_count", message);
        return Vec::new();
    };

    #[cfg(all(not(target_arch = "wasm32"), any(feature = "debug", debug_assertions)))]
    if let Some(target_name) = parse_debug_panic_worker_command(command_str) {
        let Some(target) = parse_debug_panic_target(target_name) else {
            let valid = debug_panic_target_names().join(", ");
            fail_eval(
                responder,
                command_id,
                "desk.eval.invalid_debug_target",
                format!(
                    "Invalid debug panic worker target '{target_name}'. Valid targets: {valid}"
                ),
            );
            return Vec::new();
        };

        request_debug_worker_panic(target);
        tracing::warn!(target = target_name, "Queued debug worker panic injection");
        if responder.is_active(command_id)
            && let Err(error) = responder.succeed(command_id)
        {
            tracing::error!(%error, "debug_panic_command_completion_failed");
        }
        return Vec::new();
    }
    #[cfg(any(target_arch = "wasm32", not(any(feature = "debug", debug_assertions))))]
    if parse_debug_panic_worker_command(command_str).is_some() {
        fail_eval(
            responder,
            command_id,
            "desk.eval.debug_unavailable",
            "debug panic worker requires a debug build (`--features debug`)",
        );
        return Vec::new();
    }

    let parsed_commands = match parse_command_string(command_str) {
        Ok(parsed_commands) if !parsed_commands.is_empty() => parsed_commands,
        Ok(_) => {
            fail_eval(
                responder,
                command_id,
                "desk.eval.empty",
                "Command produced no executable work",
            );
            return Vec::new();
        }
        Err(error) => {
            tracing::warn!(%error);
            fail_eval(
                responder,
                command_id,
                "desk.eval.parse_failed",
                error.to_string(),
            );
            return Vec::new();
        }
    };

    if parsed_commands.len() == 1
        && let Some(EngineCommand::Sleep(duration)) =
            parsed_commands[0].as_any().downcast_ref::<EngineCommand>()
    {
        if responder.is_active(command_id) {
            scheduled.schedule_completion(Instant::now() + *duration, command_id);
        }
        return Vec::new();
    }

    if responder.is_active(command_id)
        && let Err(error) = responder.expect_completions(command_id, parsed_commands.len())
    {
        tracing::error!(%command_id, %error, "eval_success_expectation_failed");
        fail_eval(
            responder,
            command_id,
            "desk.eval.tracking_failed",
            "Unable to track all operations produced by the command",
        );
        return Vec::new();
    }

    parsed_commands
        .into_iter()
        .map(|payload| PayloadEnvelope {
            command_id,
            undo_id,
            payload,
        })
        .collect()
}

/// Reports a structured terminal failure for one evaluated command.
fn fail_eval(
    responder: &mut CommandResponder,
    command_id: CommandId,
    code: &'static str,
    message: impl Into<String>,
) {
    let message = message.into();
    if !responder.is_active(command_id) {
        tracing::warn!(%command_id, code, %message, "detached_eval_failed");
        return;
    }
    if let Err(error) = responder.fail(command_id, CommandError::new(code, message)) {
        tracing::error!(%error, "eval_command_failure_failed");
    }
}

/// Deserializes engine commands, capturing undo for evals so the commands they produce can be
/// undone as one step.
pub(crate) fn deserialize_engine_command(
    world: &mut World,
    json: serde_json::Value,
    command_id: CommandId,
    undo_id: UndoId,
) -> Result<(), String> {
    let command = decode_client_command::<EngineCommand>(json)?;
    let undo = if matches!(command, EngineCommand::Eval(_)) {
        Undo::Captured
    } else {
        Undo::Skipped
    };
    submit_client_command(world, command_id, undo_id, command, undo);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verifies client eval input enters the queue that expands before typed dispatch.
    #[test]
    fn eval_deserialization_queues_pre_dispatch_expansion() {
        let mut world = World::new();
        world.init_resource::<PendingCommandBuffer>();
        let command_id = CommandId::new();

        deserialize_engine_command(
            &mut world,
            serde_json::json!({ "type": "Eval", "data": "fps 44" }),
            command_id,
            command_id.into(),
        )
        .expect("eval command should deserialize");

        let queued = world.resource_mut::<PendingCommandBuffer>().drain();
        assert_eq!(queued.len(), 1);
        assert_eq!(queued[0].command_id, command_id);
        assert!(matches!(
            queued[0].payload.as_any().downcast_ref::<EngineCommand>(),
            Some(EngineCommand::Eval(command)) if command == "fps 44"
        ));
    }

    /// Verifies only the four-word `debug panic worker <target>` shape is recognized.
    #[test]
    fn parse_debug_panic_worker_command_matches_expected_shape() {
        assert_eq!(
            super::parse_debug_panic_worker_command("debug panic worker bevy_main"),
            Some("bevy_main")
        );
        assert_eq!(
            super::parse_debug_panic_worker_command("debug panic worker"),
            None
        );
        assert_eq!(
            super::parse_debug_panic_worker_command("debug panic system bevy_main"),
            None
        );
    }
}
