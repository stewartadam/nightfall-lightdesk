// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::path::Path;

use bevy_ecs::prelude::*;
use nightfall::{constants::SHOW_DATA_DIR, prelude::*};
use nightfall_engine::prelude::*;
use nightfall_fixtures::prelude::*;

use crate::{
    prelude::*,
    resources::log_config::{LogConfig, TracingTarget},
};

/// Truncates a file in-place.
fn truncate_file(filename: &str) {
    // Truncate must be done separately if we want append:
    // https://github.com/rust-lang/rust/issues/34347
    std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(filename)
        .unwrap_or_else(|error| {
            panic!("failed to create or truncate file {}: {}", filename, error)
        });
}

/// Writes JSON string to a file
pub fn write_json_to_file(object_type: &str, target_id: u32, json: &str) {
    let path = Path::new(SHOW_DATA_DIR).join(format!("{}-{}.json", object_type, target_id));
    let filename = path // TODO: customizable filenames
        .to_str()
        .expect("failed to obtain filename as string");
    truncate_file(filename);

    let mut showfile = std::fs::OpenOptions::new()
        .append(true)
        .open(filename)
        .expect("failed to open showfile");

    use std::io::Write as _;
    showfile
        .write_all(json.as_bytes())
        .unwrap_or_else(|error| panic!("failed to write to showfile {}: {}", filename, error));

    tracing::debug!(
        "Wrote JSON for {} {} to file {}",
        object_type,
        target_id,
        filename
    );
}

fn resolved_log_filter(level: &str) -> String {
    if level.trim().eq_ignore_ascii_case("clear") {
        TracingTarget::default().filter_str
    } else {
        level.to_string()
    }
}

fn apply_log_level(
    log_config: &LogConfig,
    level: &str,
) -> Result<String, Box<dyn std::error::Error + Send + Sync + 'static>> {
    let filter = resolved_log_filter(level);
    log_config.reload_env(Some(&filter))?;
    Ok(filter)
}

pub fn handle_events(
    log_config: ResMut<LogConfig>,
    data_provider: ResMut<FixtureDataProviderExt>,
    mut events: MessageReader<CommandEnvelope<DeskCommand>>,
    mut responder: CommandResponder,
) {
    for event in events.read() {
        match &event.command {
            DeskCommand::SetLogLevel(level) => match apply_log_level(&log_config, level) {
                Ok(applied_filter) => {
                    tracing::info!("Log level set to: {} ({})", level, applied_filter);
                    succeed_debug_command(&mut responder, event.command_id);
                }
                Err(error) => fail_debug_command(
                    &mut responder,
                    event.command_id,
                    "desk.log_level_failed",
                    format!("Failed to set log level to {level}: {error}"),
                ),
            },
            DeskCommand::TraceFixture {
                fixture_ref,
                attribute,
            } => {
                let fixture = match data_provider.inner.from_id(fixture_ref.fixture_id) {
                    Ok(f) => f,
                    Err(_) => {
                        tracing::warn!("Fixture {} not found", fixture_ref.fixture_id);
                        fail_debug_command(
                            &mut responder,
                            event.command_id,
                            "desk.trace_fixture_not_found",
                            format!("Fixture {} not found", fixture_ref.fixture_id),
                        );
                        continue;
                    }
                };
                let element_index = match fixture_ref.element_index {
                    Some(idx) => idx,
                    None => {
                        // Default to element 1 if no element index specified
                        if fixture.elements.is_empty() {
                            tracing::warn!("Fixture {} has no elements", fixture_ref.fixture_id);
                            fail_debug_command(
                                &mut responder,
                                event.command_id,
                                "desk.trace_fixture_has_no_elements",
                                format!("Fixture {} has no elements", fixture_ref.fixture_id),
                            );
                            continue;
                        }
                        1
                    }
                };
                let element_ref = FixtureRef {
                    fixture_uid: fixture.identifiers.uid,
                    index: Some(element_index),
                };
                let parameter = match data_provider
                    .try_parameter_for_logical_attribute(&element_ref, attribute)
                {
                    Some(resolved_parameter) => resolved_parameter.instance,
                    None => {
                        tracing::warn!(
                            fixture_id = fixture_ref.fixture_id,
                            element_index,
                            ?attribute,
                            "Fixture element does not have attribute"
                        );
                        fail_debug_command(
                            &mut responder,
                            event.command_id,
                            "desk.trace_attribute_not_found",
                            format!(
                                "Fixture {} element {} does not have attribute {:?}",
                                fixture_ref.fixture_id, element_index, attribute
                            ),
                        );
                        continue;
                    }
                };
                log_config.tracing_target_mut().field_matchers.insert(
                    "entity".to_string(),
                    Some(format!("{}", parameter.entity())),
                );
                match log_config.reload_env(None) {
                    Ok(()) => succeed_debug_command(&mut responder, event.command_id),
                    Err(error) => fail_debug_command(
                        &mut responder,
                        event.command_id,
                        "desk.trace_filter_failed",
                        format!("Failed to apply fixture trace filter: {error}"),
                    ),
                }
            }
            DeskCommand::SetTracingFilter { field, value } => {
                tracing::debug!(field, value = ?value, "Setting logging filter");
                log_config
                    .tracing_target_mut()
                    .field_matchers
                    .insert(field.clone(), value.clone());
                match log_config.reload_env(None) {
                    Ok(()) => succeed_debug_command(&mut responder, event.command_id),
                    Err(error) => fail_debug_command(
                        &mut responder,
                        event.command_id,
                        "desk.trace_filter_failed",
                        format!("Failed to apply tracing filter: {error}"),
                    ),
                }
            }
            DeskCommand::ClearTracingFilter => {
                tracing::debug!("Clearing logging filter");
                log_config.tracing_target_mut().field_matchers.clear();
                match log_config.reload_env(None) {
                    Ok(()) => succeed_debug_command(&mut responder, event.command_id),
                    Err(error) => fail_debug_command(
                        &mut responder,
                        event.command_id,
                        "desk.trace_filter_failed",
                        format!("Failed to clear tracing filters: {error}"),
                    ),
                }
            }
            _ => {}
        }
    }
}

/// Reports successful completion for a directly handled debug command.
fn succeed_debug_command(responder: &mut CommandResponder, command_id: CommandId) {
    if let Err(error) = responder.succeed(command_id) {
        tracing::error!(%error, "debug_command_completion_failed");
    }
}

/// Reports a structured failure for a directly handled debug command.
fn fail_debug_command(
    responder: &mut CommandResponder,
    command_id: CommandId,
    code: &'static str,
    message: String,
) {
    tracing::error!("{message}");
    if let Err(error) = responder.fail(command_id, CommandError::new(code, message)) {
        tracing::error!(%error, "debug_command_failure_failed");
    }
}

#[cfg(test)]
mod tests {
    use std::{
        collections::HashMap,
        sync::{Arc, RwLock},
    };

    use bevy_app::{App, Update};

    use super::*;

    #[test]
    fn resolved_log_filter_clear_uses_default() {
        let expected = TracingTarget::default().filter_str;
        assert_eq!(resolved_log_filter("clear"), expected);
        assert_eq!(resolved_log_filter("CLEAR"), expected);
    }

    #[test]
    fn apply_log_level_updates_filter_string() {
        let tracing_target = Arc::new(RwLock::new(TracingTarget {
            filter_str: "warn".to_string(),
            field_matchers: HashMap::new(),
        }));
        let log_config = LogConfig::new(|_| Ok(()), tracing_target);

        let applied = apply_log_level(&log_config, "nightfall=trace").expect("set log level");
        assert_eq!(applied, "nightfall=trace");
        assert_eq!(
            log_config.tracing_target_mut().filter_str,
            "nightfall=trace"
        );
    }

    /// Verifies a directly handled log-level command returns semantic success.
    #[test]
    fn set_log_level_command_returns_success() {
        let tracing_target = Arc::new(RwLock::new(TracingTarget::default()));
        let mut app = App::new();
        app.insert_resource(LogConfig::new(|_| Ok(()), tracing_target));
        app.insert_resource(FixtureDataProviderExt::default());
        app.init_resource::<CommandTracker>();
        app.add_message::<CommandEnvelope<DeskCommand>>();
        app.add_message::<CommandResult>();
        app.add_message::<CommandReply>();
        app.add_message::<FinishedCommand>();
        app.add_message::<CommandNotice>();
        app.add_systems(Update, handle_events);
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
            DeskCommand::SetLogLevel("debug".to_string()),
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
}
