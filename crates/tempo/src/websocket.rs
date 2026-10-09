// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Client protocol for the show tempo.
//!
//! Clients receive the tempo and beat counter rather than per-beat events and animate the
//! beat indicator locally. The state is resent quickly while tempo or phase is easing and
//! on a slow heartbeat otherwise, so client extrapolation never drifts for long.

use std::time::Duration;

use bevy_ecs::prelude::*;
use nightfall_engine::prelude::*;
use serde::Serialize;
use serde_json::Value;
use web_time::Instant;

use crate::engine::TempoSnapshot;
use crate::{ShowTempo, TempoCommand};

/// Minimum interval between state messages while tempo or phase is easing.
const SETTLING_INTERVAL: Duration = Duration::from_millis(100);
/// Interval between state messages while the tempo is steady.
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(1);
/// Distance in beats between the engine's counter and what clients extrapolate from the last
/// message beyond which the state is resent at once, e.g. after a snap.
const JUMP_TOLERANCE_BEATS: f64 = 0.02;

/// Outbound tempo messages.
#[derive(Serialize)]
#[serde(tag = "type", content = "data")]
#[typeshare::typeshare]
pub enum TempoWsMessage {
    /// Current tempo and beat counter.
    TempoState(TempoSnapshot),
}

/// Deserializes a client tempo command and queues it for the command pipeline.
pub fn deserialize_tempo_command(
    world: &mut World,
    json: Value,
    command_id: CommandId,
    undo_id: UndoId,
) -> Result<(), String> {
    let command: TempoCommand =
        serde_json::from_value(json).map_err(|e| format!("Failed to parse TempoCommand: {e}"))?;
    world
        .resource_mut::<PendingCommandBuffer>()
        .push(PayloadEnvelope::with_context(
            command_id,
            undo_id,
            Box::new(command),
        ));
    Ok(())
}

/// What was last sent to clients, used to decide when to send again.
#[derive(Default)]
pub struct LastTempoSend {
    /// When the last message went out.
    sent_at: Option<Instant>,
    /// The snapshot that was sent.
    snapshot: Option<TempoSnapshot>,
}

/// Returns whether a new state message is due, given the previous send and the current state.
fn tempo_send_due(
    last: &LastTempoSend,
    current: &TempoSnapshot,
    settling: bool,
    now: Instant,
) -> bool {
    let (Some(sent_at), Some(sent)) = (last.sent_at, last.snapshot.as_ref()) else {
        return true;
    };
    let since = now.saturating_duration_since(sent_at);
    let targets_changed =
        sent.target_bpm != current.target_bpm || sent.beats_per_bar != current.beats_per_bar;
    let client_estimate = sent.beat_position + since.as_secs_f64() * sent.effective_bpm / 60.0;
    let jumped = (current.beat_position - client_estimate).abs() > JUMP_TOLERANCE_BEATS;
    targets_changed
        || jumped
        || (settling && since >= SETTLING_INTERVAL)
        || (sent.bpm != current.bpm && since >= SETTLING_INTERVAL)
        || since >= HEARTBEAT_INTERVAL
}

/// Publishes the tempo state when it changed, while it is easing, and on a heartbeat.
pub fn send_tempo_state(
    tempo: Res<ShowTempo>,
    broadcaster: Res<ClientEventSink>,
    mut last: Local<LastTempoSend>,
) {
    let snapshot = tempo.snapshot();
    let now = Instant::now();
    if !tempo_send_due(&last, &snapshot, tempo.is_settling(), now) {
        return;
    }
    broadcaster.publish(
        DISCRIMINATOR_DROPPABLE,
        &TempoWsMessage::TempoState(snapshot),
    );
    last.sent_at = Some(now);
    last.snapshot = Some(snapshot);
}

/// Sends the tempo state immediately when a client asks for a full resync.
pub fn handle_resync_state(
    mut events: MessageReader<ResyncRequested>,
    tempo: Res<ShowTempo>,
    broadcaster: Res<ClientEventSink>,
) {
    if events.read().next().is_none() {
        return;
    }
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &TempoWsMessage::TempoState(tempo.snapshot()),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds a steady 120 BPM snapshot with the beat counter at `beat_position`.
    fn snapshot_at(beat_position: f64) -> TempoSnapshot {
        TempoSnapshot {
            bpm: 120.0,
            effective_bpm: 120.0,
            target_bpm: 120.0,
            beats_per_bar: 4,
            beat_position,
            bar_origin: 0.0,
            bars_before_origin: 0,
        }
    }

    /// Returns a send record for a snapshot sent at `sent_at`.
    fn sent(sent_at: Instant, snapshot: TempoSnapshot) -> LastTempoSend {
        LastTempoSend {
            sent_at: Some(sent_at),
            snapshot: Some(snapshot),
        }
    }

    /// Verifies the first state is always sent and a steady tempo then waits for the heartbeat.
    #[test]
    fn steady_tempo_sends_on_heartbeat_only() {
        let start = Instant::now();
        assert!(tempo_send_due(
            &LastTempoSend::default(),
            &snapshot_at(0.0),
            false,
            start
        ));
        let last = sent(start, snapshot_at(0.0));
        let half_second = start + Duration::from_millis(500);
        assert!(!tempo_send_due(
            &last,
            &snapshot_at(1.0),
            false,
            half_second
        ));
        assert!(tempo_send_due(
            &last,
            &snapshot_at(2.0),
            false,
            start + HEARTBEAT_INTERVAL
        ));
    }

    /// Verifies a new target is sent at once and easing is sent at the settling cadence.
    #[test]
    fn changes_and_easing_send_promptly() {
        let start = Instant::now();
        let last = sent(start, snapshot_at(0.0));
        let mut retargeted = snapshot_at(0.0);
        retargeted.target_bpm = 128.0;
        assert!(tempo_send_due(&last, &retargeted, true, start));
        assert!(!tempo_send_due(
            &last,
            &snapshot_at(0.1),
            true,
            start + Duration::from_millis(50)
        ));
        assert!(tempo_send_due(
            &last,
            &snapshot_at(0.2),
            true,
            start + SETTLING_INTERVAL
        ));
    }

    /// Verifies a jump of the beat counter, such as a snap, is sent without waiting.
    #[test]
    fn counter_jump_sends_immediately() {
        let start = Instant::now();
        let last = sent(start, snapshot_at(1.0));
        let shortly = start + Duration::from_millis(10);
        assert!(tempo_send_due(&last, &snapshot_at(4.0), false, shortly));
    }

    /// Verifies client commands are queued with their command identity.
    #[test]
    fn deserialize_queues_tempo_command() {
        let mut world = World::new();
        world.insert_resource(PendingCommandBuffer::default());
        let command_id = CommandId::new();
        deserialize_tempo_command(
            &mut world,
            serde_json::json!({ "type": "SetBpm", "data": 128.0 }),
            command_id,
            UndoId::new(),
        )
        .expect("tempo command should deserialize");
        let queued = world.resource_mut::<PendingCommandBuffer>().drain();
        assert_eq!(queued.len(), 1);
        assert_eq!(queued[0].command_id, command_id);
        assert_eq!(
            queued[0].payload.as_any().downcast_ref::<TempoCommand>(),
            Some(&TempoCommand::SetBpm(128.0))
        );
    }
}
