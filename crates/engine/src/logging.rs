// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Runtime log filtering: the reloadable tracing filter and the commands that change it.
//!
//! [`LoggingPlugin`] holds the process's [`LogConfig`] and answers [`LogCommand`]s. Other
//! plugins that trace their own objects, such as one fixture attribute, edit the same
//! [`LogConfig`] through [`LogConfig::update_target`].

use std::{
    collections::HashMap,
    sync::{Arc, PoisonError, RwLock, RwLockWriteGuard},
};

use bevy_app::prelude::*;
use bevy_ecs::prelude::*;
use serde::{Deserialize, Serialize};
use tracing_subscriber::{EnvFilter, reload};

use crate::prelude::*;

/// Log target configuration that can be adjusted at runtime.
#[derive(Debug, Clone)]
pub struct TracingTarget {
    /// Base filter, in the same format as `RUST_LOG`.
    pub filter_str: String,
    /// Span fields to trace, by name. `None` matches any value of that field.
    pub field_matchers: HashMap<String, Option<String>>,
}

impl Default for TracingTarget {
    /// Builds the default Nightfall tracing target without reading process-global configuration.
    fn default() -> Self {
        Self::new(None)
    }
}

impl TracingTarget {
    /// Builds a tracing target from an optional typed startup filter.
    pub fn new(filter: Option<&str>) -> Self {
        // Determine default level for our logs depending on build config
        #[cfg(debug_assertions)]
        let nightfall_default_level = "debug";

        #[cfg(not(debug_assertions))]
        let nightfall_default_level = "info";

        Self {
            filter_str: filter
                .map(str::to_owned)
                .unwrap_or_else(|| format!("info,nightfall={nightfall_default_level}")),
            field_matchers: HashMap::new(),
        }
    }
}

/// A resource that holds the log filter reload handle
#[derive(Resource, Clone)]
pub struct LogConfig {
    env_filter_fn: Arc<dyn Fn(EnvFilter) -> Result<(), reload::Error> + Send + Sync>,
    tracing_target: Arc<RwLock<TracingTarget>>,
}

impl LogConfig {
    /// Build a log configuration without a process-level subscriber reload handle.
    pub fn disconnected() -> Self {
        Self::new(|_| Ok(()), Arc::new(RwLock::new(TracingTarget::default())))
    }

    /// Builds a log configuration that applies filters through `env_filter_fn`, usually a
    /// subscriber's reload handle.
    pub fn new(
        env_filter_fn: impl Fn(EnvFilter) -> Result<(), reload::Error> + Send + Sync + 'static,
        tracing_target: Arc<RwLock<TracingTarget>>,
    ) -> Self {
        Self {
            env_filter_fn: Arc::new(env_filter_fn),
            tracing_target,
        }
    }

    /// Applies `edit` to a copy of the stored target and reloads the subscriber filter from it.
    ///
    /// The edit is kept only when the resulting filter parses and the subscriber accepts it, so
    /// a malformed level or field matcher leaves the previous filter in place.
    pub fn update_target(
        &self,
        edit: impl FnOnce(&mut TracingTarget),
    ) -> Result<(), LogFilterError> {
        let mut stored = self.stored_target();
        let mut candidate = stored.clone();
        edit(&mut candidate);
        (self.env_filter_fn)(candidate.env_filter()?)?;
        *stored = candidate;
        Ok(())
    }

    /// Returns a copy of the stored tracing target.
    pub fn tracing_target(&self) -> TracingTarget {
        self.stored_target().clone()
    }

    /// Locks the stored target, recovering it if a panicking writer poisoned the lock.
    fn stored_target(&self) -> RwLockWriteGuard<'_, TracingTarget> {
        self.tracing_target
            .write()
            .unwrap_or_else(PoisonError::into_inner)
    }
}

/// A log filter that could not be built or applied.
#[derive(Debug, thiserror::Error)]
pub enum LogFilterError {
    /// The base filter or a field matcher is not valid filter syntax.
    #[error("invalid log filter: {0}")]
    Parse(#[from] tracing_subscriber::filter::ParseError),
    /// The subscriber refused the new filter.
    #[error("could not apply log filter: {0}")]
    Reload(#[from] reload::Error),
}

impl TracingTarget {
    /// Builds the subscriber filter: the base filter plus a trace directive for every field
    /// matcher.
    fn env_filter(&self) -> Result<EnvFilter, LogFilterError> {
        let mut filter = self.filter_str.parse::<EnvFilter>()?;
        for (field, value) in &self.field_matchers {
            let directive = match value {
                Some(value) => format!("[{{{field}={value}}}]=trace"),
                None => format!("[{{{field}}}]=trace"),
            };
            tracing::debug!("Adding env filter directive: {}", directive);
            filter = filter.add_directive(directive.parse()?);
        }
        Ok(filter)
    }
}

/// Commands that change what the backend logs.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
#[serde(deny_unknown_fields)]
pub enum LogCommand {
    /// Set log level filter (e.g. "debug", "nightfall=trace"); "clear" restores the default.
    SetLogLevel(String),

    /// Trace every span with this field, or only those where it has this value
    SetTracingFilter {
        /// Span field name.
        field: String,
        /// Value to match; `None` matches any value.
        value: Option<String>,
    },

    /// Clear all existing log tracing filters
    ClearTracingFilter,
}

impl EnginePayload for LogCommand {}

impl IngressCommand for LogCommand {}

impl EngineIngressMeta for LogCommand {
    const COMMAND_MODULE: &'static str = "LogCommand";
}

/// Log messages sent to clients.
#[derive(Serialize)]
#[serde(tag = "type", content = "data")]
#[typeshare::typeshare]
enum LogWsMessage<'a> {
    /// A log command echoed to clients
    LogCommand(&'a LogCommand),
}

/// Holds the process's log filter and answers the log commands.
pub struct LoggingPlugin {
    /// Filter handle that log commands reload.
    pub log_config: LogConfig,
}

impl Plugin for LoggingPlugin {
    /// Inserts the log filter, registers [`LogCommand`], and adds its handler and client echo.
    fn build(&self, app: &mut App) {
        register_client_command::<LogCommand>(app, Undo::Skipped);
        app.insert_resource(self.log_config.clone());
        app.add_systems(Update, handle_log_commands.in_set(EventHandling));
        app.add_systems(
            PostUpdate,
            forward_log_level_commands.in_set(ClientFeedback),
        );
    }
}

/// Resolves a requested log level, mapping "clear" to the default filter.
fn resolved_log_filter(level: &str) -> String {
    if level.trim().eq_ignore_ascii_case("clear") {
        TracingTarget::default().filter_str
    } else {
        level.to_string()
    }
}

/// Applies a log level to the subscriber and returns the filter that was applied.
fn apply_log_level(log_config: &LogConfig, level: &str) -> Result<String, LogFilterError> {
    let filter = resolved_log_filter(level);
    log_config.update_target(|target| target.filter_str.clone_from(&filter))?;
    Ok(filter)
}

/// Applies log level and field filter commands and reports each one's outcome.
pub fn handle_log_commands(
    log_config: Res<LogConfig>,
    mut events: MessageReader<CommandEnvelope<LogCommand>>,
    mut responder: CommandResponder,
) {
    for event in events.read() {
        let outcome = match &event.command {
            LogCommand::SetLogLevel(level) => apply_log_level(&log_config, level)
                .map(|applied_filter| {
                    tracing::info!("Log level set to: {} ({})", level, applied_filter);
                })
                .map_err(|error| {
                    (
                        "log.level_failed",
                        format!("Failed to set log level to {level}: {error}"),
                    )
                }),
            LogCommand::SetTracingFilter { field, value } => {
                tracing::debug!(field, value = ?value, "Setting logging filter");
                log_config
                    .update_target(|target| {
                        target.field_matchers.insert(field.clone(), value.clone());
                    })
                    .map_err(|error| {
                        (
                            "log.trace_filter_failed",
                            format!("Failed to apply tracing filter: {error}"),
                        )
                    })
            }
            LogCommand::ClearTracingFilter => {
                tracing::debug!("Clearing logging filter");
                log_config
                    .update_target(|target| target.field_matchers.clear())
                    .map_err(|error| {
                        (
                            "log.trace_filter_failed",
                            format!("Failed to clear tracing filters: {error}"),
                        )
                    })
            }
        };
        report_log_command(&mut responder, event.command_id, outcome);
    }
}

/// Completes a log command, logging and returning a structured error when it failed.
pub fn report_log_command(
    responder: &mut CommandResponder,
    command_id: CommandId,
    outcome: Result<(), (&'static str, String)>,
) {
    let result = match outcome {
        Ok(()) => responder.succeed(command_id),
        Err((code, message)) => {
            tracing::error!("{message}");
            responder.fail(command_id, CommandError::new(code, message))
        }
    };
    if let Err(error) = result {
        tracing::error!(%error, "log_command_completion_failed");
    }
}

/// Echoes log level changes to clients so the UI logger follows `log level ...` commands.
pub fn forward_log_level_commands(
    mut events: MessageReader<CommandEnvelope<LogCommand>>,
    broadcaster: Res<ClientEventSink>,
) {
    for event in events.read() {
        if matches!(event.command, LogCommand::SetLogLevel(_)) {
            tracing::trace!(?event, "Forwarding LogCommand to UI");
            broadcaster.publish(
                DISCRIMINATOR_NON_DROPPABLE,
                &LogWsMessage::LogCommand(&event.command),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use bevy_app::{App, Update};

    use super::*;

    /// Verifies "clear" in any case resolves to the default filter.
    #[test]
    fn resolved_log_filter_clear_uses_default() {
        let expected = TracingTarget::default().filter_str;
        assert_eq!(resolved_log_filter("clear"), expected);
        assert_eq!(resolved_log_filter("CLEAR"), expected);
    }

    /// Verifies a log level replaces the stored base filter.
    #[test]
    fn apply_log_level_updates_filter_string() {
        let tracing_target = Arc::new(RwLock::new(TracingTarget {
            filter_str: "warn".to_string(),
            field_matchers: HashMap::new(),
        }));
        let log_config = LogConfig::new(|_| Ok(()), tracing_target);

        let applied = apply_log_level(&log_config, "nightfall=trace").expect("set log level");
        assert_eq!(applied, "nightfall=trace");
        assert_eq!(log_config.tracing_target().filter_str, "nightfall=trace");
    }

    /// Verifies an invalid level fails without replacing the filter later reloads build from.
    #[test]
    fn invalid_log_level_keeps_previous_filter() {
        let log_config = LogConfig::disconnected();
        apply_log_level(&log_config, "warn").expect("valid level");

        assert!(apply_log_level(&log_config, "nightfall=bogus[").is_err());

        assert_eq!(log_config.tracing_target().filter_str, "warn");
        assert!(log_config.update_target(|_| {}).is_ok());
    }

    /// Verifies a field matcher the directive syntax rejects fails instead of panicking, and is
    /// not kept for later reloads.
    #[test]
    fn invalid_field_matcher_is_rejected_and_not_kept() {
        let log_config = LogConfig::disconnected();

        let result = log_config.update_target(|target| {
            target
                .field_matchers
                .insert("entity".to_string(), Some("{".to_string()));
        });

        assert!(matches!(result, Err(LogFilterError::Parse(_))));
        assert!(log_config.tracing_target().field_matchers.is_empty());
    }

    /// Verifies a directly handled log-level command returns semantic success.
    #[test]
    fn set_log_level_command_returns_success() {
        let mut app = App::new();
        app.insert_resource(LogConfig::disconnected());
        app.init_resource::<CommandTracker>();
        app.add_message::<CommandEnvelope<LogCommand>>();
        app.add_message::<CommandResult>();
        app.add_message::<CommandReply>();
        app.add_message::<FinishedCommand>();
        app.add_message::<CommandNoticeReply>();
        app.add_systems(Update, handle_log_commands);
        let command_id = CommandId::new();
        app.world_mut()
            .resource_mut::<CommandTracker>()
            .register_context(
                command_id,
                command_id.into(),
                CommandOrigin::WebUi,
                ReplyTarget::Detached,
            )
            .expect("log command should register");
        app.world_mut().write_message(CommandEnvelope::with_context(
            command_id,
            command_id.into(),
            CommandOrigin::WebUi,
            ReplyTarget::Detached,
            LogCommand::SetLogLevel("debug".to_string()),
        ));

        app.update();

        let result = app
            .world_mut()
            .resource_mut::<Messages<CommandResult>>()
            .drain()
            .next()
            .expect("log command should finish");
        assert_eq!(result.command_id, command_id);
        assert!(matches!(result.outcome, CommandOutcome::Succeeded { .. }));
    }

    /// Builds an app that echoes log commands into a channel the test reads.
    fn echo_app() -> (App, async_channel::Receiver<OutboundFrame>) {
        let (tx, rx) = async_channel::unbounded::<OutboundFrame>();
        let mut app = App::new();
        app.add_message::<CommandEnvelope<LogCommand>>();
        app.insert_resource(ClientEventSink::new(tx));
        app.add_systems(Update, forward_log_level_commands);
        (app, rx)
    }

    /// Verifies log-level commands are echoed as non-droppable `LogCommand` messages.
    #[test]
    fn forward_log_level_commands_broadcasts_set_log_level() {
        let (mut app, rx) = echo_app();
        app.world_mut().write_message(CommandEnvelope::new(
            LogCommand::SetLogLevel("debug".to_string()),
            CommandOrigin::WebUi,
            ReplyTarget::Detached,
        ));

        app.update();

        let payload = rx
            .try_recv()
            .expect("expected websocket payload for SetLogLevel");
        assert_eq!(
            payload.bytes.first().copied(),
            Some(DISCRIMINATOR_NON_DROPPABLE)
        );
        let payload_text = String::from_utf8_lossy(&payload.bytes);
        for expected in ["LogCommand", "SetLogLevel", "debug"] {
            assert!(
                payload_text.contains(expected),
                "payload did not include {expected}: {payload_text:?}"
            );
        }
    }

    /// Verifies log commands the UI logger does not mirror are not echoed.
    #[test]
    fn forward_log_level_commands_ignores_other_log_commands() {
        let (mut app, rx) = echo_app();
        app.world_mut().write_message(CommandEnvelope::new(
            LogCommand::ClearTracingFilter,
            CommandOrigin::WebUi,
            ReplyTarget::Detached,
        ));

        app.update();

        assert!(
            rx.try_recv().is_err(),
            "non-level log command should not be broadcast"
        );
    }
}
