// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! WebSocket integration and semantic outcomes for fixture-library commands.

use bevy_ecs::prelude::*;
use nightfall_engine::prelude::*;
use nightfall_fixtures::library::catalog::BUILTIN_SOURCE_FORMAT;
use nightfall_fixtures::library::commands::{
    FixtureLibraryCommandResult, FixtureLibraryCommandSuccess, fixture_profile_not_found,
    publish_available_fixtures, publish_fixture_profile,
};
use nightfall_fixtures::library::instantiate::{
    LibraryFixtureRequest, LibraryFixtureTemplate, create_library_fixture,
};
use nightfall_fixtures::prelude::FixtureDataProviderExt;

use crate::commands::{
    AvailableFixtureInfo, FixtureLibraryCommand, FixtureLibraryEntry, GetFixtureProfileResponse,
    ListAvailableFixturesResponse,
};
use crate::manager::{
    FixtureLibraryManager, FixtureProfile, FixtureSource, fixture_source_version,
};
use crate::watcher::FixtureLibraryEvent;

/// Applies fixture-library commands and emits one domain-local result per request.
pub fn handle_fixture_library_commands(
    mut commands: Commands,
    mut events: MessageReader<CommandEnvelope<FixtureLibraryCommand>>,
    mut library: ResMut<FixtureLibraryManager>,
    mut fixtures: ResMut<FixtureDataProviderExt>,
    broadcaster: Res<ClientEventSink>,
    mut results: MessageWriter<FixtureLibraryCommandResult>,
) {
    for event in events.read() {
        let result = match &event.command {
            FixtureLibraryCommand::ListAvailableFixtures => {
                list_available_fixtures(&library, &broadcaster)
                    .map(FixtureLibraryCommandSuccess::AvailableFixtures)
            }
            FixtureLibraryCommand::GetFixtureProfile { make, model, mode } => {
                get_fixture_profile(&library, make, model, mode.as_deref(), &broadcaster)
                    .map(Box::new)
                    .map(FixtureLibraryCommandSuccess::FixtureProfile)
            }
            FixtureLibraryCommand::RefreshLibrary => refresh_library(&mut library),
            FixtureLibraryCommand::CreateFixtureFromLibrary {
                id,
                make,
                model,
                mode,
                label,
                update_existing_ids,
                update_existing_only,
            } => create_fixture_from_library(
                &mut commands,
                &library,
                &mut fixtures,
                *id,
                make,
                model,
                mode,
                label.as_deref(),
                update_existing_ids,
                *update_existing_only,
            ),
            FixtureLibraryCommand::UploadFixture { filename, content } => {
                upload_fixture(&library, filename, content)
            }
            FixtureLibraryCommand::DeleteFixtures(entries) => {
                delete_fixtures(&mut library, entries)
            }
        };
        results.write(FixtureLibraryCommandResult::new(event.command_id, result));
    }
}

/// Builds and publishes the current list of available fixture profiles.
fn list_available_fixtures(
    library: &FixtureLibraryManager,
    broadcaster: &ClientEventSink,
) -> Result<ListAvailableFixturesResponse, CommandError> {
    let fixtures = library
        .list_fixtures()
        .into_iter()
        .map(available_fixture_info)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| {
            CommandError::new(
                "fixture_library.metadata_failed",
                format!("Failed to load fixture metadata: {error}"),
            )
        })?;
    let response = ListAvailableFixturesResponse { fixtures };
    publish_available_fixtures(broadcaster, &response);
    Ok(response)
}

/// Builds and publishes one requested fixture profile and optional preview fixture.
fn get_fixture_profile(
    library: &FixtureLibraryManager,
    make: &str,
    model: &str,
    mode: Option<&str>,
    broadcaster: &ClientEventSink,
) -> Result<GetFixtureProfileResponse, CommandError> {
    let profile = library
        .find_fixture(make, model)
        .ok_or_else(|| fixture_profile_not_found(make, model))?;
    let info = available_fixture_info(profile).map_err(|error| {
        CommandError::new(
            "fixture_library.metadata_failed",
            format!("Failed to load fixture metadata: {error}"),
        )
    })?;
    let modes = profile.mode_names();
    let requested_mode = mode.map(str::to_string).or_else(|| modes.first().cloned());
    let (fixture, geometry) = match requested_mode.as_ref() {
        Some(mode) => library
            .create_fixture(make, model, mode, 0)
            .map(|(fixture, geometry)| (Some(fixture), geometry))
            .map_err(|error| {
                CommandError::new(
                    "fixture_library.profile_failed",
                    format!("Failed to load fixture profile: {error}"),
                )
            })?,
        None => (None, None),
    };
    let response = GetFixtureProfileResponse {
        info,
        requested_mode,
        fixture,
        geometry,
    };
    publish_fixture_profile(broadcaster, &response);
    Ok(response)
}

/// Rescans the fixture library and reports whether the refreshed index is usable.
fn refresh_library(
    library: &mut FixtureLibraryManager,
) -> Result<FixtureLibraryCommandSuccess, CommandError> {
    library.scan().map_err(|error| {
        CommandError::new(
            "fixture_library.refresh_failed",
            format!("Failed to refresh fixture library: {error}"),
        )
    })?;
    tracing::info!(count = library.fixture_count(), "fixture_library_refreshed");
    Ok(FixtureLibraryCommandSuccess::Applied)
}

/// Stores one uploaded fixture definition in the library directory.
fn upload_fixture(
    library: &FixtureLibraryManager,
    filename: &str,
    content: &[u8],
) -> Result<FixtureLibraryCommandSuccess, CommandError> {
    library.upload_fixture(filename, content).map_err(|error| {
        CommandError::new(
            "fixture_library.upload_failed",
            format!("Failed to upload fixture {filename}: {error}"),
        )
    })?;
    Ok(FixtureLibraryCommandSuccess::Applied)
}

/// Deletes requested fixture profiles and reports every failed entry.
fn delete_fixtures(
    library: &mut FixtureLibraryManager,
    fixtures: &[FixtureLibraryEntry],
) -> Result<FixtureLibraryCommandSuccess, CommandError> {
    let errors = fixtures
        .iter()
        .filter_map(|fixture| {
            library
                .delete_fixture(&fixture.make, &fixture.model)
                .err()
                .map(|error| format!("{} {}: {error}", fixture.make, fixture.model))
        })
        .collect::<Vec<_>>();
    if errors.is_empty() {
        return Ok(FixtureLibraryCommandSuccess::Applied);
    }
    Err(CommandError::new(
        "fixture_library.delete_failed",
        format!("Failed to delete some fixtures: {}", errors.join(", ")),
    )
    .with_details(serde_json::json!({ "errors": errors })))
}

/// Prepares, validates, and commits one fixture creation and its requested updates.
#[allow(clippy::too_many_arguments)]
fn create_fixture_from_library(
    commands: &mut Commands,
    library: &FixtureLibraryManager,
    fixtures: &mut FixtureDataProviderExt,
    id: u32,
    make: &str,
    model: &str,
    mode: &str,
    label: Option<&str>,
    update_existing_ids: &[u32],
    update_existing_only: bool,
) -> Result<FixtureLibraryCommandSuccess, CommandError> {
    let request = LibraryFixtureRequest {
        id,
        label,
        update_existing_ids,
        update_existing_only,
    };
    create_library_fixture(commands, fixtures, request, || {
        let profile = library
            .find_fixture(make, model)
            .ok_or_else(|| fixture_profile_not_found(make, model))?;
        let asset_etag = fixture_profile_asset_etag(profile).map_err(|error| {
            CommandError::new(
                "fixture_library.fingerprint_failed",
                format!("Failed to fingerprint fixture source: {error}"),
            )
        })?;
        let (fixture, _) = library
            .create_fixture(make, model, mode, id)
            .map_err(|error| {
                CommandError::new(
                    "fixture_library.create_failed",
                    format!("Failed to create fixture: {error}"),
                )
            })?;
        Ok(LibraryFixtureTemplate {
            fixture,
            asset_etag,
        })
    })?;
    Ok(FixtureLibraryCommandSuccess::Applied)
}

/// Broadcasts available fixtures when a library scan completes.
pub fn send_available_fixtures_on_change(
    library: Res<FixtureLibraryManager>,
    broadcaster: Res<ClientEventSink>,
    mut events: MessageReader<FixtureLibraryEvent>,
) {
    for event in events.read() {
        if !matches!(event, FixtureLibraryEvent::ScanCompleted { .. }) {
            continue;
        }
        let fixtures = library
            .list_fixtures()
            .iter()
            .filter_map(|profile| match available_fixture_info(profile) {
                Ok(info) => Some(info),
                Err(error) => {
                    tracing::warn!(
                        make = profile.make,
                        model = profile.model,
                        %error,
                        "fixture_library_refresh_entry_skipped"
                    );
                    None
                }
            })
            .collect();
        publish_available_fixtures(&broadcaster, &ListAvailableFixturesResponse { fixtures });
    }
}

/// Converts a fixture profile into its transport-facing summary.
fn available_fixture_info(profile: &FixtureProfile) -> Result<AvailableFixtureInfo, String> {
    Ok(AvailableFixtureInfo {
        make: profile.make.clone(),
        model: profile.model.clone(),
        modes: profile.mode_names(),
        source_format: match &profile.source {
            FixtureSource::Gdtf(_) => "GDTF".to_string(),
            FixtureSource::Ofl(_) => "OFL".to_string(),
            FixtureSource::BuiltIn { .. } => BUILTIN_SOURCE_FORMAT.to_string(),
        },
        asset_etag: fixture_profile_asset_etag(profile)?,
    })
}

/// Returns the deterministic version fingerprint for one fixture profile.
fn fixture_profile_asset_etag(profile: &FixtureProfile) -> Result<String, String> {
    match &profile.source {
        FixtureSource::BuiltIn { asset_etag, .. } => Ok(asset_etag.clone()),
        FixtureSource::Gdtf(_) | FixtureSource::Ofl(_) => {
            fixture_source_version(&profile.file_path)
                .map_err(|error| format!("{} ({})", error, profile.file_path.display()))
        }
    }
}

#[cfg(test)]
mod tests {
    use bevy_app::{App, Update};
    use bevy_ecs::message::Messages;
    use nightfall_fixtures::library::commands::finish_fixture_library_commands;
    use tempfile::TempDir;

    use super::*;

    /// Creates a focused app containing the fixture-library command lifecycle.
    fn fixture_library_app(temp_dir: &TempDir) -> App {
        let mut app = App::new();
        app.insert_resource(
            FixtureLibraryManager::with_path(temp_dir.path().to_path_buf())
                .expect("fixture library should initialize"),
        );
        app.init_resource::<FixtureDataProviderExt>();
        app.init_resource::<CommandTracker>();
        app.add_message::<CommandEnvelope<FixtureLibraryCommand>>();
        app.add_message::<FixtureLibraryCommandResult>();
        app.add_message::<CommandResult>();
        app.add_message::<CommandReply>();
        app.add_message::<FinishedCommand>();
        app.add_message::<CommandNotice>();
        let (sender, _receiver) = async_channel::unbounded();
        app.insert_resource(ClientEventSink::new(sender));
        app.add_systems(
            Update,
            (
                handle_fixture_library_commands,
                finish_fixture_library_commands,
            )
                .chain(),
        );
        app
    }

    /// Registers and submits one fixture-library command to the focused app.
    fn submit_command(app: &mut App, command: FixtureLibraryCommand) -> CommandId {
        let envelope = CommandEnvelope::new(command, CommandOrigin::WebUi, ReplyTarget::Detached);
        let command_id = envelope.command_id;
        app.world_mut()
            .resource_mut::<CommandTracker>()
            .register(&envelope)
            .expect("fixture-library command should register");
        app.world_mut().write_message(envelope);
        command_id
    }

    /// Drains the terminal result produced by one fixture-library command.
    fn take_result(app: &mut App) -> CommandResult {
        app.world_mut()
            .resource_mut::<Messages<CommandResult>>()
            .drain()
            .next()
            .expect("fixture-library command should produce a terminal result")
    }

    /// Verifies fixture-list domain data is returned through the terminal result.
    #[test]
    fn list_available_fixtures_returns_typed_output() {
        let temp_dir = TempDir::new().expect("temporary library directory should exist");
        let mut app = fixture_library_app(&temp_dir);
        submit_command(&mut app, FixtureLibraryCommand::ListAvailableFixtures);

        app.update();

        assert!(matches!(
            take_result(&mut app).outcome,
            CommandOutcome::Succeeded { output: Some(ref output) }
                if output.value["fixtures"].as_array().is_some_and(|fixtures| !fixtures.is_empty())
        ));
    }

    /// Verifies an unknown profile returns one stable fixture-library failure.
    #[test]
    fn get_missing_fixture_profile_returns_failure() {
        let temp_dir = TempDir::new().expect("temporary library directory should exist");
        let mut app = fixture_library_app(&temp_dir);
        submit_command(
            &mut app,
            FixtureLibraryCommand::GetFixtureProfile {
                make: "Missing".to_string(),
                model: "Fixture".to_string(),
                mode: None,
            },
        );

        app.update();

        assert!(matches!(
            take_result(&mut app).outcome,
            CommandOutcome::Failed(CommandError { ref code, .. })
                if code == "fixture_library.not_found"
        ));
    }

    /// Verifies a created fixture is stored before terminal success is published.
    #[test]
    fn create_fixture_mutates_before_success() {
        let temp_dir = TempDir::new().expect("temporary library directory should exist");
        let mut app = fixture_library_app(&temp_dir);
        let (make, model, mode) = {
            let library = app.world().resource::<FixtureLibraryManager>();
            let profile = library
                .list_fixtures()
                .into_iter()
                .next()
                .expect("built-in fixture should exist");
            (
                profile.make.clone(),
                profile.model.clone(),
                profile
                    .default_mode()
                    .expect("built-in fixture should expose a mode"),
            )
        };
        let command_id = submit_command(
            &mut app,
            FixtureLibraryCommand::CreateFixtureFromLibrary {
                id: 77,
                make,
                model,
                mode,
                label: Some("Lifecycle Fixture".to_string()),
                update_existing_ids: Vec::new(),
                update_existing_only: false,
            },
        );

        app.update();

        assert_eq!(
            app.world()
                .resource::<FixtureDataProviderExt>()
                .inner
                .from_id(77)
                .expect("created fixture should be stored")
                .identifiers
                .label,
            "Lifecycle Fixture"
        );
        let result = take_result(&mut app);
        assert_eq!(result.command_id, command_id);
        assert_eq!(result.outcome, CommandOutcome::succeeded());
    }

    /// Verifies a rejected multi-fixture update leaves earlier valid targets unchanged.
    #[test]
    fn rejected_fixture_update_is_atomic() {
        let temp_dir = TempDir::new().expect("temporary library directory should exist");
        let mut app = fixture_library_app(&temp_dir);
        let (make, model, mode, fixture) = {
            let library = app.world().resource::<FixtureLibraryManager>();
            let profile = library
                .list_fixtures()
                .into_iter()
                .next()
                .expect("built-in fixture should exist");
            let mode = profile
                .default_mode()
                .expect("built-in fixture should expose a mode");
            let fixture = library
                .create_fixture(&profile.make, &profile.model, &mode, 1)
                .expect("built-in fixture should instantiate")
                .0;
            (profile.make.clone(), profile.model.clone(), mode, fixture)
        };
        app.world_mut()
            .resource_mut::<FixtureDataProviderExt>()
            .inner
            .add(fixture)
            .expect("existing fixture should be stored");
        submit_command(
            &mut app,
            FixtureLibraryCommand::CreateFixtureFromLibrary {
                id: 99,
                make,
                model,
                mode,
                label: None,
                update_existing_ids: vec![1, 404],
                update_existing_only: true,
            },
        );

        app.update();

        let stored = app
            .world()
            .resource::<FixtureDataProviderExt>()
            .inner
            .from_id(1)
            .expect("existing fixture should remain");
        assert_eq!(stored.library_asset_etag, None);
        drop(stored);
        assert!(matches!(
            take_result(&mut app).outcome,
            CommandOutcome::Failed(CommandError { ref code, .. })
                if code == "fixture_library.fixture_not_found"
        ));
    }
}
