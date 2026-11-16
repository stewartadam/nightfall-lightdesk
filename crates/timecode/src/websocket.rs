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
use std::time::Duration;

use bevy_ecs::prelude::*;
use bevy_ecs::system::SystemParam;
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

/// How often the timecodes are sent.
pub(crate) const SEND_INTERVAL: Duration = Duration::from_millis(100);

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

/// The timecode definitions and generator state feed, sent every [`SEND_INTERVAL`] so running
/// generators stay current in client views.
#[derive(SystemParam)]
pub(crate) struct TimecodesFeed<'w, 's> {
    timecodes: Res<'w, DataProvider<Timecode>>,
    generators: Query<'w, 's, &'static TimecodeGenerator>,
}

impl ClientFeed for TimecodesFeed<'static, 'static> {
    /// Publishes every timecode definition with its generator state as a snapshot, so a newer
    /// one replaces one still queued.
    fn publish(feed: &TimecodesFeed<'_, '_>, sink: &ClientEventSink) {
        let generator_states: HashMap<uuid::Uuid, TimecodeState> = feed
            .generators
            .iter()
            .map(|generator| (generator.timecode.identifiers.uid, generator.state.clone()))
            .collect();
        let timecodes = collect_timecode_definitions(&feed.timecodes, &generator_states);
        sink.publish(
            DISCRIMINATOR_DROPPABLE,
            &TimecodeWsMessage::TimecodeDefinitions(&timecodes),
        );
    }
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
