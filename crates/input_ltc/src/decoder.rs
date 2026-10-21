// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! SMPTE linear timecode (LTC) decoding from audio samples.
//!
//! LTC sends one 80-bit word per frame using biphase mark coding: the signal flips at the start
//! of every bit, and flips again halfway through a 1 bit. The decoder measures the time between
//! zero crossings, turns them into bits against an adaptive estimate of the bit length, and
//! reads a frame whenever the last 16 bits form the sync word.
use std::time::{Duration, Instant};

use nightfall_timecode::external::frames_to_duration;
use nightfall_timecode::prelude::{
    ExternalTimecodeFrame, PlayStateInference, SmpteTime, TimecodeRate,
};

/// Bits per LTC frame.
const FRAME_BITS: u32 = 80;

/// Sync word in bits 64-79 as received in forward playback, read with bit 64 as the lowest bit.
const SYNC_WORD: u128 = 0xBFFC;

/// Amplitude a sample must pass, either way, before the decoder counts a zero crossing. Keeps
/// noise around silence from producing bits.
const HYSTERESIS: f32 = 0.02;

/// Decodes LTC from one audio channel.
#[derive(Debug)]
pub(crate) struct LtcDecoder {
    sample_rate: f32,
    /// Whether the signal was last seen above `HYSTERESIS` (or below its negative).
    high: bool,
    /// Samples since the last zero crossing.
    since_crossing: f32,
    /// Running estimate of one bit's length in samples.
    bit_length: f32,
    /// Whether the first half of a 1 bit has been seen and its second half is expected.
    half_bit_pending: bool,
    /// The last 80 bits, oldest in bit 0.
    window: u128,
    /// Bits received since the window last held a full frame.
    bits_seen: u32,
    /// Tells a playing sender from one parked on a repeated frame, since LTC carries no play
    /// state.
    play_state: PlayStateInference,
}

impl LtcDecoder {
    /// Creates a decoder for audio at `sample_rate` samples per second.
    pub(crate) fn new(sample_rate: u32) -> Self {
        let sample_rate = sample_rate as f32;
        Self {
            sample_rate,
            high: false,
            since_crossing: 0.0,
            bit_length: sample_rate / (27.5 * FRAME_BITS as f32),
            half_bit_pending: false,
            window: 0,
            bits_seen: 0,
            play_state: PlayStateInference::default(),
        }
    }

    /// Decodes a block of samples whose last sample arrived at `block_end`, returning the frames
    /// completed in it.
    ///
    /// Each frame's position is the address it carried plus one frame, since a word finishes
    /// arriving at the end of the frame it labels, and its arrival time is the time of the sample
    /// that completed it.
    pub(crate) fn decode(
        &mut self,
        samples: &[f32],
        block_end: Instant,
    ) -> Vec<ExternalTimecodeFrame> {
        let mut frames = Vec::new();
        for (index, &sample) in samples.iter().enumerate() {
            self.since_crossing += 1.0;
            let crossed = if self.high {
                sample < -HYSTERESIS
            } else {
                sample > HYSTERESIS
            };
            if !crossed {
                continue;
            }
            self.high = !self.high;
            let interval = std::mem::take(&mut self.since_crossing);
            let Some(bit) = self.classify(interval) else {
                continue;
            };
            if let Some((time, drop_frame)) = self.push_bit(bit) {
                let rate = self.rate(drop_frame);
                let samples_after = (samples.len() - 1 - index) as f32;
                let received_at = block_end
                    .checked_sub(Duration::from_secs_f32(samples_after / self.sample_rate))
                    .unwrap_or(block_end);
                let position = time.to_duration(rate) + frames_to_duration(1, rate);
                frames.push(ExternalTimecodeFrame {
                    position,
                    rate,
                    running: self.play_state.observe(position),
                    received_at,
                });
            }
        }
        frames
    }

    /// Turns the interval between two crossings into a bit, or `None` while half of a 1 bit has
    /// arrived or the interval fits no bit length.
    fn classify(&mut self, interval: f32) -> Option<bool> {
        if interval > self.bit_length * 1.5 || interval < self.bit_length * 0.25 {
            // A gap or a glitch, not a bit: wait for the next clean bit boundary.
            self.half_bit_pending = false;
            return None;
        }
        if interval > self.bit_length * 0.75 {
            self.half_bit_pending = false;
            self.bit_length += (interval - self.bit_length) * 0.1;
            return Some(false);
        }
        if self.half_bit_pending {
            self.half_bit_pending = false;
            self.bit_length += (interval * 2.0 - self.bit_length) * 0.05;
            Some(true)
        } else {
            self.half_bit_pending = true;
            None
        }
    }

    /// Shifts `bit` into the frame window and returns the address and drop-frame flag when the
    /// window ends in a sync word.
    fn push_bit(&mut self, bit: bool) -> Option<(SmpteTime, bool)> {
        self.window = (self.window >> 1) | (u128::from(bit) << (FRAME_BITS - 1));
        self.bits_seen = (self.bits_seen + 1).min(FRAME_BITS);
        if self.bits_seen < FRAME_BITS || (self.window >> 64) & 0xFFFF != SYNC_WORD {
            return None;
        }
        let field = |start: u32, width: u32| ((self.window >> start) & ((1 << width) - 1)) as u8;
        let time = SmpteTime {
            frames: field(0, 4) + field(8, 2) * 10,
            seconds: field(16, 4) + field(24, 3) * 10,
            minutes: field(32, 4) + field(40, 3) * 10,
            hours: field(48, 4) + field(56, 2) * 10,
        };
        let drop_frame = field(10, 1) == 1;
        Some((time, drop_frame))
    }

    /// Infers the frame rate from the bit length, since LTC only flags drop-frame.
    fn rate(&self, drop_frame: bool) -> TimecodeRate {
        if drop_frame {
            return TimecodeRate::Fps29_97;
        }
        let fps = self.sample_rate / (self.bit_length * FRAME_BITS as f32);
        if fps < 24.5 {
            TimecodeRate::Fps24
        } else if fps < 27.5 {
            TimecodeRate::Fps25
        } else {
            TimecodeRate::Fps30
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds the 80 bits of an LTC word for `time`, bit 0 first.
    fn ltc_word(time: SmpteTime) -> [bool; 80] {
        let mut bits = [false; 80];
        let mut set = |start: usize, width: usize, value: u8| {
            for offset in 0..width {
                bits[start + offset] = value >> offset & 1 == 1;
            }
        };
        set(0, 4, time.frames % 10);
        set(8, 2, time.frames / 10);
        set(16, 4, time.seconds % 10);
        set(24, 3, time.seconds / 10);
        set(32, 4, time.minutes % 10);
        set(40, 3, time.minutes / 10);
        set(48, 4, time.hours % 10);
        set(56, 2, time.hours / 10);
        for (offset, bit) in [
            false, false, true, true, true, true, true, true, true, true, true, true, true, true,
            false, true,
        ]
        .into_iter()
        .enumerate()
        {
            bits[64 + offset] = bit;
        }
        bits
    }

    /// Renders consecutive frames from `start` as biphase-mark audio at 48 kHz.
    fn ltc_audio(start: SmpteTime, frames: u8, fps: u8, amplitude: f32) -> Vec<f32> {
        let sample_rate = 48_000.0;
        let bit_length = sample_rate / (f32::from(fps) * 80.0);
        let mut level = amplitude;
        let mut samples = Vec::new();
        let mut clock = 0.0_f32;
        for frame in 0..frames {
            let time = SmpteTime {
                frames: (start.frames + frame) % fps,
                seconds: start.seconds + (start.frames + frame) / fps,
                ..start
            };
            for bit in ltc_word(time) {
                level = -level;
                let half = clock + bit_length / 2.0;
                let end = clock + bit_length;
                while (samples.len() as f32) < half {
                    samples.push(level);
                }
                if bit {
                    level = -level;
                }
                while (samples.len() as f32) < end {
                    samples.push(level);
                }
                clock = end;
            }
        }
        // The transition that starts the next word, which completes the last bit.
        let next_half = clock + bit_length / 2.0;
        while (samples.len() as f32) < next_half {
            samples.push(-level);
        }
        samples
    }

    /// Frames decode with their address, a frame added for the time the word took to arrive.
    #[test]
    fn decodes_frames_and_infers_rate() {
        let start = SmpteTime {
            hours: 10,
            minutes: 23,
            seconds: 45,
            frames: 3,
        };
        let audio = ltc_audio(start, 6, 25, 0.5);
        let mut decoder = LtcDecoder::new(48_000);
        let frames = decoder.decode(&audio, Instant::now());

        assert!(frames.len() >= 4, "decoded {} frames", frames.len());
        let last = frames.last().expect("frames decoded");
        assert_eq!(last.rate, TimecodeRate::Fps25);
        let expected = SmpteTime { frames: 8, ..start }.to_duration(TimecodeRate::Fps25)
            + frames_to_duration(1, TimecodeRate::Fps25);
        assert_eq!(last.position, expected);
        assert!(last.running);
    }

    /// 30 fps LTC is recognised from its shorter bits.
    #[test]
    fn recognises_thirty_fps() {
        let start = SmpteTime {
            hours: 1,
            minutes: 0,
            seconds: 0,
            frames: 0,
        };
        let frames = LtcDecoder::new(48_000).decode(&ltc_audio(start, 6, 30, 0.3), Instant::now());
        assert_eq!(
            frames.last().map(|frame| frame.rate),
            Some(TimecodeRate::Fps30)
        );
    }

    /// Silence and low-level noise produce no frames.
    #[test]
    fn silence_decodes_nothing() {
        let noise: Vec<f32> = (0..48_000)
            .map(|index| if index % 2 == 0 { 0.01 } else { -0.01 })
            .collect();
        assert!(
            LtcDecoder::new(48_000)
                .decode(&noise, Instant::now())
                .is_empty()
        );
    }

    /// A frame decoded early in a block is timestamped earlier than the block's end.
    #[test]
    fn arrival_time_accounts_for_later_samples() {
        let start = SmpteTime {
            hours: 0,
            minutes: 0,
            seconds: 1,
            frames: 0,
        };
        let mut audio = ltc_audio(start, 3, 25, 0.5);
        audio.extend(std::iter::repeat_n(0.0, 4_800));
        let block_end = Instant::now();
        let frames = LtcDecoder::new(48_000).decode(&audio, block_end);
        let last = frames.last().expect("frames decoded");
        let lag = block_end - last.received_at;
        assert!(
            lag >= Duration::from_millis(100) && lag <= Duration::from_millis(101),
            "lag was {lag:?}"
        );
    }
}
