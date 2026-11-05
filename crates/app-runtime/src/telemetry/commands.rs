// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Telemetry consent and graphics report types, the command that changes them, and the client
//! feed of the consent state.

use bevy::prelude::*;
use nightfall_engine::prelude::*;
use serde::{Deserialize, Serialize};

/// Operator choices about anonymous telemetry, kept with the host rather than any showfile
/// so that opening a show on another computer never changes what that computer shares.
#[derive(Debug, Default, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[typeshare::typeshare]
#[serde(default)]
pub struct TelemetryConsent {
    /// Whether the operator has answered the telemetry prompt; while false the UI keeps asking.
    pub decided: bool,
    /// Whether anonymous usage reports (hardware, patch makeup, app starts) may be sent.
    pub share_usage: bool,
    /// Whether automatic error and crash reports may be sent.
    pub share_errors: bool,
}

/// Host telemetry consent plus the anonymous identifier that groups one installation's reports.
#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq, Eq, Resource)]
#[typeshare::typeshare]
pub struct TelemetryState {
    /// Whether this runtime can store host preferences; false in the browser demo and tests.
    pub available: bool,
    /// The operator's current choices.
    pub consent: TelemetryConsent,
    /// Random identifier attached to reports so monthly installs can be counted; empty until loaded.
    pub install_id: String,
    /// Persistence failure the operator should see.
    pub error: Option<String>,
}

/// Graphics hardware the desktop app's own window renders with, which only the web view can see.
#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[typeshare::typeshare]
pub struct GraphicsReport {
    /// Graphics processor model as the web view names it, when it names one.
    pub gpu: Option<String>,
    /// Rendering API the visualizer can use, such as `WebGPU` or `WebGL 2`.
    pub backend: String,
}

impl GraphicsReport {
    /// Longest text kept from a client-supplied field.
    const MAX_FIELD_LENGTH: usize = 160;

    /// Returns the report with surrounding whitespace removed, empty names dropped, and each
    /// field cut to a bounded length, since any connected client can send one.
    pub fn sanitized(&self) -> Self {
        let clean = |value: &str| {
            let value = value.trim();
            let end = value
                .char_indices()
                .nth(Self::MAX_FIELD_LENGTH)
                .map_or(value.len(), |(index, _)| index);
            value[..end].to_string()
        };
        Self {
            gpu: self.gpu.as_deref().map(clean).filter(|gpu| !gpu.is_empty()),
            backend: clean(&self.backend),
        }
    }
}

/// The most recent graphics report from the desktop app's window, kept out of client sync.
#[derive(Debug, Default, Clone, PartialEq, Eq, Resource)]
pub struct ReportedGraphics(pub Option<GraphicsReport>);

/// Commands that change the host's telemetry choices or record what it reports.
#[derive(Debug, Clone, Serialize, Deserialize, EnginePayload)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
#[serde(deny_unknown_fields)]
pub enum TelemetryCommand {
    /// Sets the operator's telemetry choices.
    SetConsent(TelemetryConsent),
    /// Replaces the anonymous telemetry identifier with a new random one.
    ResetInstallId,
    /// Records the graphics hardware the desktop app's window renders with, for usage reports.
    ReportGraphics(GraphicsReport),
}

impl IngressCommand for TelemetryCommand {}

/// Telemetry messages sent to clients.
#[derive(Serialize)]
#[serde(tag = "type", content = "data")]
#[typeshare::typeshare]
enum TelemetryWsMessage<'a> {
    /// Host-owned telemetry consent and anonymous identifier.
    TelemetryState(&'a TelemetryState),
}

/// Registers the telemetry state and graphics report resources, the telemetry command, and the
/// client feed. Hosts that cannot store preferences keep the state unavailable, so the command
/// changes nothing there.
pub(crate) struct TelemetryCommandsPlugin;

impl Plugin for TelemetryCommandsPlugin {
    /// Adds the resources, the command handler, the change feed, and the resync reply.
    fn build(&self, app: &mut App) {
        app.init_resource::<TelemetryState>();
        app.init_resource::<ReportedGraphics>();
        register_client_command::<TelemetryCommand>(app, Undo::Skipped);
        app.add_systems(Update, handle_telemetry_commands.in_set(EventHandling));
        app.add_resource_feed::<TelemetryState>();
    }
}

/// Applies telemetry commands where the host can store and send telemetry, and succeeds either
/// way so clients never wait on a host without telemetry.
fn handle_telemetry_commands(
    mut commands: MessageReader<CommandEnvelope<TelemetryCommand>>,
    mut telemetry: ResMut<TelemetryState>,
    mut reported_graphics: ResMut<ReportedGraphics>,
    mut responder: CommandResponder,
) {
    for envelope in commands.read() {
        if telemetry.available {
            match &envelope.command {
                TelemetryCommand::SetConsent(consent) => telemetry.consent = *consent,
                TelemetryCommand::ResetInstallId => {
                    telemetry.install_id = uuid::Uuid::new_v4().to_string();
                }
                TelemetryCommand::ReportGraphics(report) => {
                    reported_graphics.0 = Some(report.sanitized());
                }
            }
        }
        if let Err(error) = responder.succeed(envelope.command_id) {
            tracing::error!(
                command_id = %envelope.command_id,
                %error,
                "telemetry_command_completion_failed"
            );
        }
    }
}

impl ResourceFeed for TelemetryState {
    /// Publishes host telemetry consent so every connected client shows the same choices.
    fn publish(&self, sink: &ClientEventSink) {
        sink.publish(
            DISCRIMINATOR_NON_DROPPABLE,
            &TelemetryWsMessage::TelemetryState(self),
        );
    }
}

#[cfg(test)]
mod tests {
    use bevy::ecs::message::Messages;

    use super::*;

    /// Builds an app that applies telemetry commands and records their results.
    fn command_app() -> App {
        let mut app = App::new();
        app.init_resource::<TelemetryState>();
        app.init_resource::<ReportedGraphics>();
        app.init_resource::<CommandTracker>();
        app.add_message::<CommandEnvelope<TelemetryCommand>>();
        app.add_message::<CommandResult>();
        app.add_message::<CommandReply>();
        app.add_message::<FinishedCommand>();
        app.add_message::<CommandNoticeReply>();
        app.add_systems(Update, handle_telemetry_commands);
        app
    }

    /// Registers and submits one telemetry command to the app.
    fn submit_command(app: &mut App, command: TelemetryCommand) {
        let envelope = CommandEnvelope::new(command, CommandOrigin::WebUi, ReplyTarget::Detached);
        app.world_mut()
            .resource_mut::<CommandTracker>()
            .register(&envelope)
            .expect("telemetry command should register");
        app.world_mut().write_message(envelope);
    }

    /// Drains the terminal result produced by one telemetry command.
    fn take_result(app: &mut App) -> CommandResult {
        app.world_mut()
            .resource_mut::<Messages<CommandResult>>()
            .drain()
            .next()
            .expect("telemetry command should produce a terminal result")
    }

    /// Verifies consent and identifier commands update host telemetry state only where it can be stored.
    #[test]
    fn telemetry_commands_require_available_host() {
        let mut app = command_app();
        let consent = TelemetryConsent {
            decided: true,
            share_usage: true,
            share_errors: false,
        };
        submit_command(&mut app, TelemetryCommand::SetConsent(consent));
        app.update();
        assert_eq!(take_result(&mut app).outcome, CommandOutcome::succeeded());
        assert_eq!(
            app.world().resource::<TelemetryState>().consent,
            Default::default(),
            "an unavailable host must ignore consent changes"
        );

        {
            let mut state = app.world_mut().resource_mut::<TelemetryState>();
            state.available = true;
            state.install_id = "before".into();
        }
        submit_command(&mut app, TelemetryCommand::SetConsent(consent));
        submit_command(&mut app, TelemetryCommand::ResetInstallId);
        app.update();
        let state = app.world().resource::<TelemetryState>();
        assert_eq!(state.consent, consent);
        assert_ne!(state.install_id, "before");
        assert!(uuid::Uuid::parse_str(&state.install_id).is_ok());
    }

    /// Verifies graphics reports are kept only where usage reports can be sent, and that each
    /// field is trimmed and bounded because any connected client may send one.
    #[test]
    fn graphics_reports_are_sanitized_and_require_available_host() {
        let mut app = command_app();
        let report = GraphicsReport {
            gpu: Some(format!("  Apple M2 {}  ", "x".repeat(400))),
            backend: " WebGPU ".into(),
        };
        submit_command(&mut app, TelemetryCommand::ReportGraphics(report.clone()));
        app.update();
        assert_eq!(take_result(&mut app).outcome, CommandOutcome::succeeded());
        assert_eq!(app.world().resource::<ReportedGraphics>().0, None);

        app.world_mut().resource_mut::<TelemetryState>().available = true;
        submit_command(&mut app, TelemetryCommand::ReportGraphics(report));
        app.update();
        let stored = app
            .world()
            .resource::<ReportedGraphics>()
            .0
            .clone()
            .unwrap();
        assert_eq!(stored.backend, "WebGPU");
        let gpu = stored.gpu.unwrap();
        assert!(gpu.starts_with("Apple M2 x"));
        assert_eq!(gpu.chars().count(), 160);

        submit_command(
            &mut app,
            TelemetryCommand::ReportGraphics(GraphicsReport {
                gpu: Some("   ".into()),
                backend: "WebGL 2".into(),
            }),
        );
        app.update();
        assert_eq!(
            app.world()
                .resource::<ReportedGraphics>()
                .0
                .clone()
                .unwrap()
                .gpu,
            None
        );
    }
}
