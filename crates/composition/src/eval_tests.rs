// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Eval tests that need the words of several plugins: engine, undo, clips, and the programmer.

use std::sync::Once;
use std::thread;
use std::time::Duration;

use bevy_app::{App, Update};
use bevy_ecs::prelude::*;
use nightfall_engine::eval::{expand_pending_eval_commands, handle_eval};
use nightfall_engine::prelude::*;
use nightfall_engine::protocol::dispatch_ast::register_converter;

static REGISTER_AST_CONVERTERS: Once = Once::new();

/// Registers every AST converter the eval statements below are written in.
fn ensure_ast_converters_registered() {
    REGISTER_AST_CONVERTERS.call_once(|| {
        register_converter::<nightfall_engine::ast_conv::EngineAstConverter>();
        register_converter::<nightfall_undo::ast_conv::UndoAstConverter>();
        register_converter::<nightfall_clips::ast_conv::ClipAstConverter>();
        register_converter::<nightfall_programming::ast_conv::ProgrammerAstConverter>();
    });
}

/// Creates a focused app with semantic lifecycle resources for eval handling.
fn eval_app() -> App {
    let mut app = App::new();
    app.add_message::<CommandEnvelope<EngineCommand>>();
    app.add_message::<EngineOperationEnvelope<EvalOperation>>();
    app.add_message::<CommandResult>();
    app.add_message::<CommandReply>();
    app.add_message::<FinishedCommand>();
    app.add_message::<CommandNoticeReply>();
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
        EngineCommand::Eval(command.to_string()),
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
            Box::new(EngineCommand::Eval(command.to_string())),
        ));
    command_id
}

/// Verifies ingress eval wrappers become domain commands without using the delayed queue.
#[test]
fn pending_eval_expands_before_typed_dispatch() {
    ensure_ast_converters_registered();

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
            .downcast_ref::<nightfall_programming::prelude::ProgrammerCommand>()
            .is_some(),
        "eval should expose its parsed domain command in the current update"
    );
}

/// Verifies eval waits for the delegated command instead of succeeding once it has parsed.
#[test]
fn eval_does_not_succeed_before_delegated_command_runs() {
    ensure_ast_converters_registered();

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
    ensure_ast_converters_registered();

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
    ensure_ast_converters_registered();

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

/// Verifies an unparsable statement fails its eval command and never reports success.
#[test]
fn eval_parse_errors_do_not_emit_success() {
    ensure_ast_converters_registered();

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

/// Verifies release statements are scheduled for their handler without an early result.
#[test]
fn eval_schedules_release_commands_without_preflight_prompt() {
    ensure_ast_converters_registered();

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

/// Verifies statements joined by semicolons are refused instead of running as a batch.
#[test]
fn eval_rejects_semicolon_batches() {
    ensure_ast_converters_registered();

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
    ensure_ast_converters_registered();

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

/// Verifies a standalone sleep finishes its eval command only once the delay has elapsed.
#[test]
fn standalone_sleep_succeeds_only_after_delay() {
    ensure_ast_converters_registered();

    let mut app = eval_app();
    app.add_systems(
        Update,
        nightfall_engine::eval::process_scheduled_commands.after(handle_eval),
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
