// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Opens and closes LTC captures to match the timecodes that follow LTC.
use std::collections::HashMap;
use std::time::{Duration, Instant};

use bevy_ecs::prelude::*;
use nightfall_timecode::prelude::{
    ExternalTimecodeFeed, ExternalTimecodeFeeds, TimecodeAudioInput, TimecodeGenerator,
    TimecodeSource,
};
use uuid::Uuid;

use crate::capture::LtcCapture;

/// How long to wait before reopening a capture whose device was missing or failed.
const RETRY_INTERVAL: Duration = Duration::from_secs(2);

/// One open capture, owned by the timecode reading it.
struct RunningCapture {
    input: TimecodeAudioInput,
    capture: LtcCapture,
    started_at: Instant,
}

/// Open LTC captures, keyed by the uid of the timecode reading each one.
#[derive(Resource, Default)]
pub(crate) struct LtcCaptures(HashMap<Uuid, RunningCapture>);

/// Returns the audio input each started LTC timecode reads.
///
/// Only started timecodes open their input, so an LTC timecode sitting in a show neither holds an
/// audio device nor asks for microphone access until it's used.
fn wanted_inputs<'a>(
    generators: impl Iterator<Item = &'a TimecodeGenerator>,
) -> HashMap<Uuid, TimecodeAudioInput> {
    generators
        .filter(|generator| {
            generator.timecode.source == TimecodeSource::SmpteLtc && generator.is_started()
        })
        .map(|generator| {
            (
                generator.timecode.identifiers.uid,
                generator.timecode.audio_input.clone().unwrap_or_default(),
            )
        })
        .collect()
}

/// Keeps one capture open per started LTC timecode, on the input that timecode names.
///
/// Captures close when their timecode stops, pauses, changes source or input, or is deleted, and
/// one whose device is missing or failed reopens every [`RETRY_INTERVAL`], so replugging an
/// interface resumes timecode without restarting the timecode.
pub(crate) fn sync_ltc_captures(
    generators: Query<&TimecodeGenerator>,
    mut captures: ResMut<LtcCaptures>,
    mut feeds: ResMut<ExternalTimecodeFeeds>,
) {
    let wanted = wanted_inputs(generators.iter());
    let now = Instant::now();

    let stale: Vec<Uuid> = captures
        .0
        .iter()
        .filter(|(uid, running)| {
            let input_changed = wanted.get(uid) != Some(&running.input);
            let retry_due = running.capture.has_ended()
                && now.duration_since(running.started_at) >= RETRY_INTERVAL;
            input_changed || retry_due
        })
        .map(|(uid, _)| *uid)
        .collect();
    for uid in stale {
        captures.0.remove(&uid);
        feeds.unregister_timecode(uid);
    }

    for (uid, input) in wanted {
        if captures.0.contains_key(&uid) {
            continue;
        }
        let feed = ExternalTimecodeFeed::default();
        feeds.register_timecode(uid, TimecodeSource::SmpteLtc, feed.clone());
        captures.0.insert(
            uid,
            RunningCapture {
                capture: LtcCapture::start(input.clone(), feed),
                input,
                started_at: now,
            },
        );
    }
}

#[cfg(test)]
mod tests {
    use nightfall_timecode::prelude::Timecode;

    use super::*;

    /// Builds a generator for a timecode following `source` with the given audio input.
    fn generator(
        source: TimecodeSource,
        audio_input: Option<TimecodeAudioInput>,
    ) -> TimecodeGenerator {
        TimecodeGenerator::new(Timecode {
            source,
            audio_input,
            ..Timecode::default()
        })
    }

    /// Only started LTC timecodes want an input, and one without a configured input reads the
    /// first channel of the default device.
    #[test]
    fn only_started_ltc_timecodes_want_an_input() {
        let mut started_ltc = generator(TimecodeSource::SmpteLtc, None);
        started_ltc.start();
        let idle_ltc = generator(TimecodeSource::SmpteLtc, None);
        let mut started_mtc = generator(TimecodeSource::MidiMtc, None);
        started_mtc.start();
        let configured_input = TimecodeAudioInput {
            device_id: Some("cpal:interface".to_string()),
            channel: 3,
        };
        let mut configured = generator(TimecodeSource::SmpteLtc, Some(configured_input.clone()));
        configured.start();

        let wanted =
            wanted_inputs([&started_ltc, &idle_ltc, &started_mtc, &configured].into_iter());

        assert_eq!(wanted.len(), 2);
        assert_eq!(
            wanted.get(&started_ltc.timecode.identifiers.uid),
            Some(&TimecodeAudioInput::default())
        );
        assert_eq!(
            wanted.get(&configured.timecode.identifiers.uid),
            Some(&configured_input)
        );
    }
}
