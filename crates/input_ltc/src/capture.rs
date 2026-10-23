// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Audio input capture that decodes LTC from one channel of a device.
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use nightfall_timecode::prelude::{ExternalTimecodeFeed, TimecodeAudioInput};
use rodio::cpal::traits::{DeviceTrait, StreamTrait};
use rodio::cpal::{self, ErrorKind, FromSample, Sample, SampleFormat, SizedSample};

use crate::decoder::LtcDecoder;
use crate::devices::find_device;

/// How often the capture thread checks whether it should stop.
const STOP_POLL_INTERVAL: Duration = Duration::from_millis(100);

/// A running capture; dropping it stops the capture thread.
pub struct LtcCapture {
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl LtcCapture {
    /// Starts reading LTC from `input` and publishing decoded frames to `feed`.
    ///
    /// The audio stream lives on its own thread because some backends' streams cannot move
    /// between threads. When the device is missing, fails to open, or reports an error such as
    /// being unplugged, the thread logs why and exits; [`LtcCapture::has_ended`] then reports it so
    /// the caller can retry later.
    ///
    /// `previous` is a capture this one replaces. The new thread waits for it to close its stream
    /// first, since some devices refuse a second stream while the first is open. `retrying`
    /// lowers a failure to open to a debug log, so a device that stays missing warns only once.
    pub fn start(
        input: TimecodeAudioInput,
        feed: ExternalTimecodeFeed,
        previous: Option<LtcCapture>,
        retrying: bool,
    ) -> Self {
        let previous_thread = previous.and_then(LtcCapture::stop);
        let stop = Arc::new(AtomicBool::new(false));
        let stop_for_thread = Arc::clone(&stop);
        let thread = std::thread::Builder::new()
            .name("ltc-input".to_string())
            .spawn(move || {
                if let Some(previous_thread) = previous_thread {
                    let _ = previous_thread.join();
                }
                let failed = Arc::new(AtomicBool::new(false));
                let stream = match open_stream(&input, feed, Arc::clone(&failed)) {
                    Ok(stream) => stream,
                    Err(error) => {
                        if retrying {
                            tracing::debug!(?input, %error, "Could not reopen LTC audio input");
                        } else {
                            tracing::warn!(?input, %error, "Could not open LTC audio input");
                        }
                        return;
                    }
                };
                tracing::info!(?input, "Reading LTC from audio input");
                while !stop_for_thread.load(Ordering::Relaxed) && !failed.load(Ordering::Relaxed) {
                    std::thread::sleep(STOP_POLL_INTERVAL);
                }
                drop(stream);
            })
            .map_err(|error| tracing::warn!(%error, "Could not start LTC input thread"))
            .ok();
        Self { stop, thread }
    }

    /// Asks the capture thread to close its stream and returns the thread, so a replacement can
    /// wait for it.
    fn stop(mut self) -> Option<std::thread::JoinHandle<()>> {
        self.stop.store(true, Ordering::Relaxed);
        self.thread.take()
    }

    /// Returns whether the capture stopped on its own because its device was missing, failed to
    /// open, or failed while streaming.
    pub fn has_ended(&self) -> bool {
        self.thread
            .as_ref()
            .is_none_or(std::thread::JoinHandle::is_finished)
    }
}

impl Drop for LtcCapture {
    /// Asks the capture thread to close its stream. The thread exits on its own within
    /// [`STOP_POLL_INTERVAL`], so dropping never blocks the engine on the audio backend.
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

/// Opens and plays an input stream on `input` that decodes LTC into `feed`.
///
/// `failed` is set when the stream reports an error, such as its device being unplugged.
fn open_stream(
    input: &TimecodeAudioInput,
    feed: ExternalTimecodeFeed,
    failed: Arc<AtomicBool>,
) -> Result<cpal::Stream, String> {
    let device = find_device(input).ok_or("device not found")?;
    let config = device
        .default_input_config()
        .map_err(|error| error.to_string())?;
    let channels = usize::from(config.channels());
    let channel = usize::from(input.channel);
    if channel >= channels {
        return Err(format!(
            "channel {} requested but the device has {channels}",
            input.channel + 1
        ));
    }
    let decoder = LtcDecoder::new(config.sample_rate());
    let format = config.sample_format();
    let config = config.config();
    let stream = match format {
        SampleFormat::F32 => {
            build::<f32>(&device, &config, channels, channel, decoder, feed, failed)
        }
        SampleFormat::I16 => {
            build::<i16>(&device, &config, channels, channel, decoder, feed, failed)
        }
        SampleFormat::I32 => {
            build::<i32>(&device, &config, channels, channel, decoder, feed, failed)
        }
        SampleFormat::U16 => {
            build::<u16>(&device, &config, channels, channel, decoder, feed, failed)
        }
        other => return Err(format!("unsupported sample format {other}")),
    }?;
    stream.play().map_err(|error| error.to_string())?;
    Ok(stream)
}

/// Builds an input stream for samples of type `T`, decoding channel `channel` of
/// `channels`-channel interleaved audio.
fn build<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    channels: usize,
    channel: usize,
    mut decoder: LtcDecoder,
    feed: ExternalTimecodeFeed,
    failed: Arc<AtomicBool>,
) -> Result<cpal::Stream, String>
where
    T: SizedSample + Send + 'static,
    f32: FromSample<T>,
{
    let mut mono = Vec::new();
    device
        .build_input_stream::<T, _, _>(
            *config,
            move |data: &[T], _| {
                let block_end = Instant::now();
                mono.clear();
                mono.extend(
                    data.iter()
                        .skip(channel)
                        .step_by(channels)
                        .map(|&sample| f32::from_sample(sample)),
                );
                for frame in decoder.decode(&mono, block_end) {
                    feed.publish(frame);
                }
            },
            move |error: cpal::Error| match error.kind() {
                ErrorKind::DeviceNotAvailable
                | ErrorKind::HostUnavailable
                | ErrorKind::StreamInvalidated => {
                    tracing::warn!(%error, "LTC audio input stopped");
                    failed.store(true, Ordering::Relaxed);
                }
                ErrorKind::Xrun => tracing::debug!(%error, "LTC audio input overrun"),
                _ => tracing::warn!(%error, "LTC audio input stream error"),
            },
            None,
        )
        .map_err(|error| error.to_string())
}
