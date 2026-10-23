// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! MIDI timecode (MTC) decoding.
//!
//! A playing sender transmits eight quarter-frame messages per two frames, each carrying one
//! nibble of the time address. A stopped sender locates with a single full-frame SysEx message.
use std::time::{Duration, Instant};

use nightfall_timecode::external::frames_to_duration;
use nightfall_timecode::prelude::{ExternalTimecodeFrame, SmpteTime, TimecodeRate};

/// Status byte of an MTC quarter-frame message.
const QUARTER_FRAME: u8 = 0xF1;

/// Returns whether `message` is MIDI timecode rather than a control message.
pub(crate) fn is_timecode_message(message: &[u8]) -> bool {
    message.first() == Some(&QUARTER_FRAME) || full_frame_fields(message).is_some()
}

/// Returns the hour/rate, minute, second and frame bytes of an MTC full-frame message: universal
/// real-time SysEx, MTC sub-id, full frame. Any device id is accepted.
fn full_frame_fields(message: &[u8]) -> Option<[u8; 4]> {
    match message {
        [
            0xF0,
            0x7F,
            _,
            0x01,
            0x01,
            hours,
            minutes,
            seconds,
            frames,
            0xF7,
        ] => Some([*hours, *minutes, *seconds, *frames]),
        _ => None,
    }
}

/// Maps the two rate bits MTC carries with the hours to a frame rate.
fn rate_from_bits(bits: u8) -> TimecodeRate {
    match bits & 0b11 {
        0 => TimecodeRate::Fps24,
        1 => TimecodeRate::Fps25,
        2 => TimecodeRate::Fps29_97,
        _ => TimecodeRate::Fps30,
    }
}

/// Decodes the MTC stream from one MIDI input.
///
/// Each connection keeps its own decoder, since quarter frames from two senders would otherwise
/// interleave into nonsense.
#[derive(Debug, Default)]
pub(crate) struct MtcDecoder {
    /// Nibbles collected for the address being assembled, indexed by piece number.
    pieces: [u8; 8],
    /// Piece expected next, or `None` until a piece 0 starts a forward sequence.
    next_piece: Option<u8>,
    /// Position and rate of the last complete address, in the frame its piece 0 was sent.
    base: Option<(Duration, TimecodeRate)>,
}

impl MtcDecoder {
    /// Feeds one MIDI message and returns the frame it completes, if any.
    ///
    /// Once a full address has been assembled, every forward quarter frame yields a running frame
    /// a quarter frame later than the one before. A full-frame message yields a locate and resets
    /// the quarter-frame sequence. Messages that break the forward sequence, such as a sender
    /// shuttling backwards, drop the lock until the next complete address.
    pub(crate) fn decode(
        &mut self,
        message: &[u8],
        received_at: Instant,
    ) -> Option<ExternalTimecodeFrame> {
        if let Some([hours, minutes, seconds, frames]) = full_frame_fields(message) {
            self.next_piece = None;
            self.base = None;
            let rate = rate_from_bits(hours >> 5);
            let time = SmpteTime {
                hours: hours & 0x1F,
                minutes,
                seconds,
                frames,
            };
            return Some(ExternalTimecodeFrame {
                position: time.to_duration(rate),
                rate,
                running: false,
                received_at,
            });
        }

        let [QUARTER_FRAME, data] = message else {
            return None;
        };
        let piece = data >> 4;
        if self.next_piece.unwrap_or(0) != piece {
            self.next_piece = None;
            self.base = None;
            // A piece 0 out of sequence still starts a fresh address.
            if piece != 0 {
                return None;
            }
        }
        self.pieces[usize::from(piece)] = data & 0x0F;
        self.next_piece = Some((piece + 1) % 8);

        if piece == 7 {
            let rate = rate_from_bits(self.pieces[7] >> 1);
            let time = SmpteTime {
                frames: self.pieces[0] | (self.pieces[1] & 0x01) << 4,
                seconds: self.pieces[2] | (self.pieces[3] & 0x03) << 4,
                minutes: self.pieces[4] | (self.pieces[5] & 0x03) << 4,
                hours: self.pieces[6] | (self.pieces[7] & 0x01) << 4,
            };
            self.base = Some((time.to_duration(rate), rate));
        }

        let (base, rate) = self.base?;
        // Piece 7 arrives 7 quarter frames after the address's frame began; the pieces of the
        // next sequence follow it, two frames on.
        let quarters = if piece == 7 { 7 } else { 8 + u64::from(piece) };
        Some(ExternalTimecodeFrame {
            position: base + frames_to_duration(quarters, rate) / 4,
            rate,
            running: true,
            received_at,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds the eight quarter-frame data bytes for an address at 25 fps.
    fn quarter_frames(hours: u8, minutes: u8, seconds: u8, frames: u8) -> [u8; 8] {
        let rate_bits = 1 << 1;
        [
            frames & 0x0F,
            0x10 | frames >> 4,
            0x20 | (seconds & 0x0F),
            0x30 | seconds >> 4,
            0x40 | (minutes & 0x0F),
            0x50 | minutes >> 4,
            0x60 | (hours & 0x0F),
            0x70 | rate_bits | hours >> 4,
        ]
    }

    /// A full sequence of quarter frames locks on piece 7, and the following pieces advance a
    /// quarter frame each.
    #[test]
    fn quarter_frames_lock_and_advance() {
        let mut decoder = MtcDecoder::default();
        let now = Instant::now();
        let pieces = quarter_frames(1, 2, 3, 4);
        for data in &pieces[..7] {
            assert!(decoder.decode(&[QUARTER_FRAME, *data], now).is_none());
        }
        let locked = decoder
            .decode(&[QUARTER_FRAME, pieces[7]], now)
            .expect("piece 7 completes the address");
        let address = Duration::from_secs(3723) + Duration::from_millis(160);
        assert!(locked.running);
        assert_eq!(locked.rate, TimecodeRate::Fps25);
        assert_eq!(locked.position, address + Duration::from_millis(70));

        let next = quarter_frames(1, 2, 3, 6);
        let following = decoder
            .decode(&[QUARTER_FRAME, next[0]], now)
            .expect("locked decoder reports every quarter frame");
        assert_eq!(following.position, address + Duration::from_millis(80));
    }

    /// A piece out of order drops the lock until the next complete sequence.
    #[test]
    fn out_of_order_piece_drops_lock() {
        let mut decoder = MtcDecoder::default();
        let now = Instant::now();
        for data in quarter_frames(0, 0, 1, 0) {
            decoder.decode(&[QUARTER_FRAME, data], now);
        }
        assert!(decoder.decode(&[QUARTER_FRAME, 0x30], now).is_none());
        assert!(decoder.decode(&[QUARTER_FRAME, 0x10], now).is_none());

        let restart = quarter_frames(0, 0, 2, 0);
        for data in &restart[..7] {
            assert!(decoder.decode(&[QUARTER_FRAME, *data], now).is_none());
        }
        let relocked = decoder
            .decode(&[QUARTER_FRAME, restart[7]], now)
            .expect("a fresh sequence locks again");
        assert_eq!(relocked.position, Duration::from_millis(2070));
    }

    /// A piece 0 arriving mid-sequence starts a new address instead of being dropped.
    #[test]
    fn piece_zero_restarts_sequence() {
        let mut decoder = MtcDecoder::default();
        let now = Instant::now();
        let pieces = quarter_frames(0, 0, 3, 0);
        decoder.decode(&[QUARTER_FRAME, pieces[0]], now);
        decoder.decode(&[QUARTER_FRAME, pieces[1]], now);
        for data in &pieces[..7] {
            assert!(decoder.decode(&[QUARTER_FRAME, *data], now).is_none());
        }
        assert!(decoder.decode(&[QUARTER_FRAME, pieces[7]], now).is_some());
    }

    /// A full-frame message is a locate carrying its rate in the hour byte.
    #[test]
    fn full_frame_is_a_locate() {
        let mut decoder = MtcDecoder::default();
        let message = [0xF0, 0x7F, 0x7F, 0x01, 0x01, 0x60 | 1, 0, 0, 15, 0xF7];
        assert!(is_timecode_message(&message));
        let frame = decoder
            .decode(&message, Instant::now())
            .expect("full frame decodes");
        assert!(!frame.running);
        assert_eq!(frame.rate, TimecodeRate::Fps30);
        assert_eq!(frame.position, Duration::from_millis(3_600_500));
    }

    /// Control messages and unrelated SysEx are not timecode.
    #[test]
    fn control_messages_are_not_timecode() {
        assert!(!is_timecode_message(&[0x90, 60, 100]));
        assert!(!is_timecode_message(&[0xF0, 0x7E, 0x7F, 0x06, 0x01, 0xF7]));
    }
}
