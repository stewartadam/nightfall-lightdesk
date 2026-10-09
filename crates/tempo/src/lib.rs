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

use crate::engine::{TempoEngine, TempoSnapshot};

/// Prelude for ergonomic imports
pub mod prelude {
    pub use crate::engine::{TempoEngine, TempoSnapshot};
    pub use crate::{ShowTempo, TempoCommand, TempoPlugin, TempoUpdate};
}

/// Plugin that owns the show tempo resource, its commands, actions and client updates.
pub struct TempoPlugin;

impl Plugin for TempoPlugin {
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
    /// Registers one tap of tap tempo.
    Tap,
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
    pub fn apply(&mut self, command: &TempoCommand) {
        let now = self.now_secs();
        match *command {
            TempoCommand::SetBpm(bpm) => self.engine.set_bpm(bpm),
            TempoCommand::Tap => self.engine.tap(now),
            TempoCommand::Resync => self.engine.resync(now),
            TempoCommand::Snap => self.engine.snap(now),
            TempoCommand::Multiply(factor) => self.engine.multiply(factor),
            TempoCommand::Nudge(beats) => self.engine.nudge(beats),
            TempoCommand::SetBeatsPerBar(beats) => self.engine.set_beats_per_bar(beats),
        }
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
                tempo.apply(&envelope.command);
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
        assert!(TempoCommand::Tap.validate().is_ok());
    }

    /// Verifies the resource routes commands to the engine.
    #[test]
    fn apply_routes_commands_to_engine() {
        let mut tempo = ShowTempo::default();
        tempo.apply(&TempoCommand::SetBpm(90.0));
        tempo.apply(&TempoCommand::Multiply(2.0));
        tempo.apply(&TempoCommand::SetBeatsPerBar(3));
        let snapshot = tempo.snapshot();
        assert_eq!(snapshot.target_bpm, 180.0);
        assert_eq!(snapshot.beats_per_bar, 3);
    }
}
