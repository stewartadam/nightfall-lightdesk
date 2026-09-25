// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Fixture-library command contract and command lifecycle shared by every runtime.
//!
//! Native builds serve these commands from the file-backed fixture library while the
//! embedded browser runtime serves them from the compiled built-in catalog. Both use
//! the same wire types, publications, and terminal command results.

use bevy_ecs::prelude::*;
use nightfall_engine::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::prelude::{Fixture, FixtureGeometry};

/// Commands for fixture library operations
#[derive(Debug, Clone, Serialize, Deserialize, EnginePayload)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
#[serde(deny_unknown_fields)]
pub enum FixtureLibraryCommand {
    /// List all available fixtures in the library
    ListAvailableFixtures,

    /// Get detailed information about a specific fixture
    GetFixtureProfile {
        /// Manufacturer name
        make: String,
        /// Model name
        model: String,
        /// Optional DMX mode name (if not provided, uses first/default mode)
        #[serde(default)]
        mode: Option<String>,
    },

    /// Refresh the fixture library by rescanning the directory
    RefreshLibrary,

    /// Create a fixture from the library
    CreateFixtureFromLibrary {
        /// Fixture ID
        id: u32,
        /// Manufacturer name
        make: String,
        /// Model name
        model: String,
        /// DMX mode name
        mode: String,
        /// Optional user-defined label for the fixture
        #[serde(default)]
        label: Option<String>,
        /// Existing fixture IDs to update to this library asset version
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        update_existing_ids: Vec<u32>,
        /// Update existing fixtures without creating a new fixture instance.
        #[serde(default)]
        update_existing_only: bool,
    },

    /// Upload a fixture file to the library
    UploadFixture {
        /// Original filename (used to determine format and as storage name)
        filename: String,
        /// File content as bytes
        content: Vec<u8>,
    },

    /// Delete fixtures from the library
    DeleteFixtures(Vec<FixtureLibraryEntry>),
}

impl IngressCommand for FixtureLibraryCommand {}

/// Identifies a fixture in the library by make and model
#[derive(Debug, Clone, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct FixtureLibraryEntry {
    /// Manufacturer name
    pub make: String,
    /// Model name
    pub model: String,
}

/// Information about an available fixture
#[derive(Debug, Clone, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct AvailableFixtureInfo {
    /// Manufacturer name
    pub make: String,
    /// Model name
    pub model: String,
    /// Available modes
    pub modes: Vec<String>,
    /// Source format (GDTF, OFL, or built-in)
    pub source_format: String,
    /// Deterministic content fingerprint of the fixture source file
    pub asset_etag: String,
}

/// Response for ListAvailableFixtures command
#[derive(Debug, Clone, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct ListAvailableFixturesResponse {
    /// List of available fixtures
    pub fixtures: Vec<AvailableFixtureInfo>,
}

/// Response for GetFixtureProfile command
#[derive(Debug, Clone, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct GetFixtureProfileResponse {
    /// Fixture information
    pub info: AvailableFixtureInfo,
    /// DMX mode requested for this profile response after applying the default mode fallback.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requested_mode: Option<String>,
    /// Parsed fixture data for the requested mode (for visualization preview).
    /// This is an ephemeral fixture with ID 0 - not stored in the show.
    #[serde(default)]
    pub fixture: Option<Fixture>,
    /// Geometry data for the fixture (GDTF only).
    /// Used by the visualizer to render an accurate 3D model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub geometry: Option<FixtureGeometry>,
}

/// Wrapper for serializing fixture-library messages with the WebSocket wire format.
#[derive(Serialize)]
#[serde(tag = "type", content = "data")]
#[typeshare::typeshare]
enum FixtureLibraryWsMessage<'a> {
    /// List of available fixtures.
    ListAvailableFixturesResponse(&'a ListAvailableFixturesResponse),
    /// Fixture profile information.
    GetFixtureProfileResponse(&'a GetFixtureProfileResponse),
    /// A fixture-library command retained while UI acknowledgements migrate.
    #[allow(dead_code)]
    FixtureLibraryCommand(&'a FixtureLibraryCommand),
}

/// Successful outcome of one applied fixture-library command.
#[derive(Clone, Debug)]
pub enum FixtureLibraryCommandSuccess {
    /// The command applied without producing typed output.
    Applied,
    /// The command produced the current fixture listing.
    AvailableFixtures(ListAvailableFixturesResponse),
    /// The command produced one fixture profile.
    FixtureProfile(Box<GetFixtureProfileResponse>),
}

/// Domain-local outcome emitted after one fixture-library command has applied.
#[derive(Clone, Debug, Message)]
pub struct FixtureLibraryCommandResult {
    command_id: CommandId,
    result: Result<FixtureLibraryCommandSuccess, CommandError>,
}

impl FixtureLibraryCommandResult {
    /// Pairs a command identity with the outcome its runtime handler produced.
    pub fn new(
        command_id: CommandId,
        result: Result<FixtureLibraryCommandSuccess, CommandError>,
    ) -> Self {
        Self { command_id, result }
    }
}

/// Registers the fixture-library command contract and its terminal-result lifecycle.
///
/// Runtime compositions call this once and then add their own
/// `CommandEnvelope<FixtureLibraryCommand>` handler, chained before
/// [`finish_fixture_library_commands`].
pub fn register_fixture_library_commands(app: &mut bevy_app::App) {
    register_ingress_command::<FixtureLibraryCommand>(app);
    app.add_message::<FixtureLibraryCommandResult>();
    register_command_deserializer::<FixtureLibraryCommand>(
        app,
        deserialize_fixture_library_command,
    );
}

/// Deserializes one fixture-library command into its semantic envelope.
pub fn deserialize_fixture_library_command(
    world: &mut World,
    json: Value,
    command_id: CommandId,
    undo_id: UndoId,
) -> Result<(), String> {
    let command: FixtureLibraryCommand = serde_json::from_value(json)
        .map_err(|error| format!("Failed to parse FixtureLibraryCommand: {error}"))?;
    world.write_message(CommandEnvelope::with_context(
        command_id,
        undo_id,
        CommandOrigin::WebUi,
        ReplyTarget::ClientBroadcast,
        command,
    ));
    Ok(())
}

/// Publishes terminal results after fixture mutations and deferred parameter spawns apply.
pub fn finish_fixture_library_commands(
    mut events: MessageReader<FixtureLibraryCommandResult>,
    mut responder: CommandResponder,
) {
    for event in events.read() {
        let response = match &event.result {
            Ok(FixtureLibraryCommandSuccess::Applied) => responder.succeed(event.command_id),
            Ok(FixtureLibraryCommandSuccess::AvailableFixtures(response)) => {
                responder.succeed_with_output(event.command_id, response)
            }
            Ok(FixtureLibraryCommandSuccess::FixtureProfile(response)) => {
                responder.succeed_with_output(event.command_id, response)
            }
            Err(error) => responder.fail(event.command_id, error.clone()),
        };
        if let Err(error) = response {
            tracing::error!(
                command_id = %event.command_id,
                %error,
                "fixture_library_command_completion_failed"
            );
        }
    }
}

/// Broadcasts a fixture listing to every connected client.
pub fn publish_available_fixtures(
    broadcaster: &ClientEventSink,
    response: &ListAvailableFixturesResponse,
) {
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &FixtureLibraryWsMessage::ListAvailableFixturesResponse(response),
    );
}

/// Broadcasts one resolved fixture profile to every connected client.
pub fn publish_fixture_profile(
    broadcaster: &ClientEventSink,
    response: &GetFixtureProfileResponse,
) {
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &FixtureLibraryWsMessage::GetFixtureProfileResponse(response),
    );
}

/// Builds the stable failure reported when a requested profile is not in the library.
pub fn fixture_profile_not_found(make: &str, model: &str) -> CommandError {
    CommandError::new(
        "fixture_library.not_found",
        format!("Fixture {make} {model} does not exist in the library"),
    )
}
