// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Fixture and fixture element color path default commands.

use super::*;

/// Applies one color path default command, broadcasting the updated defaults on success.
///
/// A referenced color path must exist; `None` clears the default.
pub(super) fn handle_command(
    context: &mut FixtureCrudContext,
    event: &CommandEnvelope<FixtureCommand>,
) {
    let command_id = event.command_id;
    match &event.command {
        FixtureCommand::SetColorPathDefault {
            fixture,
            color_path_id,
        } => {
            if !accept_color_path_id(context, command_id, *color_path_id) {
                return;
            }
            set_color_path_default(context, command_id, fixture.clone(), *color_path_id);
        }

        FixtureCommand::SetColorPathDefaultById {
            id,
            element_index,
            color_path_id,
        } => {
            if !accept_color_path_id(context, command_id, *color_path_id) {
                return;
            }
            let fixture = match resolve_color_path_default_fixture_ref(
                &context.fixture_data_provider,
                *id,
                *element_index,
            ) {
                Ok(fixture) => fixture,
                Err(message) => {
                    tracing::warn!("{}", message);
                    fail_fixture_command(
                        &mut context.responder,
                        command_id,
                        "fixture.color_path_target_invalid",
                        message,
                    );
                    return;
                }
            };
            set_color_path_default(context, command_id, fixture, *color_path_id);
        }

        _ => {}
    }
}

/// Fails the command and returns `false` when the referenced color path does not exist.
fn accept_color_path_id(
    context: &mut FixtureCrudContext,
    command_id: CommandId,
    color_path_id: Option<ColorPathId>,
) -> bool {
    if let Err(message) = validate_color_path_id(context.color_paths.as_ref(), color_path_id) {
        tracing::warn!("{}", message);
        fail_fixture_command(
            &mut context.responder,
            command_id,
            "fixture.color_path_invalid",
            message,
        );
        return false;
    }
    true
}

/// Stores a color path default for a fixture or element and broadcasts every default.
fn set_color_path_default(
    context: &mut FixtureCrudContext,
    command_id: CommandId,
    fixture: FixtureRef,
    color_path_id: Option<ColorPathId>,
) {
    context
        .fixture_data_provider
        .set_color_path_default(fixture, color_path_id);
    send_color_path_defaults(&context.fixture_data_provider, &context.broadcaster);
    succeed_fixture_command(&mut context.responder, command_id);
}

/// Verifies that an assigned color path exists when the command references one.
fn validate_color_path_id(
    color_paths: Option<&Res<DataProvider<ColorPath>>>,
    color_path_id: Option<ColorPathId>,
) -> Result<(), String> {
    let Some(color_path_id) = color_path_id else {
        return Ok(());
    };
    let Some(color_paths) = color_paths else {
        return Err(
            "Failed to set fixture color path default: color path provider unavailable".to_string(),
        );
    };
    if color_paths.from_id(color_path_id.0).is_err() {
        return Err(format!(
            "Failed to set fixture color path default: color path {} not found",
            color_path_id.0
        ));
    }
    Ok(())
}

/// Resolves a fixture or fixture element color-path default target from operator-facing IDs.
pub(super) fn resolve_color_path_default_fixture_ref(
    fixture_data_provider: &FixtureDataProviderExt,
    id: u32,
    element_index: Option<u32>,
) -> Result<FixtureRef, String> {
    let fixture = fixture_data_provider.inner.from_id(id).map_err(|_| {
        format!(
            "Failed to set fixture color path default: fixture {} not found",
            id
        )
    })?;

    if let Some(element_index) = element_index {
        let element_count = fixture.elements.len() as u32;
        if element_index == 0 || element_index > element_count {
            return Err(format!(
                "Failed to set fixture color path default: fixture {} element {} not found",
                id, element_index
            ));
        }
    }

    Ok(FixtureRef {
        fixture_uid: fixture.identifiers.uid,
        index: element_index,
    })
}
