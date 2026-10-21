// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! SMPTE linear timecode (LTC) input from an audio device.
//!
//! Each timecode following LTC names its own audio input and channel. While such a timecode is
//! started, a capture thread decodes LTC from that channel and publishes frames to a feed
//! registered for that timecode alone.

#![warn(missing_docs)]

mod capture;
mod decoder;
mod devices;
mod sync;
mod websocket;

use bevy_app::prelude::*;
use bevy_ecs::prelude::*;
pub use capture::LtcCapture;
pub use devices::{AudioInputDevice, AudioInputDevices, input_devices};
use nightfall_engine::prelude::*;
use nightfall_timecode::prelude::{ExternalTimecodeFeeds, TimecodePlugin};

/// Prelude for ergonomic imports
pub mod prelude {
    pub use crate::InputLtcPlugin;
}

/// Plugin that reads linear timecode from audio inputs for timecodes whose source is LTC.
pub struct InputLtcPlugin;

impl Plugin for InputLtcPlugin {
    fn build(&self, app: &mut App) {
        tracing::debug!("Registering InputLtcPlugin");
        assert!(
            app.is_plugin_added::<TimecodePlugin>(),
            "InputLtcPlugin requires TimecodePlugin (provides timecode generators and feeds)"
        );
        app.world_mut()
            .get_resource_or_init::<ExternalTimecodeFeeds>();
        app.init_resource::<sync::LtcCaptures>();
        app.init_resource::<devices::AudioInputDiscovery>();
        app.init_resource::<AudioInputDevices>();

        app.add_systems(
            Update,
            (
                sync::sync_ltc_captures.after(EventHandling),
                devices::refresh_audio_input_devices,
            ),
        );
        app.add_systems(
            Render,
            websocket::send_audio_input_devices.in_set(ClientOutput),
        );
        app.add_systems(
            Update,
            websocket::handle_resync_state.in_set(ResyncHandling),
        );
    }
}
