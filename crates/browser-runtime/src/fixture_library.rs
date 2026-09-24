// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Built-in-only fixture library served by the embedded browser runtime.
//!
//! The browser demo has no filesystem, so it cannot scan or import GDTF/OFL files.
//! It still answers the shared fixture-library commands from the compiled built-in
//! catalog so the patch wizard can list and create those profiles.

use bevy_app::prelude::*;
use bevy_ecs::prelude::*;
use nightfall_engine::prelude::*;
use nightfall_fixtures::library::catalog::{
    BuiltinFixtureProfile, builtin_fixture_profiles, find_builtin_fixture_profile,
};
use nightfall_fixtures::library::commands::{
    FixtureLibraryCommand, FixtureLibraryCommandResult, FixtureLibraryCommandSuccess,
    GetFixtureProfileResponse, ListAvailableFixturesResponse, finish_fixture_library_commands,
    fixture_profile_not_found, publish_available_fixtures, publish_fixture_profile,
    register_fixture_library_commands,
};
use nightfall_fixtures::library::instantiate::{
    LibraryFixtureRequest, LibraryFixtureTemplate, create_library_fixture,
};
use nightfall_fixtures::prelude::FixtureDataProviderExt;

/// Serves fixture-library commands from the compiled built-in catalog.
///
/// Must be added after `EnginePlugin` and `FixturePlugin`, whose registries and
/// fixture store it builds on.
pub struct BuiltinFixtureLibraryPlugin;

impl Plugin for BuiltinFixtureLibraryPlugin {
    /// Registers the shared command contract and the built-in command handlers.
    fn build(&self, app: &mut App) {
        register_fixture_library_commands(app);
        app.add_systems(
            Update,
            (
                handle_builtin_fixture_library_commands,
                finish_fixture_library_commands,
            )
                .chain()
                .in_set(EventHandling),
        );
    }
}

/// Applies fixture-library commands against the built-in catalog and records each outcome.
pub fn handle_builtin_fixture_library_commands(
    mut commands: Commands,
    mut events: MessageReader<CommandEnvelope<FixtureLibraryCommand>>,
    mut fixtures: ResMut<FixtureDataProviderExt>,
    broadcaster: Res<ClientEventSink>,
    mut results: MessageWriter<FixtureLibraryCommandResult>,
) {
    for event in events.read() {
        let result = match &event.command {
            FixtureLibraryCommand::ListAvailableFixtures => {
                let response = ListAvailableFixturesResponse {
                    fixtures: builtin_fixture_profiles()
                        .iter()
                        .map(|profile| profile.info())
                        .collect(),
                };
                publish_available_fixtures(&broadcaster, &response);
                Ok(FixtureLibraryCommandSuccess::AvailableFixtures(response))
            }
            FixtureLibraryCommand::GetFixtureProfile {
                make,
                model,
                mode,
                asset_etag,
            } => builtin_fixture_profile(make, model, asset_etag.as_deref(), mode.as_deref()).map(
                |response| {
                    publish_fixture_profile(&broadcaster, &response);
                    FixtureLibraryCommandSuccess::FixtureProfile(Box::new(response))
                },
            ),
            FixtureLibraryCommand::RefreshLibrary => Ok(FixtureLibraryCommandSuccess::Applied),
            FixtureLibraryCommand::CreateFixtureFromLibrary {
                id,
                make,
                model,
                mode,
                asset_etag,
                label,
                update_existing_ids,
                update_existing_only,
            } => {
                let request = LibraryFixtureRequest {
                    id: *id,
                    label: label.as_deref(),
                    update_existing_ids,
                    update_existing_only: *update_existing_only,
                };
                create_library_fixture(&mut commands, &mut fixtures, request, || {
                    builtin_template(make, model, asset_etag.as_deref(), mode, *id)
                })
                .map(|()| FixtureLibraryCommandSuccess::Applied)
            }
            FixtureLibraryCommand::UploadFixture { .. }
            | FixtureLibraryCommand::DeleteFixtures(_) => Err(library_management_unavailable()),
        };
        results.write(FixtureLibraryCommandResult::new(event.command_id, result));
    }
}

/// Resolves one built-in profile and its preview fixture for the requested or default mode.
///
/// Failures use the native library's codes: an unknown profile reports
/// `fixture_library.not_found` and an unoffered mode `fixture_library.profile_failed`.
fn builtin_fixture_profile(
    make: &str,
    model: &str,
    revision: Option<&str>,
    mode: Option<&str>,
) -> Result<GetFixtureProfileResponse, CommandError> {
    let profile = find_builtin_revision(make, model, revision)?;
    let requested_mode = mode.unwrap_or(profile.mode);
    let fixture = profile.create_fixture(0, requested_mode).ok_or_else(|| {
        CommandError::new(
            "fixture_library.profile_failed",
            format!(
                "Failed to load fixture profile: {}",
                mode_not_found(make, model, requested_mode)
            ),
        )
    })?;
    Ok(GetFixtureProfileResponse {
        info: profile.info(),
        requested_mode: Some(requested_mode.to_string()),
        fixture: Some(fixture),
        geometry: None,
    })
}

/// Instantiates the fixture template for one built-in creation request.
///
/// Failures use the native library's codes: an unknown profile reports
/// `fixture_library.not_found` and an unoffered mode `fixture_library.create_failed`.
fn builtin_template(
    make: &str,
    model: &str,
    revision: Option<&str>,
    mode: &str,
    id: u32,
) -> Result<LibraryFixtureTemplate, CommandError> {
    let profile = find_builtin_revision(make, model, revision)?;
    let fixture = profile.create_fixture(id, mode).ok_or_else(|| {
        CommandError::new(
            "fixture_library.create_failed",
            format!(
                "Failed to create fixture: {}",
                mode_not_found(make, model, mode)
            ),
        )
    })?;
    Ok(LibraryFixtureTemplate {
        fixture,
        asset_etag: profile.asset_etag.to_string(),
    })
}

/// Finds a built-in profile, matching the requested library revision when one is given.
///
/// Each built-in has a single revision, so naming any other revision reports
/// `fixture_library.not_found` just as the native library does for a missing revision.
fn find_builtin_revision(
    make: &str,
    model: &str,
    revision: Option<&str>,
) -> Result<&'static BuiltinFixtureProfile, CommandError> {
    find_builtin_fixture_profile(make, model)
        .filter(|profile| revision.is_none_or(|revision| revision == profile.asset_etag))
        .ok_or_else(|| fixture_profile_not_found(make, model))
}

/// Describes a mode the built-in profile does not offer, worded like the native library error.
fn mode_not_found(make: &str, model: &str, mode: &str) -> String {
    format!("Mode '{mode}' not found for {make} {model}")
}

/// Builds the failure reported for library file management the browser cannot host.
fn library_management_unavailable() -> CommandError {
    CommandError::new(
        "fixture_library.unavailable",
        "Fixture library import and deletion are unavailable in the browser demo",
    )
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};
    use uuid::Uuid;

    use crate::tests::{decode_publication, sample_engine};

    /// Submits one fixture-library command and returns every publication from the next frames.
    fn run_fixture_library_command(
        engine: &mut crate::BrowserEngine,
        command: Value,
    ) -> (Uuid, Vec<Value>) {
        let command_id = Uuid::new_v4();
        let envelope = serde_json::from_value(json!({
            "command_id": command_id,
            "module": "FixtureLibraryCommand",
            "command": command,
        }))
        .expect("fixture-library envelope should deserialize");
        engine
            .enqueue_command_core(envelope)
            .expect("fixture-library command should enqueue");
        engine.tick_core(16.0);
        engine.tick_core(16.0);
        let messages = engine
            .drain_output_core()
            .iter()
            .map(|bytes| decode_publication(bytes))
            .collect();
        (command_id, messages)
    }

    /// Returns the terminal command-result publication for one command.
    fn command_result(messages: &[Value], command_id: Uuid) -> &Value {
        let command_id = command_id.simple().to_string();
        messages
            .iter()
            .find(|message| {
                message["type"] == "CommandResult"
                    && message.pointer("/data/command_id").and_then(Value::as_str)
                        == Some(command_id.as_str())
            })
            .unwrap_or_else(|| panic!("missing command result in {messages:#?}"))
    }

    /// Verifies the browser runtime lists all compiled built-ins with their source label.
    #[test]
    fn list_available_fixtures_publishes_builtin_catalog() {
        let mut engine = sample_engine();
        let (command_id, messages) =
            run_fixture_library_command(&mut engine, json!({ "type": "ListAvailableFixtures" }));

        let listing = messages
            .iter()
            .find(|message| message["type"] == "ListAvailableFixturesResponse")
            .expect("listing should be broadcast");
        let fixtures = listing["data"]["fixtures"]
            .as_array()
            .expect("listing should contain fixtures");
        assert_eq!(fixtures.len(), 12);
        assert!(
            fixtures
                .iter()
                .all(|fixture| fixture["source_format"] == "Built-in")
        );
        assert!(
            fixtures
                .iter()
                .any(|fixture| fixture["model"] == "Moving Head Spot 16ch")
        );
        let result = command_result(&messages, command_id);
        assert_eq!(
            result.pointer("/data/outcome/type"),
            Some(&json!("Succeeded"))
        );
    }

    /// Verifies profile previews resolve the default mode for built-ins.
    #[test]
    fn get_fixture_profile_returns_builtin_preview() {
        let mut engine = sample_engine();
        let (_, messages) = run_fixture_library_command(
            &mut engine,
            json!({
                "type": "GetFixtureProfile",
                "data": { "make": "Generic", "model": "Moving Head Spot 16ch" }
            }),
        );

        let profile = messages
            .iter()
            .find(|message| message["type"] == "GetFixtureProfileResponse")
            .expect("profile should be broadcast");
        assert_eq!(profile["data"]["requested_mode"], "Spot");
        assert_eq!(profile["data"]["fixture"]["mode"], "Spot");
        assert_eq!(profile["data"]["info"]["source_format"], "Built-in");
    }

    /// Verifies an unoffered preview mode fails with the native library's profile error code.
    #[test]
    fn get_fixture_profile_unknown_mode_reports_profile_failure() {
        let mut engine = sample_engine();
        let (command_id, messages) = run_fixture_library_command(
            &mut engine,
            json!({
                "type": "GetFixtureProfile",
                "data": {
                    "make": "Generic",
                    "model": "Moving Head Spot 16ch",
                    "mode": "Not A Mode"
                }
            }),
        );

        let result = command_result(&messages, command_id);
        assert_eq!(
            result.pointer("/data/outcome/data/code"),
            Some(&json!("fixture_library.profile_failed")),
            "{result:#?}"
        );
        assert!(
            messages
                .iter()
                .all(|message| message["type"] != "GetFixtureProfileResponse"),
            "failed lookups must not broadcast a profile"
        );
    }

    /// Verifies creating with an unoffered mode fails with the native creation error code.
    #[test]
    fn create_fixture_from_library_unknown_mode_reports_create_failure() {
        let mut engine = sample_engine();
        let (command_id, messages) = run_fixture_library_command(
            &mut engine,
            json!({
                "type": "CreateFixtureFromLibrary",
                "data": {
                    "id": 902,
                    "make": "Generic",
                    "model": "Moving Head Spot 16ch",
                    "mode": "Not A Mode"
                }
            }),
        );

        let result = command_result(&messages, command_id);
        assert_eq!(
            result.pointer("/data/outcome/data/code"),
            Some(&json!("fixture_library.create_failed")),
            "{result:#?}"
        );
        let fixtures = engine
            .app
            .world()
            .resource::<nightfall_fixtures::prelude::FixtureDataProviderExt>();
        assert!(fixtures.inner.from_id(902).is_err());
    }

    /// Verifies a created built-in is stored, broadcast, and indexed with live parameters.
    #[test]
    fn create_fixture_from_library_spawns_parameters() {
        let mut engine = sample_engine();
        let (command_id, messages) = run_fixture_library_command(
            &mut engine,
            json!({
                "type": "CreateFixtureFromLibrary",
                "data": {
                    "id": 901,
                    "make": "Generic",
                    "model": "Moving Head Spot 16ch",
                    "mode": "Spot",
                    "label": "Demo Spot"
                }
            }),
        );

        let result = command_result(&messages, command_id);
        assert_eq!(
            result.pointer("/data/outcome/type"),
            Some(&json!("Succeeded")),
            "{result:#?}"
        );
        let world = engine.app.world();
        let fixtures = world.resource::<nightfall_fixtures::prelude::FixtureDataProviderExt>();
        let fixture = fixtures
            .inner
            .from_id(901)
            .expect("created fixture should be stored")
            .clone();
        assert_eq!(fixture.identifiers.label, "Demo Spot");
        let parameters = fixtures.parameter_entities_for_fixture(fixture.identifiers.uid);
        let expected = fixture
            .elements
            .iter()
            .map(|element| element.parameters.len())
            .sum::<usize>();
        assert_eq!(parameters.len(), expected);
        assert!(parameters.iter().all(|parameter| {
            world
                .get::<nightfall_fixtures::prelude::Parameter>(parameter.entity())
                .is_some()
        }));
    }

    /// Verifies library file management reports a stable unavailable failure.
    #[test]
    fn upload_fixture_is_unavailable() {
        let mut engine = sample_engine();
        let (command_id, messages) = run_fixture_library_command(
            &mut engine,
            json!({
                "type": "UploadFixture",
                "data": { "filename": "fixture.gdtf", "content": [] }
            }),
        );

        let result = command_result(&messages, command_id);
        assert_eq!(
            result.pointer("/data/outcome/data/code"),
            Some(&json!("fixture_library.unavailable")),
            "{result:#?}"
        );
    }
}
