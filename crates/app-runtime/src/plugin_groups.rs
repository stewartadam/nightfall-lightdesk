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
use nightfall_engine::logging::LogConfig;
use nightfall_fixtures::prelude::FixtureCompositorPlugin;
use nightfall_fx::prelude::FxPlugin;
use nightfall_fx_module::prelude::FxModulePlugin;
use nightfall_timeline::prelude::TimelinePlugin;
use nightfall_websocket::prelude::WebsocketPlugin;

use crate::feature_integration::FeatureIntegrationExt;

/// Everything the native app runs: the shared [`ShowPlugins`] with the native-only plugins
/// slotted in next to the ones they depend on, then the DMX output and input groups.
pub struct NativePlugins {
    /// Port used by the backend HTTP and WebSocket server.
    pub websocket_port: u16,
    /// Log filter handle the desk's log-level commands update.
    pub log_config: LogConfig,
    /// Whether timeline audio output is enabled process-wide.
    pub timeline_audio_enabled: bool,
    /// DMX output transports.
    pub outputs: OutputPlugins,
    /// DMX and control input transports.
    pub inputs: InputPlugins,
}

impl PluginGroup for NativePlugins {
    /// Builds the shared show plugins, inserts audio after the engine, the websocket server after
    /// the fixture compositor, telemetry commands after the websocket server, the backup role after
    /// telemetry commands, the fixture and object libraries after macros, and FX modules after FX,
    /// then appends the output and input groups.
    fn build(self) -> PluginGroupBuilder {
        let timeline = TimelinePlugin::new(self.timeline_audio_enabled);
        #[cfg(feature = "beat-detection")]
        let timeline = timeline.with_beatgrid_detector(crate::beat_detection_backend::DETECTOR);
        ShowPlugins {
            log_config: self.log_config,
            timeline,
        }
        .build()
        .maybe_core_audio()
        .add_after::<FixtureCompositorPlugin>(WebsocketPlugin::new(self.websocket_port))
        .add_after::<WebsocketPlugin>(crate::telemetry::TelemetryCommandsPlugin)
        .add_after::<crate::telemetry::TelemetryCommandsPlugin>(nightfall_backup::BackupPlugin)
        .maybe_fixture_library()
        .maybe_object_library()
        .add_after::<FxPlugin>(FxModulePlugin)
        .add_group(self.outputs)
        .add_group(self.inputs)
    }
}

/// Control and DMX input plugins: MIDI, LTC, OSC, Art-Net and sACN.
pub struct InputPlugins {
    /// Whether network input plugins may receive data at startup.
    pub network_input_enabled: bool,
    /// Address used by the OSC input listener.
    pub osc_bind_addr: std::net::SocketAddr,
    /// MIDI input port to connect to exclusively, or `None` to connect to every port.
    pub midi_input_port: Option<String>,
}

impl PluginGroup for InputPlugins {
    /// Adds each input transport whose feature is compiled in.
    fn build(self) -> PluginGroupBuilder {
        PluginGroupBuilder::start::<Self>()
            .maybe_midi_input(self.midi_input_port)
            .maybe_ltc_input()
            .maybe_osc_input(self.osc_bind_addr)
            .maybe_artnet_input(self.network_input_enabled)
            .maybe_sacn_input(self.network_input_enabled)
    }
}

/// DMX output plugins.
pub struct OutputPlugins {
    /// Whether network output plugins may send data at startup.
    pub network_output_enabled: bool,
}

impl PluginGroup for OutputPlugins {
    /// Adds each output transport whose feature is compiled in.
    fn build(self) -> PluginGroupBuilder {
        PluginGroupBuilder::start::<Self>()
            .maybe_sacn_output(self.network_output_enabled)
            .maybe_artnet_output(self.network_output_enabled)
            .maybe_usb_output()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verifies every native plugin finds the shared plugin it is inserted after; a missing
    /// target makes `add_after` panic while the group is built, under this feature set.
    #[test]
    fn native_plugins_resolve_every_insertion_point() {
        NativePlugins {
            websocket_port: 0,
            log_config: LogConfig::disconnected(),
            timeline_audio_enabled: false,
            outputs: OutputPlugins {
                network_output_enabled: false,
            },
            inputs: InputPlugins {
                network_input_enabled: false,
                osc_bind_addr: std::net::SocketAddr::from(([127, 0, 0, 1], 0)),
                midi_input_port: None,
            },
        }
        .build();
    }
}
