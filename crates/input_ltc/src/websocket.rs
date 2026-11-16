// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Publishes the audio inputs LTC can be read from to clients.
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

impl ResourceFeed for AudioInputDevices {
    /// Publishes the audio inputs a timecode can read LTC from.
    fn publish(&self, sink: &ClientEventSink) {
        sink.publish(
            DISCRIMINATOR_NON_DROPPABLE,
            &LtcWsMessage::AudioInputDevices(&self.0),
        );
    }
}
