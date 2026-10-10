// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Show-wide live tempo: one BPM and beat phase that live playback can follow.
//!
//! The engine itself lives in [`engine`]; this crate wires it into the app as the
//! [`ShowTempo`] resource, the `tempo` command, mappable MIDI/OSC actions and client state.

#![warn(missing_docs)]

use bevy_app::prelude::*;
use bevy_ecs::prelude::*;
use nightfall_engine::prelude::*;
use serde::{Deserialize, Serialize};
use web_time::Instant;

pub mod actions;
pub mod ast_conv;
pub mod engine;
pub mod websocket;

use crate::engine::{TapTime, TempoEngine, TempoSnapshot};

/// Prelude for ergonomic imports
pub mod prelude {
    pub use crate::engine::{TapTime, TempoEngine, TempoSnapshot};
    pub use crate::{ShowTempo, TempoCommand, TempoPlugin, TempoUpdate};
}

/// Plugin that owns the show tempo resource, its commands, actions and client updates.
pub struct TempoPlugin;

impl Plugin for TempoPlugin {
    /// Registers the show tempo resource, its client and command-line commands, the tempo
    /// actions, and the systems that advance it each frame and broadcast it to clients.
    fn build(&self, app: &mut App) {
        tracing::debug!("Registering TempoPlugin");
        app.init_resource::<ShowTempo>();
        register_ingress_command::<TempoCommand>(app);
        register_command_deserializer::<TempoCommand>(app, websocket::deserialize_tempo_command);
        nightfall_engine::protocol::dispatch_ast::register_converter::<ast_conv::TempoAstConverter>(
        );
        actions::register_tempo_actions(app);

        app.configure_sets(Render, TempoUpdate.in_set(ClockUpdate));
        app.add_systems(Render, advance_show_tempo.in_set(TempoUpdate));
        app.add_systems(Update, handle_tempo_commands.in_set(EventHandling));
        app.add_systems(Render, websocket::send_tempo_state.in_set(ClientOutput));
        app.add_systems(
            Update,
            websocket::handle_resync_state.in_set(ResyncHandling),
        );
    }
}

/// System set that advances the show tempo; clocks that follow the tempo run after it.
#[derive(SystemSet, Debug, Clone, PartialEq, Eq, Hash)]
pub struct TempoUpdate;

/// Commands that change the show tempo, sent by clients and the command line.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, EnginePayload)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
#[serde(deny_unknown_fields)]
pub enum TempoCommand {
    /// Eases the tempo to a new BPM.
    SetBpm(f64),
    /// Registers one tap of tap tempo, optionally carrying when the tap happened on the
    /// sending client's monotonic clock, in milliseconds. Timed taps keep their exact spacing
    /// however long each takes to reach the engine.
    Tap(Option<f64>),
    /// Eases the phase so that now becomes the nearest downbeat.
    Resync,
    /// Jumps forward to the next downbeat immediately.
    Snap,
    /// Multiplies the tempo, e.g. `2.0` for double time or `0.5` for half time.
    Multiply(f64),
    /// Shifts the phase by a signed number of beats.
    Nudge(f64),
    /// Sets the number of beats in one bar.
    SetBeatsPerBar(u8),
}

impl IngressCommand for TempoCommand {}

impl TempoCommand {
    /// Checks the command's arguments, returning a user-facing message when they are invalid.
    fn validate(&self) -> Result<(), String> {
        match self {
            Self::SetBpm(bpm) if !bpm.is_finite() || *bpm <= 0.0 => {
                Err(format!("Tempo must be a positive number of BPM, got {bpm}"))
            }
            Self::Multiply(factor) if !factor.is_finite() || *factor <= 0.0 => {
                Err(format!("Tempo multiplier must be positive, got {factor}"))
            }
            Self::Nudge(beats) if !beats.is_finite() => Err(format!(
                "Tempo nudge must be a number of beats, got {beats}"
            )),
            Self::Tap(Some(time)) if !time.is_finite() || *time < 0.0 => Err(format!(
                "Tap time must be a non-negative number of milliseconds, got {time}"
            )),
            Self::SetBeatsPerBar(beats) if !(1..=engine::MAX_BEATS_PER_BAR).contains(beats) => {
                Err(format!(
                    "A bar must have between 1 and {} beats, got {beats}",
                    engine::MAX_BEATS_PER_BAR
                ))
            }
            _ => Ok(()),
        }
    }
}

/// The show-wide tempo shared by every client and every tempo-following playback.
#[derive(Resource, Debug, Clone)]
pub struct ShowTempo {
    /// Eased tempo and beat counter.
    engine: TempoEngine,
    /// Reference instant that engine seconds are measured from.
    epoch: Instant,
}

impl Default for ShowTempo {
    /// Creates a default tempo whose engine time starts now.
    fn default() -> Self {
        Self {
            engine: TempoEngine::default(),
            epoch: Instant::now(),
        }
    }
}

impl ShowTempo {
    /// Returns the tempo state as of the last advance.
    pub fn snapshot(&self) -> TempoSnapshot {
        self.engine.snapshot()
    }

    /// Returns whether tempo or phase is still easing toward a target.
    pub fn is_settling(&self) -> bool {
        self.engine.is_settling()
    }

    /// Advances the beat counter to the current wall-clock time.
    pub fn advance(&mut self) {
        let now = self.now_secs();
        self.engine.advance_to(now);
    }

    /// Applies one tempo command at the current wall-clock time.
    ///
    /// `client` identifies the client session that sent the command, if any. A tap that
    /// carries its own time is fitted on that client's clock; without a sending client the
    /// time cannot be trusted to share a clock with earlier taps, so the engine clock is used.
    pub fn apply(&mut self, command: &TempoCommand, client: Option<ClientId>) {
        let now = self.now_secs();
        match *command {
            TempoCommand::SetBpm(bpm) => self.engine.set_bpm(bpm),
            TempoCommand::Tap(time_ms) => self.engine.tap(match (client, time_ms) {
                (Some(client), Some(time_ms)) => TapTime::Client {
                    client: client.0,
                    seconds: time_ms / 1000.0,
                    received: now,
                },
                _ => TapTime::Engine(now),
            }),
            TempoCommand::Resync => self.engine.resync(now),
            TempoCommand::Snap => self.engine.snap(now),
            TempoCommand::Multiply(factor) => self.engine.multiply(factor),
            TempoCommand::Nudge(beats) => self.engine.nudge(beats),
            TempoCommand::SetBeatsPerBar(beats) => self.engine.set_beats_per_bar(beats),
        }
    }

    /// Registers a tap that happened at `at`, such as when a MIDI or OSC message arrived,
    /// rather than when the engine got around to processing it.
    pub fn tap_at(&mut self, at: Instant) {
        let time = at.saturating_duration_since(self.epoch).as_secs_f64();
        self.engine.tap(TapTime::Engine(time));
    }

    /// Seconds elapsed since this resource's epoch, used as engine time.
    fn now_secs(&self) -> f64 {
        self.epoch.elapsed().as_secs_f64()
    }
}

/// Advances the show tempo once per rendered frame.
fn advance_show_tempo(mut tempo: ResMut<ShowTempo>) {
    tempo.advance();
}

/// Applies tempo commands from clients and the command line and reports their outcome.
fn handle_tempo_commands(
    mut commands: MessageReader<CommandEnvelope<TempoCommand>>,
    mut tempo: ResMut<ShowTempo>,
    mut responder: CommandResponder,
) {
    for envelope in commands.read() {
        let result = match envelope.command.validate() {
            Ok(()) => {
                let client = match envelope.reply_target {
                    ReplyTarget::Client(client) => Some(client),
                    _ => None,
                };
                tempo.apply(&envelope.command, client);
                responder.succeed(envelope.command_id)
            }
            Err(message) => responder.fail(
                envelope.command_id,
                CommandError::new("tempo.invalid_argument", message),
            ),
        };
        if let Err(error) = result {
            tracing::error!(command_id = %envelope.command_id, %error, "tempo_command_completion_failed");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verifies invalid tempo arguments are rejected before reaching the engine.
    #[test]
    fn validate_rejects_invalid_arguments() {
        assert!(TempoCommand::SetBpm(0.0).validate().is_err());
        assert!(TempoCommand::SetBpm(f64::INFINITY).validate().is_err());
        assert!(TempoCommand::Multiply(-1.0).validate().is_err());
        assert!(TempoCommand::Nudge(f64::NAN).validate().is_err());
        assert!(TempoCommand::SetBeatsPerBar(0).validate().is_err());
        assert!(TempoCommand::SetBpm(128.0).validate().is_ok());
        assert!(TempoCommand::Tap(Some(-1.0)).validate().is_err());
        assert!(TempoCommand::Tap(None).validate().is_ok());
        assert!(TempoCommand::Tap(Some(1234.5)).validate().is_ok());
    }

    /// Verifies taps timed at their arrival keep exact spacing however late they are applied.
    #[test]
    fn tap_at_uses_arrival_time() {
        let mut tempo = ShowTempo::default();
        let start = tempo.epoch + std::time::Duration::from_secs(1);
        for index in 0..4 {
            tempo.tap_at(start + std::time::Duration::from_millis(500 * index));
        }
        assert!((tempo.snapshot().target_bpm - 120.0).abs() < 1e-9);
    }

    /// Verifies a timed tap from the command line, which has no client clock to fit on,
    /// falls back to the engine clock instead of trusting the supplied time.
    #[test]
    fn timed_tap_without_client_uses_engine_clock() {
        let mut tempo = ShowTempo::default();
        tempo.apply(&TempoCommand::Tap(Some(0.0)), None);
        tempo.apply(&TempoCommand::Tap(Some(400.0)), None);
        assert_eq!(
            tempo.snapshot().target_bpm,
            engine::MAX_BPM,
            "back-to-back taps on the engine clock fit the fastest tempo, not the 150 BPM \
             the supplied times imply"
        );
    }

    /// Verifies the resource routes commands to the engine.
    #[test]
    fn apply_routes_commands_to_engine() {
        let mut tempo = ShowTempo::default();
        tempo.apply(&TempoCommand::SetBpm(90.0), None);
        tempo.apply(&TempoCommand::Multiply(2.0), None);
        tempo.apply(&TempoCommand::SetBeatsPerBar(3), None);
        let snapshot = tempo.snapshot();
        assert_eq!(snapshot.target_bpm, 180.0);
        assert_eq!(snapshot.beats_per_bar, 3);
    }
}
