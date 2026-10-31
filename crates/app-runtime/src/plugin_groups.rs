// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Plugin groups for organizing related plugins with correct initialization order.

use bevy::app::PluginGroupBuilder;
use bevy::prelude::*;
use nightfall_composition::ShowPlugins;
use nightfall_desk::resources::log_config::LogConfig;
use nightfall_fixtures::prelude::FixtureCompositorPlugin;
use nightfall_fx::prelude::FxPlugin;
use nightfall_fx_module::prelude::FxModulePlugin;
use nightfall_timeline::prelude::TimelinePlugin;
use nightfall_websocket::prelude::WebsocketPlugin;

use crate::feature_integration::FeatureIntegrationExt;

/// The shared [`ShowPlugins`] plus the native app's own: the HTTP and websocket server, FX
/// modules, audio, and the fixture and object libraries.
pub struct NativeShowPlugins {
    /// Port used by the backend HTTP and WebSocket server.
    pub websocket_port: u16,
    /// Log filter handle the desk's log-level commands update.
    pub log_config: LogConfig,
    /// Whether timeline audio output is enabled process-wide.
    pub timeline_audio_enabled: bool,
}

impl PluginGroup for NativeShowPlugins {
    /// Builds the shared show plugins and inserts each native plugin after the one it needs.
    fn build(self) -> PluginGroupBuilder {
        let timeline = TimelinePlugin::new(self.timeline_audio_enabled);
        #[cfg(feature = "beat-detection")]
        let timeline = timeline.with_beatgrid_detector(crate::beat_detection_backend::DETECTOR);
        ShowPlugins {
            log_config: self.log_config,
            timeline,
        }
        .build()
        .add_after::<FixtureCompositorPlugin>(WebsocketPlugin::new(self.websocket_port))
        .add_after::<FxPlugin>(FxModulePlugin)
        .maybe_core_audio()
        .maybe_desk_audio()
        .maybe_fixture_library()
        .maybe_object_library()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verifies every native plugin finds the shared plugin it is inserted after; a missing
    /// target makes `add_after` panic while the group is built, under this feature set.
    #[test]
    fn native_show_plugins_resolve_every_insertion_point() {
        NativeShowPlugins {
            websocket_port: 0,
            log_config: LogConfig::disconnected(),
            timeline_audio_enabled: false,
        }
        .build();
    }
}

/// DMX input plugins.
pub struct InputPlugins {
    /// Whether network input plugins may receive data at startup.
    pub network_input_enabled: bool,
    /// Address used by the OSC input listener.
    pub osc_bind_addr: std::net::SocketAddr,
    /// MIDI input port to connect to exclusively, or `None` to connect to every port.
    pub midi_input_port: Option<String>,
}

impl PluginGroup for InputPlugins {
    fn build(self) -> PluginGroupBuilder {
        PluginGroupBuilder::start::<Self>()
            .maybe_midi_input(self.midi_input_port)
            .maybe_ltc_input()
            .maybe_osc_input(self.osc_bind_addr)
            .maybe_artnet_input(self.network_input_enabled)
            .maybe_sacn_input(self.network_input_enabled)
    }
}

/// DMX Output plugins.
pub struct OutputPlugins {
    pub network_output_enabled: bool,
}

impl PluginGroup for OutputPlugins {
    fn build(self) -> PluginGroupBuilder {
        PluginGroupBuilder::start::<Self>()
            .maybe_sacn_output(self.network_output_enabled)
            .maybe_artnet_output(self.network_output_enabled)
            .maybe_usb_output()
    }
}
