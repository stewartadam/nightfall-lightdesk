// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use bevy_ecs::prelude::*;
use nightfall_cmd_parse::split_command_statements;
use nightfall_engine::prelude::*;
use web_time::Instant;

use crate::prelude::{DeskAction, DeskCommand};

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

/// Handles eval requests by parsing command text into domain-owned commands.
///
/// This processes one `DeskCommand::Eval` statement and delegates its parsed domain work.
/// Terminal success comes from the delegated handler; this wrapper only resolves parse,
/// validation, debug-injection, and asynchronous sleep outcomes itself.
pub fn handle_eval(
    mut scheduled: ResMut<DelayedCommandQueue>,
    mut events: MessageReader<CommandEnvelope<DeskCommand>>,
    mut actions: MessageReader<EngineActionEnvelope<DeskAction>>,
    mut responder: CommandResponder,
) {
    let mut evals = events.read().cloned().collect::<Vec<_>>();
    evals.extend(actions.read().map(|event| {
        let DeskAction::Eval(command) = &event.action;
        CommandEnvelope::with_context(
            event.operation_id.0.into(),
            event
                .undo_id
                .unwrap_or_else(|| UndoId::from(event.operation_id.0)),
            CommandOrigin::Remote("InternalDeskAction".to_owned()),
            ReplyTarget::Detached,
            DeskCommand::Eval(command.clone()),
        )
    }));

    for event in &evals {
        tracing::debug!(?event, "Received eval event");
        let DeskCommand::Eval(command) = &event.command else {
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
            .downcast_ref::<DeskCommand>()
            .and_then(|command| match command {
                DeskCommand::Eval(command) => Some(command.clone()),
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
        && let Some(DeskCommand::Sleep(duration)) =
            parsed_commands[0].as_any().downcast_ref::<DeskCommand>()
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

#[cfg(test)]
mod tests {
    use std::sync::Once;
    use std::thread;
    use std::time::Duration;

    use bevy_app::{App, Update};

    use super::*;

    static REGISTER_DESK_AST_CONVERTER: Once = Once::new();

    /// Registers every AST converter required by focused desk eval tests.
    fn ensure_desk_ast_converter_registered() {
        REGISTER_DESK_AST_CONVERTER.call_once(|| {
            nightfall_engine::protocol::dispatch_ast::register_converter::<
                crate::ast_conv::DeskAstConverter,
            >();
            nightfall_engine::protocol::dispatch_ast::register_converter::<
                nightfall_programmer::ast_conv::ProgrammerAstConverter,
            >();
        });
    }

    /// Creates a focused app with semantic lifecycle resources for eval handling.
    fn eval_app() -> App {
        let mut app = App::new();
        app.add_message::<CommandEnvelope<DeskCommand>>();
        app.add_message::<EngineActionEnvelope<DeskAction>>();
        app.add_message::<CommandResult>();
        app.add_message::<CommandReply>();
        app.add_message::<FinishedCommand>();
        app.add_message::<CommandNotice>();
        app.init_resource::<CommandTracker>();
        app.init_resource::<DelayedCommandQueue>();
        app.init_resource::<PendingCommandBuffer>();
        app.add_systems(Update, handle_eval);
        app
    }

    /// Registers and submits one eval command to the focused app.
    fn submit_eval(app: &mut App, command: &str) -> CommandId {
        let command_id = CommandId::new();
        app.world_mut()
            .resource_mut::<CommandTracker>()
            .register_context(
                command_id,
                command_id.into(),
                CommandOrigin::WebUi,
                ReplyTarget::ClientBroadcast,
            )
            .expect("eval command should register");
        app.world_mut().write_message(CommandEnvelope::with_context(
            command_id,
            command_id.into(),
            CommandOrigin::WebUi,
            ReplyTarget::ClientBroadcast,
            DeskCommand::Eval(command.to_string()),
        ));
        command_id
    }

    /// Queues one eval wrapper as if it had just arrived through WebSocket ingress.
    fn queue_eval(app: &mut App, command: &str) -> CommandId {
        let command_id = CommandId::new();
        app.world_mut()
            .resource_mut::<CommandTracker>()
            .register_context(
                command_id,
                command_id.into(),
                CommandOrigin::WebUi,
                ReplyTarget::ClientBroadcast,
            )
            .expect("eval command should register");
        app.world_mut()
            .resource_mut::<PendingCommandBuffer>()
            .push(PayloadEnvelope::with_context(
                command_id,
                command_id,
                Box::new(DeskCommand::Eval(command.to_string())),
            ));
        command_id
    }

    /// Verifies ingress eval wrappers become domain commands without using the delayed queue.
    #[test]
    fn pending_eval_expands_before_typed_dispatch() {
        ensure_desk_ast_converter_registered();

        let mut app = eval_app();
        app.add_systems(Update, expand_pending_eval_commands);
        queue_eval(&mut app, "fix 1 @ 100");

        app.update();

        assert!(
            app.world().resource::<DelayedCommandQueue>().is_empty(),
            "immediate eval work must not cross the delayed queue"
        );
        let expanded = app
            .world_mut()
            .resource_mut::<PendingCommandBuffer>()
            .drain();
        assert_eq!(expanded.len(), 1);
        assert!(
            expanded[0]
                .payload
                .as_any()
                .downcast_ref::<nightfall_programmer::prelude::ProgrammerCommand>()
                .is_some(),
            "eval should expose its parsed domain command in the current update"
        );
    }

    #[test]
    fn eval_does_not_succeed_before_delegated_command_runs() {
        ensure_desk_ast_converter_registered();

        let mut app = eval_app();
        submit_eval(&mut app, "undo");

        app.update();

        let results: Vec<_> = app
            .world_mut()
            .resource_mut::<Messages<CommandResult>>()
            .drain()
            .collect();
        assert!(
            results.is_empty(),
            "parsing must not finish the eval command"
        );
        assert_eq!(app.world().resource::<DelayedCommandQueue>().len(), 1);
    }

    /// Verifies that one ranged statement joins every expanded operation before success.
    #[test]
    fn eval_range_declares_all_delegated_successes() {
        ensure_desk_ast_converter_registered();

        let mut app = eval_app();
        let command_id = submit_eval(&mut app, "store exec 1>3");

        app.update();

        assert_eq!(app.world().resource::<DelayedCommandQueue>().len(), 3);
        let mut tracker = app.world_mut().resource_mut::<CommandTracker>();
        assert!(tracker.record_success(command_id, None).unwrap().is_none());
        assert!(tracker.record_success(command_id, None).unwrap().is_none());
        assert!(tracker.record_success(command_id, None).unwrap().is_some());
    }

    /// Verifies one failed expansion member waits for every queued sibling outcome.
    #[test]
    fn eval_range_joins_failures_before_terminal_result() {
        ensure_desk_ast_converter_registered();

        let mut app = eval_app();
        let command_id = submit_eval(&mut app, "store exec 1>3");

        app.update();

        let mut tracker = app.world_mut().resource_mut::<CommandTracker>();
        assert!(
            tracker
                .record_failure(command_id, CommandError::new("clip.store_failed", "failed"),)
                .unwrap()
                .is_none()
        );
        assert!(tracker.record_success(command_id, None).unwrap().is_none());
        let finished = tracker
            .record_success(command_id, None)
            .unwrap()
            .expect("last sibling should settle the failed expansion");
        assert!(matches!(
            finished.outcome,
            CommandOutcome::Failed(CommandError { code, .. })
                if code == "clip.store_failed"
        ));
    }

    #[test]
    fn eval_parse_errors_do_not_emit_success() {
        ensure_desk_ast_converter_registered();

        let mut app = eval_app();
        let command_id = submit_eval(&mut app, "this_is_not_a_valid_command");

        app.update();

        let results: Vec<_> = app
            .world_mut()
            .resource_mut::<Messages<CommandResult>>()
            .drain()
            .collect();
        assert!(
            results.iter().any(|result| result.command_id == command_id
                && matches!(result.outcome, CommandOutcome::Failed(_))),
            "expected an error command result for invalid eval command",
        );
        assert!(
            results.iter().all(|result| result.command_id != command_id
                || !matches!(result.outcome, CommandOutcome::Succeeded { .. })),
            "did not expect a success command result when eval parsing failed",
        );
    }

    #[test]
    fn eval_schedules_release_commands_without_preflight_prompt() {
        ensure_desk_ast_converter_registered();

        let mut app = eval_app();
        submit_eval(&mut app, "release fix 1");

        app.update();

        let results: Vec<_> = app
            .world_mut()
            .resource_mut::<Messages<CommandResult>>()
            .drain()
            .collect();
        assert!(
            results.is_empty(),
            "delegation must not report an early result: {results:?}"
        );
        assert!(
            !app.world().resource::<DelayedCommandQueue>().is_empty(),
            "expected commands to be scheduled",
        );
    }

    #[test]
    fn eval_rejects_semicolon_batches() {
        ensure_desk_ast_converter_registered();

        let mut app = eval_app();
        submit_eval(&mut app, "undo; sleep 100ms; redo");

        app.update();

        let results = app
            .world_mut()
            .resource_mut::<Messages<CommandResult>>()
            .drain()
            .collect::<Vec<_>>();
        assert!(matches!(
            results.as_slice(),
            [CommandResult {
                outcome: CommandOutcome::Failed(CommandError { message, .. }),
                ..
            }] if message.contains("independent awaited commands")
        ));
        assert!(app.world().resource::<DelayedCommandQueue>().is_empty());
    }

    /// Verifies semicolons inside quoted command tokens do not trigger the batch rejection.
    #[test]
    fn eval_treats_quoted_semicolon_as_one_statement() {
        ensure_desk_ast_converter_registered();

        let mut app = eval_app();
        submit_eval(&mut app, "fix 1 \"custom;attr\" @ 10");

        app.update();

        let results = app
            .world_mut()
            .resource_mut::<Messages<CommandResult>>()
            .drain()
            .collect::<Vec<_>>();
        assert!(results.iter().all(|result| {
            !matches!(
                &result.outcome,
                CommandOutcome::Failed(CommandError { code, .. })
                    if code == "desk.eval.statement_count"
            )
        }));
    }

    #[test]
    fn standalone_sleep_succeeds_only_after_delay() {
        ensure_desk_ast_converter_registered();

        let mut app = eval_app();
        app.add_systems(
            Update,
            crate::systems::scheduled_commands::process_scheduled_commands.after(handle_eval),
        );
        let command_id = submit_eval(&mut app, "sleep 20ms");

        app.update();
        assert!(
            app.world_mut()
                .resource_mut::<Messages<CommandResult>>()
                .drain()
                .next()
                .is_none()
        );

        thread::sleep(Duration::from_millis(30));
        app.update();

        let result = app
            .world_mut()
            .resource_mut::<Messages<CommandResult>>()
            .drain()
            .next()
            .expect("elapsed sleep should finish the command");
        assert_eq!(result.command_id, command_id);
        assert!(matches!(result.outcome, CommandOutcome::Succeeded { .. }));
    }

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
