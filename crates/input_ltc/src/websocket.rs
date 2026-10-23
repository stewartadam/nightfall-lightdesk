// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Publishes the audio inputs LTC can be read from to clients.
use bevy_ecs::prelude::*;
use nightfall_engine::prelude::*;
use serde::Serialize;

use crate::devices::{AudioInputDevice, AudioInputDevices};

/// WebSocket messages for LTC input.
#[derive(Serialize)]
#[serde(tag = "type", content = "data")]
#[typeshare::typeshare]
pub enum LtcWsMessage<'a> {
    /// Audio input devices a timecode can read LTC from.
    AudioInputDevices(&'a [AudioInputDevice]),
}

/// Sends the audio input list to clients.
fn send_devices(devices: &AudioInputDevices, broadcaster: &ClientEventSink) {
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &LtcWsMessage::AudioInputDevices(&devices.0),
    );
}

/// Sends the audio input list whenever discovery finds a different set of devices.
pub(crate) fn send_audio_input_devices(
    devices: Res<AudioInputDevices>,
    broadcaster: Res<ClientEventSink>,
) {
    if devices.is_changed() {
        send_devices(&devices, &broadcaster);
    }
}

/// Sends the audio input list to clients that asked for a full resync.
pub(crate) fn handle_resync_state(
    mut events: MessageReader<ResyncRequested>,
    devices: Res<AudioInputDevices>,
    broadcaster: Res<ClientEventSink>,
) {
    if events.read().next().is_some() {
        send_devices(&devices, &broadcaster);
    }
}
