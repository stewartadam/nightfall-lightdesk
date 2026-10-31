// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! WebSocket integration for timecode commands.
//!
//! This module handles self-registration with the websocket infrastructure and
//! owns all timecode-related websocket forwarding logic.
use std::collections::HashMap;
use std::sync::atomic::AtomicU64;

use bevy_ecs::prelude::*;
use nightfall_engine::prelude::*;
use serde::{Deserialize, Serialize};

use crate::components::TimecodeGenerator;
use crate::timecode::{Timecode, TimecodeState};

/// Wrapper for serializing timeline messages with WsOutbound-compatible format
#[derive(Serialize)]
#[serde(tag = "type", content = "data")]
#[typeshare::typeshare]
enum TimecodeWsMessage<'a> {
    /// List of all timecodes
    TimecodeDefinitions(&'a [OutboundTimecodeLocal]),
}

/// Websocket payload that publishes local timecode state.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[typeshare::typeshare]
struct OutboundTimecodeLocal {
    timecode: Timecode,
    state: TimecodeState,
}

/// Last time droppable websocket data was sent (ms since epoch)
static LAST_DROPPABLE_SEND_MS: AtomicU64 = AtomicU64::new(0);
const DROPPABLE_INTERVAL_MS: u64 = (1000.0 / 10.0) as u64;

/// Returns the state published for a timecode that has no generator yet.
fn default_timecode_state(timecode: &Timecode) -> TimecodeState {
    TimecodeGenerator::new(timecode.clone()).state
}

fn collect_timecode_definitions(
    timecode_data_provider: &DataProvider<Timecode>,
    generator_states: &HashMap<uuid::Uuid, TimecodeState>,
) -> Vec<OutboundTimecodeLocal> {
    let mut timecodes: Vec<OutboundTimecodeLocal> = timecode_data_provider
        .iter()
        .map(|entry| {
            let timecode = entry.value().clone();
            let state = generator_states
                .get(&timecode.identifiers.uid)
                .cloned()
                .unwrap_or_else(|| default_timecode_state(&timecode));
            OutboundTimecodeLocal { timecode, state }
        })
        .collect();

    timecodes.sort_by_key(|entry| entry.timecode.identifiers.id);
    timecodes
}

/// Broadcasts timecode definitions and state to websocket clients at most once per
/// [`DROPPABLE_INTERVAL_MS`].
pub fn send_timecodes(
    timecode_data_provider: Res<DataProvider<Timecode>>,
    tc_generators: Query<&TimecodeGenerator>,
    broadcaster: Res<ClientEventSink>,
) {
    // Apply rate limit
    let now_ms = web_time::SystemTime::now()
        .duration_since(web_time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let last_send = LAST_DROPPABLE_SEND_MS.load(std::sync::atomic::Ordering::Relaxed);
    let within_rate_limit = now_ms.saturating_sub(last_send) < DROPPABLE_INTERVAL_MS;

    if within_rate_limit {
        return;
    }
    LAST_DROPPABLE_SEND_MS.store(now_ms, std::sync::atomic::Ordering::Relaxed);

    publish_timecodes(&timecode_data_provider, &tc_generators, &broadcaster);
}

/// Publishes every timecode definition with its generator state to the sink's clients.
fn publish_timecodes(
    timecode_data_provider: &DataProvider<Timecode>,
    tc_generators: &Query<&TimecodeGenerator>,
    broadcaster: &ClientEventSink,
) {
    let generator_states: HashMap<uuid::Uuid, TimecodeState> = tc_generators
        .iter()
        .map(|generator| (generator.timecode.identifiers.uid, generator.state.clone()))
        .collect();
    let timecodes = collect_timecode_definitions(timecode_data_provider, &generator_states);

    for entry in &timecodes {
        tracing::trace!(
            timecode_id = entry.timecode.identifiers.id,
            timecode_uid = %entry.timecode.identifiers.uid,
            state_timecode_id = entry.state.timecode_id,
            is_active = entry.state.is_active,
            current_time = ?entry.state.current_time,
            "Broadcasting timecode state"
        );
    }
    broadcaster.publish(
        DISCRIMINATOR_DROPPABLE,
        &TimecodeWsMessage::TimecodeDefinitions(&timecodes),
    );
    tracing::trace!(
        count = timecodes.len(),
        "Sending timecode definitions to websocket clients"
    );
}

/// Handle ResyncState by sending all timecode generator state immediately
pub fn handle_resync_state(
    mut resync: ResyncReplies,
    timecode_data_provider: Res<DataProvider<Timecode>>,
    tc_generators: Query<&TimecodeGenerator>,
) {
    let Some(broadcaster) = resync.sink() else {
        return;
    };

    publish_timecodes(&timecode_data_provider, &tc_generators, &broadcaster);
}

#[cfg(test)]
mod tests {
    use nightfall::prelude::Identifiers;

    use super::*;

    #[test]
    fn collect_timecode_definitions_defaults_state_when_generator_missing() {
        let mut provider = DataProvider::<Timecode>::default();
        let timecode = Timecode {
            identifiers: Identifiers {
                id: 7,
                uid: uuid::Uuid::new_v4(),
                label: "TC".to_string(),
            },
            ..Default::default()
        };
        provider
            .add(timecode.clone())
            .expect("timecode should be added");

        let generator_states = HashMap::new();
        let output = collect_timecode_definitions(&provider, &generator_states);
        assert_eq!(output.len(), 1);
        assert_eq!(output[0].timecode.identifiers.id, 7);
        assert_eq!(output[0].state.timecode_id, 7);
        assert!(!output[0].state.is_active);
        assert_eq!(output[0].state.current_time, std::time::Duration::ZERO);
    }

    #[test]
    fn collect_timecode_definitions_uses_generator_state_when_available() {
        let mut provider = DataProvider::<Timecode>::default();
        let uid = uuid::Uuid::new_v4();
        let timecode = Timecode {
            identifiers: Identifiers {
                id: 3,
                uid,
                label: "TC".to_string(),
            },
            ..Default::default()
        };
        provider
            .add(timecode.clone())
            .expect("timecode should be added");

        let custom_state = TimecodeState {
            is_active: true,
            current_time: std::time::Duration::from_millis(420),
            ..TimecodeState::new(3)
        };
        let mut generator_states = HashMap::new();
        generator_states.insert(uid, custom_state.clone());

        let output = collect_timecode_definitions(&provider, &generator_states);
        assert_eq!(output.len(), 1);
        assert_eq!(output[0].state.timecode_id, custom_state.timecode_id);
        assert_eq!(output[0].state.is_active, custom_state.is_active);
        assert_eq!(output[0].state.current_time, custom_state.current_time);
    }
}
