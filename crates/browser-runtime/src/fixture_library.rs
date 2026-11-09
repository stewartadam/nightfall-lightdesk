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
    GetFixtureProfileResponse, LibraryRevisionDetails, LibraryRevisionMode,
    ListAvailableFixturesResponse, finish_fixture_library_commands, fixture_profile_not_found,
    publish_available_fixtures, publish_fixture_profile, register_fixture_library_commands,
};
use nightfall_fixtures::library::instantiate::{
    LibraryFixtureRequest, LibraryFixtureStore, LibraryFixtureTemplate,
};

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
    mut events: MessageReader<CommandEnvelope<FixtureLibraryCommand>>,
    mut store: LibraryFixtureStore,
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
                    unloadable: Vec::new(),
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
                let request = LibraryFixtureRequest::single(
                    *id,
                    label.as_deref(),
                    update_existing_ids,
                    *update_existing_only,
                );
                store
                    .create(event.command_id, event.undo_id, &request, || {
                        builtin_template(make, model, asset_etag.as_deref(), mode)
                    })
                    .map(|()| FixtureLibraryCommandSuccess::Applied)
            }
            FixtureLibraryCommand::CreateFixturesFromLibrary {
                make,
                model,
                mode,
                asset_etag,
                fixtures: instances,
                update_existing_ids,
            } => {
                let request = LibraryFixtureRequest {
                    instances: instances.clone(),
                    update_existing_ids,
                };
                store
                    .create(event.command_id, event.undo_id, &request, || {
                        builtin_template(make, model, asset_etag.as_deref(), mode)
                    })
                    .map(|()| FixtureLibraryCommandSuccess::Applied)
            }
            FixtureLibraryCommand::GetRevisionDetails {
                make,
                model,
                asset_etag,
            } => builtin_revision_details(make, model, asset_etag)
                .map(FixtureLibraryCommandSuccess::RevisionDetails),
            FixtureLibraryCommand::UpdateFixturesToRevision {
                make,
                model,
                asset_etag,
                fixtures: updates,
            } => store
                .update_to_revision(event.command_id, event.undo_id, updates, |mode| {
                    builtin_template(make, model, Some(asset_etag), mode)
                })
                .map(|()| FixtureLibraryCommandSuccess::Applied),
            FixtureLibraryCommand::UploadFixture { .. }
            | FixtureLibraryCommand::DeleteFixtures(_)
            | FixtureLibraryCommand::DeleteUnloadableFiles(_) => {
                Err(library_management_unavailable())
            }
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
    let requested_mode = mode.unwrap_or(profile.default_mode());
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

/// Describes a built-in revision for an update review: every mode with the fixture it
/// builds, and no revision notes, since built-ins have none.
fn builtin_revision_details(
    make: &str,
    model: &str,
    revision: &str,
) -> Result<LibraryRevisionDetails, CommandError> {
    let profile = find_builtin_revision(make, model, Some(revision))?;
    let modes = profile
        .mode_names()
        .into_iter()
        .map(|name| {
            let fixture = profile.create_fixture(0, &name);
            let error = fixture
                .is_none()
                .then(|| mode_not_found(make, model, &name));
            LibraryRevisionMode {
                name,
                fixture,
                error,
            }
        })
        .collect();
    Ok(LibraryRevisionDetails {
        modes,
        revision_notes: Vec::new(),
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
) -> Result<LibraryFixtureTemplate, CommandError> {
    let profile = find_builtin_revision(make, model, revision)?;
    let fixture = profile.create_fixture(0, mode).ok_or_else(|| {
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
        run_command(engine, "FixtureLibraryCommand", command)
    }

    /// Submits one client command of `module` and returns every publication from the next
    /// frames.
    fn run_command(
        engine: &mut crate::BrowserEngine,
        module: &str,
        command: Value,
    ) -> (Uuid, Vec<Value>) {
        let command_id = Uuid::new_v4();
        let envelope = serde_json::from_value(json!({
            "command_id": command_id,
            "module": module,
            "command": command,
        }))
        .expect("command envelope should deserialize");
        engine
            .enqueue_command_core(envelope)
            .expect("command should enqueue");
        engine.tick_core(16.0);
        engine.tick_core(16.0);
        let messages = engine
            .drain_output_core()
            .iter()
            .filter_map(|bytes| decode_publication(bytes))
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

    /// Returns the outcome type (`Succeeded`, `Failed`, …) of one command's result.
    fn outcome_type(messages: &[Value], command_id: Uuid) -> Value {
        command_result(messages, command_id)
            .pointer("/data/outcome/type")
            .cloned()
            .unwrap_or(Value::Null)
    }

    /// Returns the stored fixture with this ID.
    fn stored_fixture(
        engine: &crate::BrowserEngine,
        id: u32,
    ) -> nightfall_fixtures::prelude::Fixture {
        engine
            .app
            .world()
            .resource::<nightfall_fixtures::prelude::FixtureDataProviderExt>()
            .inner
            .from_id(id)
            .expect("fixture should be stored")
            .clone()
    }

    /// Verifies moving a fixture to another revision keeps its identity, and that undo puts
    /// the previous revision back and redo moves it forward again, each as one step.
    #[test]
    fn update_fixtures_to_revision_undoes_and_redoes_as_one_step() {
        let mut engine = sample_engine();
        for id in [901, 902] {
            let (created, messages) = run_fixture_library_command(
                &mut engine,
                json!({
                    "type": "CreateFixtureFromLibrary",
                    "data": {
                        "id": id,
                        "make": "Generic",
                        "model": "Moving Head Spot 16ch",
                        "mode": "Spot"
                    }
                }),
            );
            assert_eq!(outcome_type(&messages, created), json!("Succeeded"));
        }
        let current = stored_fixture(&engine, 901)
            .library_asset_etag
            .expect("library fixtures record their revision");
        {
            let world = engine.app.world_mut();
            let mut fixtures =
                world.resource_mut::<nightfall_fixtures::prelude::FixtureDataProviderExt>();
            for id in [901, 902] {
                let mut fixture = fixtures.inner.from_id(id).unwrap().clone();
                fixture.library_asset_etag = Some("builtin:older-revision".to_string());
                fixtures.inner.remove(&fixture.identifiers.uid).unwrap();
                fixtures.inner.add(fixture).unwrap();
            }
        }
        let uid = stored_fixture(&engine, 901).identifiers.uid;

        let (partial, messages) = run_fixture_library_command(
            &mut engine,
            json!({
                "type": "UpdateFixturesToRevision",
                "data": {
                    "make": "Generic",
                    "model": "Moving Head Spot 16ch",
                    "asset_etag": current,
                    "fixtures": [{ "id": 901, "mode": "Spot" }]
                }
            }),
        );
        assert_eq!(
            command_result(&messages, partial).pointer("/data/outcome/data/code"),
            Some(&json!("fixture_library.mixed_revisions")),
            "leaving fixture 902 on the older revision must be rejected"
        );

        let (updated, messages) = run_fixture_library_command(
            &mut engine,
            json!({
                "type": "UpdateFixturesToRevision",
                "data": {
                    "make": "Generic",
                    "model": "Moving Head Spot 16ch",
                    "asset_etag": current,
                    "fixtures": [
                        { "id": 901, "mode": "Spot" },
                        { "id": 902, "mode": "Spot" }
                    ]
                }
            }),
        );
        assert_eq!(outcome_type(&messages, updated), json!("Succeeded"));
        let fixture = stored_fixture(&engine, 901);
        assert_eq!(fixture.identifiers.uid, uid);
        assert_eq!(
            fixture.library_asset_etag.as_deref(),
            Some(current.as_str())
        );

        let (undo, messages) = run_command(
            &mut engine,
            "UndoCommand",
            json!({ "type": "Undo", "data": {} }),
        );
        assert_eq!(
            outcome_type(&messages, undo),
            json!("Succeeded"),
            "{:#?}",
            command_result(&messages, undo)
        );
        for id in [901, 902] {
            assert_eq!(
                stored_fixture(&engine, id).library_asset_etag.as_deref(),
                Some("builtin:older-revision"),
                "one undo should restore fixture {id}"
            );
        }
        assert_eq!(stored_fixture(&engine, 901).identifiers.uid, uid);

        let (redo, messages) = run_command(
            &mut engine,
            "UndoCommand",
            json!({ "type": "Redo", "data": {} }),
        );
        assert_eq!(outcome_type(&messages, redo), json!("Succeeded"));
        for id in [901, 902] {
            assert_eq!(
                stored_fixture(&engine, id).library_asset_etag.as_deref(),
                Some(current.as_str()),
                "redo should move fixture {id} forward again"
            );
        }
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
