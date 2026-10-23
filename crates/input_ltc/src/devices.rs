// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Audio input device discovery for choosing where LTC arrives.
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use bevy_ecs::prelude::*;
use nightfall_timecode::prelude::TimecodeAudioInput;
use rodio::cpal::traits::{DeviceTrait, HostTrait};
use rodio::cpal::{self};
use serde::Serialize;

/// How often the list of audio inputs is refreshed, so plugged-in devices appear without a
/// restart.
const DISCOVERY_INTERVAL: Duration = Duration::from_secs(3);

/// An audio input device a timecode can read LTC from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[typeshare::typeshare]
pub struct AudioInputDevice {
    /// Stable id saved in a timecode's audio input.
    pub id: String,
    /// Name shown to the user.
    pub name: String,
    /// Number of channels in the device's default configuration.
    pub channels: u16,
    /// Whether this is the system default input, which a timecode without a chosen device reads.
    pub is_default: bool,
}

/// Describes `device`, or returns `None` when it has no usable id.
fn device_info(device: &cpal::Device) -> Option<AudioInputDevice> {
    let id = device.id().ok().map(|id| format!("cpal:{id}"))?;
    let name = device
        .description()
        .map(|description| description.name().to_string())
        .unwrap_or_else(|_| id.clone());
    let channels = device
        .default_input_config()
        .map(|config| config.channels())
        .unwrap_or(0);
    Some(AudioInputDevice {
        id,
        name,
        channels,
        is_default: false,
    })
}

/// Lists the audio input devices of the default host, sorted by name, marking the system default.
pub fn input_devices() -> Vec<AudioInputDevice> {
    let host = cpal::default_host();
    let default_id = host
        .default_input_device()
        .and_then(|device| device_info(&device))
        .map(|info| info.id);
    let mut devices: Vec<AudioInputDevice> = host
        .input_devices()
        .map(|devices| devices.filter_map(|device| device_info(&device)).collect())
        .unwrap_or_default();
    for device in &mut devices {
        device.is_default = default_id.as_ref() == Some(&device.id);
    }
    devices.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.id.cmp(&b.id)));
    devices
}

/// Finds the device `input` names, or the default input when it names none. Returns `None` when
/// the device is unplugged.
pub(crate) fn find_device(input: &TimecodeAudioInput) -> Option<cpal::Device> {
    let host = cpal::default_host();
    match &input.device_id {
        None => host.default_input_device(),
        Some(id) => host.input_devices().ok()?.find(|device| {
            device_info(device)
                .as_ref()
                .is_some_and(|info| &info.id == id)
        }),
    }
}

/// Audio inputs currently available, as last discovered.
#[derive(Resource, Debug, Default, Clone, PartialEq, Eq)]
pub struct AudioInputDevices(pub Vec<AudioInputDevice>);

/// Runs device enumeration on a worker thread, since audio backends can take a while to answer
/// and must never stall the engine.
#[derive(Resource, Default)]
pub(crate) struct AudioInputDiscovery {
    pending: Option<JoinHandle<Vec<AudioInputDevice>>>,
    last_started_at: Option<Instant>,
}

impl AudioInputDiscovery {
    /// Collects a finished enumeration, if any, and starts the next one once
    /// [`DISCOVERY_INTERVAL`] has passed since the previous start.
    fn poll(&mut self, now: Instant) -> Option<Vec<AudioInputDevice>> {
        let mut discovered = None;
        if self.pending.as_ref().is_some_and(JoinHandle::is_finished) {
            match self.pending.take().map(JoinHandle::join) {
                Some(Ok(devices)) => discovered = Some(devices),
                Some(Err(_)) => tracing::warn!("Audio input discovery worker panicked"),
                None => {}
            }
        }
        let due = self
            .last_started_at
            .is_none_or(|last| now.duration_since(last) >= DISCOVERY_INTERVAL);
        if self.pending.is_none() && due {
            self.last_started_at = Some(now);
            match std::thread::Builder::new()
                .name("audio-input-discovery".to_string())
                .spawn(input_devices)
            {
                Ok(worker) => self.pending = Some(worker),
                Err(error) => tracing::warn!(%error, "Could not start audio input discovery"),
            }
        }
        discovered
    }
}

/// Refreshes [`AudioInputDevices`] from background discovery, touching the resource only when
/// the list changed so clients hear about real changes only.
pub(crate) fn refresh_audio_input_devices(
    mut discovery: ResMut<AudioInputDiscovery>,
    mut devices: ResMut<AudioInputDevices>,
) {
    if let Some(discovered) = discovery.poll(Instant::now()) {
        devices.set_if_neq(AudioInputDevices(discovered));
    }
}
