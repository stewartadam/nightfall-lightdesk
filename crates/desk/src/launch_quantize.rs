// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Live clip launches that wait for the next beat or bar while the show's launch quantize
//! mode is on.
//!
//! Only live starts, Go presses and stops sent as clip commands wait. Timeline playback, flows,
//! and held Flash and Swop buttons write clip operations directly and always fire at once.

use bevy_ecs::prelude::*;
use nightfall::prelude::IdExpr;
use nightfall_actions::ActionSurface;
use nightfall_clips::ClipOperation;
use nightfall_engine::prelude::*;
use serde::Serialize;

/// Origin of clip commands evaluated from desk command actions that engine systems such as a
/// timeline run, rather than a person.
pub const INTERNAL_DESK_ACTION_ORIGIN: &str = "InternalDeskAction";

/// Returns whether a clip command from `origin` waits for launch quantize: anything a person
/// sends, but not commands a timeline runs, which keep to the timeline's own grid.
pub fn origin_follows_launch_quantize(origin: &CommandOrigin) -> bool {
    match origin {
        CommandOrigin::Remote(name) => name != INTERNAL_DESK_ACTION_ORIGIN,
        CommandOrigin::Automation { surface, .. } => surface != ActionSurface::Timeline.label(),
        CommandOrigin::WebUi | CommandOrigin::Cli => true,
    }
}

/// What an armed launch does when its beat arrives.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[typeshare::typeshare]
pub enum ArmedLaunchAction {
    /// Starts the clip.
    Start,
    /// Starts the clip or advances its sequence.
    Go,
    /// Stops the clip.
    Stop,
}

/// One clip waiting for its beat, as clients show it on the clip's slot.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[typeshare::typeshare]
pub struct ArmedLaunch {
    /// Console-facing ID of the waiting clip.
    pub clip_id: u32,
    /// What the launch does when it fires.
    pub action: ArmedLaunchAction,
    /// Show tempo beat position the launch fires on.
    pub target_beat: f64,
}

/// A clip operation held until the show tempo reaches its beat.
#[derive(Debug, Clone)]
struct ArmedEntry {
    /// Show tempo beat position the operation fires on.
    target_beat: f64,
    /// The operation and the command that asked for it.
    envelope: EngineOperationEnvelope<ClipOperation>,
}

impl ArmedEntry {
    /// Returns what the waiting operation does and the clips it addresses.
    fn waiting(&self) -> Option<(ArmedLaunchAction, &IdExpr)> {
        quantized_action(&self.envelope.operation)
    }
}

/// Live clip operations waiting for the next beat or bar, in the order they were pressed.
#[derive(Resource, Debug, Default)]
pub struct ArmedLaunches {
    /// Waiting operations, oldest first.
    entries: Vec<ArmedEntry>,
}

/// Returns what a clip operation does as an armed launch and the clips it addresses, or `None`
/// for operations that never wait for a beat.
pub fn quantized_action(operation: &ClipOperation) -> Option<(ArmedLaunchAction, &IdExpr)> {
    match operation {
        ClipOperation::Start(clip_id) => Some((ArmedLaunchAction::Start, clip_id)),
        ClipOperation::Go(clip_id) => Some((ArmedLaunchAction::Go, clip_id)),
        ClipOperation::Stop(clip_id) => Some((ArmedLaunchAction::Stop, clip_id)),
        _ => None,
    }
}

impl ArmedLaunches {
    /// Holds `envelope` until the show tempo reaches `target_beat`.
    ///
    /// Returns the commands of operations this one makes pointless, which the caller completes
    /// at once. Pressing a launch that is already waiting again disarms it, so neither press
    /// fires, and a stop cancels any start or Go still waiting for the same clips, so letting go
    /// of a held launch before its beat launches nothing. A stop that cancelled a waiting launch
    /// of clips that are not running has nothing left to stop, so it is completed rather than
    /// armed.
    pub fn arm(
        &mut self,
        target_beat: f64,
        envelope: EngineOperationEnvelope<ClipOperation>,
        clips_running: bool,
    ) -> Vec<Option<CommandId>> {
        let Some((action, clip_id)) = quantized_action(&envelope.operation) else {
            return Vec::new();
        };
        if let Some(index) = self
            .entries
            .iter()
            .position(|entry| entry.waiting() == Some((action, clip_id)))
        {
            let disarmed = self.entries.remove(index);
            return vec![disarmed.envelope.command_id, envelope.command_id];
        }
        let mut cancelled = Vec::new();
        if action == ArmedLaunchAction::Stop {
            self.entries.retain(|entry| {
                let cancels = matches!(
                    entry.waiting(),
                    Some((ArmedLaunchAction::Start | ArmedLaunchAction::Go, waiting_id))
                        if waiting_id == clip_id
                );
                if cancels {
                    cancelled.push(entry.envelope.command_id);
                }
                !cancels
            });
            if !cancelled.is_empty() && !clips_running {
                cancelled.push(envelope.command_id);
                return cancelled;
            }
        }
        self.entries.push(ArmedEntry {
            target_beat,
            envelope,
        });
        cancelled
    }

    /// Removes and returns the operations whose beat has arrived at `beat_position`, oldest
    /// first.
    pub fn take_due(&mut self, beat_position: f64) -> Vec<EngineOperationEnvelope<ClipOperation>> {
        let mut due = Vec::new();
        self.entries.retain(|entry| {
            let fires = entry.target_beat <= beat_position;
            if fires {
                due.push(entry.envelope.clone());
            }
            !fires
        });
        due
    }

    /// Removes and returns every waiting operation, oldest first, to fire at once.
    pub fn take_all(&mut self) -> Vec<EngineOperationEnvelope<ClipOperation>> {
        self.entries.drain(..).map(|entry| entry.envelope).collect()
    }

    /// Returns whether no launch is waiting.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Lists every waiting clip for clients, one row per clip an operation addresses.
    pub fn status(&self) -> Vec<ArmedLaunch> {
        self.entries
            .iter()
            .filter_map(|entry| {
                let (action, clip_id) = quantized_action(&entry.envelope.operation)?;
                Some((entry.target_beat, action, clip_id.expand()))
            })
            .flat_map(|(target_beat, action, clip_ids)| {
                clip_ids.into_iter().map(move |clip_id| ArmedLaunch {
                    clip_id,
                    action,
                    target_beat,
                })
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Wraps a clip operation as if a client command had asked for it.
    fn commanded(operation: ClipOperation) -> EngineOperationEnvelope<ClipOperation> {
        EngineOperationEnvelope::with_context(
            OperationId::new(),
            Some(CommandId::new()),
            None,
            operation,
        )
    }

    /// Verifies armed launches fire once their beat arrives, oldest first, and not before.
    #[test]
    fn launches_fire_on_their_beat_in_press_order() {
        let mut armed = ArmedLaunches::default();
        armed.arm(
            8.0,
            commanded(ClipOperation::Start(IdExpr::Single(2))),
            true,
        );
        armed.arm(
            5.0,
            commanded(ClipOperation::Start(IdExpr::Single(1))),
            true,
        );
        armed.arm(5.0, commanded(ClipOperation::Go(IdExpr::Single(3))), true);

        assert!(armed.take_due(4.99).is_empty());
        let due = armed.take_due(5.0);
        assert!(matches!(
            due.as_slice(),
            [
                EngineOperationEnvelope {
                    operation: ClipOperation::Start(IdExpr::Single(1)),
                    ..
                },
                EngineOperationEnvelope {
                    operation: ClipOperation::Go(IdExpr::Single(3)),
                    ..
                },
            ]
        ));
        assert_eq!(
            armed.status(),
            vec![ArmedLaunch {
                clip_id: 2,
                action: ArmedLaunchAction::Start,
                target_beat: 8.0
            }]
        );
    }

    /// Verifies a stop cancels a waiting start for the same clip and is itself armed while the
    /// clip runs, while a second press of a waiting launch disarms it; both hand back the
    /// commands to complete.
    #[test]
    fn stop_cancels_waiting_start_and_second_press_disarms() {
        let mut armed = ArmedLaunches::default();
        let first = commanded(ClipOperation::Start(IdExpr::Single(4)));
        let first_command = first.command_id;
        assert!(armed.arm(9.0, first, true).is_empty());
        let second = commanded(ClipOperation::Start(IdExpr::Single(4)));
        let second_command = second.command_id;
        assert_eq!(
            armed.arm(9.0, second, true),
            vec![first_command, second_command]
        );
        assert!(armed.is_empty());

        let start = commanded(ClipOperation::Start(IdExpr::Single(4)));
        let start_command = start.command_id;
        assert!(armed.arm(9.0, start, true).is_empty());

        let stop = commanded(ClipOperation::Stop(IdExpr::Single(4)));
        assert_eq!(armed.arm(9.0, stop, true), vec![start_command]);
        assert_eq!(
            armed.status(),
            vec![ArmedLaunch {
                clip_id: 4,
                action: ArmedLaunchAction::Stop,
                target_beat: 9.0
            }]
        );
    }

    /// Verifies a stop that only cancels a waiting start of an idle clip is completed at once
    /// instead of waiting to stop a clip that never started.
    #[test]
    fn stop_of_idle_clip_only_cancels_its_start() {
        let mut armed = ArmedLaunches::default();
        let start = commanded(ClipOperation::Start(IdExpr::Single(4)));
        let start_command = start.command_id;
        armed.arm(9.0, start, false);
        let stop = commanded(ClipOperation::Stop(IdExpr::Single(4)));
        let stop_command = stop.command_id;
        assert_eq!(
            armed.arm(9.0, stop, false),
            vec![start_command, stop_command]
        );
        assert!(armed.is_empty());
    }

    /// Verifies launching now hands back every waiting operation and leaves none armed.
    #[test]
    fn take_all_fires_everything_waiting() {
        let mut armed = ArmedLaunches::default();
        armed.arm(
            5.0,
            commanded(ClipOperation::Start(IdExpr::Single(1))),
            true,
        );
        armed.arm(9.0, commanded(ClipOperation::Stop(IdExpr::Single(2))), true);
        assert_eq!(armed.take_all().len(), 2);
        assert!(armed.is_empty());
    }
}
