// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Art-Net timecode (ArtTimeCode) decoding.
//!
//! A sender transmits one ArtTimeCode packet per frame while playing. Packets carry no play
//! state, so the decoder infers it: a packet that moves the position a little forward is
//! playing, anything else is a locate.
use std::time::{Duration, Instant};

use artnet_protocol::{FrameType, Timecode};
use nightfall_timecode::prelude::{ExternalTimecodeFrame, SmpteTime, TimecodeRate};

/// Largest forward step between consecutive packets still treated as playing rather than a jump.
const MAX_PLAYING_STEP: Duration = Duration::from_secs(1);

/// Maps an ArtTimeCode frame type to a frame rate.
fn rate_from_frame_type(frame_type: FrameType) -> TimecodeRate {
    match frame_type {
        FrameType::Film => TimecodeRate::Fps24,
        FrameType::EBU => TimecodeRate::Fps25,
        FrameType::DF => TimecodeRate::Fps29_97,
        FrameType::SMPTE => TimecodeRate::Fps30,
    }
}

/// Decodes the Art-Net timecode stream received by one listener.
#[derive(Debug, Default)]
pub(crate) struct ArtNetTimecodeDecoder {
    /// Position of the previous packet, to tell playing from locating.
    previous: Option<Duration>,
}

impl ArtNetTimecodeDecoder {
    /// Converts one ArtTimeCode packet into a frame.
    ///
    /// The packet counts as playing when it is at most [`MAX_PLAYING_STEP`] ahead of the previous
    /// one. A repeated position, a backwards step, a long jump or the first packet is a locate.
    pub(crate) fn decode(
        &mut self,
        timecode: &Timecode,
        received_at: Instant,
    ) -> ExternalTimecodeFrame {
        let rate = rate_from_frame_type(timecode.frame_type);
        let position = SmpteTime {
            hours: timecode.hours,
            minutes: timecode.minutes,
            seconds: timecode.seconds,
            frames: timecode.frames,
        }
        .to_duration(rate);
        let running = self
            .previous
            .is_some_and(|previous| position > previous && position - previous <= MAX_PLAYING_STEP);
        self.previous = Some(position);
        ExternalTimecodeFrame {
            position,
            rate,
            running,
            received_at,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds an ArtTimeCode packet at 25 fps.
    fn packet(seconds: u8, frames: u8) -> Timecode {
        Timecode {
            version: [0, 14],
            filler1: 0,
            stream_id: 0,
            frames,
            seconds,
            minutes: 0,
            hours: 1,
            frame_type: FrameType::EBU,
        }
    }

    /// The first packet locates; packets one frame apart play; a repeat pauses.
    #[test]
    fn infers_play_state_from_successive_packets() {
        let mut decoder = ArtNetTimecodeDecoder::default();
        let now = Instant::now();

        let first = decoder.decode(&packet(0, 0), now);
        assert!(!first.running);
        assert_eq!(first.rate, TimecodeRate::Fps25);
        assert_eq!(first.position, Duration::from_secs(3600));

        let second = decoder.decode(&packet(0, 1), now);
        assert!(second.running);
        assert_eq!(second.position, Duration::from_millis(3_600_040));

        assert!(!decoder.decode(&packet(0, 1), now).running);
    }

    /// An encoded ArtTimeCode packet parses back into the fields the decoder reads.
    #[test]
    fn decodes_packets_parsed_from_the_wire() {
        let bytes = artnet_protocol::ArtCommand::OpTimeCode(Timecode {
            frame_type: FrameType::SMPTE,
            ..packet(2, 15)
        })
        .write_to_buffer()
        .expect("packet encodes");
        let Ok(artnet_protocol::ArtCommand::OpTimeCode(parsed)) =
            artnet_protocol::ArtCommand::from_buffer(&bytes)
        else {
            panic!("packet parses as ArtTimeCode");
        };
        let frame = ArtNetTimecodeDecoder::default().decode(&parsed, Instant::now());
        assert_eq!(frame.rate, TimecodeRate::Fps30);
        assert_eq!(frame.position, Duration::from_millis(3_602_500));
    }

    /// Jumps backwards or further than a second ahead are locates, not playback.
    #[test]
    fn jumps_are_locates() {
        let mut decoder = ArtNetTimecodeDecoder::default();
        let now = Instant::now();
        decoder.decode(&packet(10, 0), now);
        assert!(!decoder.decode(&packet(5, 0), now).running);
        assert!(!decoder.decode(&packet(30, 0), now).running);
        assert!(decoder.decode(&packet(30, 1), now).running);
    }
}
