// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Plugin groups for organizing related plugins with correct initialization order.

use bevy::app::PluginGroupBuilder;
use bevy::prelude::*;
use nightfall_actions::ActionsPlugin;
use nightfall_cues::prelude::*;
use nightfall_desk::{prelude::*, resources::log_config::LogConfig};
use nightfall_engine::{EnginePlugin, prelude::ClientBridgePlugin};
use nightfall_fixtures::prelude::*;
use nightfall_flow::prelude::*;
use nightfall_fx::prelude::*;
use nightfall_fx_module::prelude::*;
use nightfall_programmer::prelude::*;
use nightfall_scene_objects::prelude::*;
use nightfall_timecode::prelude::*;
use nightfall_timeline::prelude::*;
use nightfall_undo::prelude::*;
use nightfall_websocket::prelude::*;

use crate::feature_integration::FeatureIntegrationExt;

/// Core infrastructure plugins that must be added together.
pub struct CorePlugins {
    /// Port used by the backend HTTP and WebSocket server.
    pub websocket_port: u16,
}

impl PluginGroup for CorePlugins {
    fn build(self) -> PluginGroupBuilder {
        PluginGroupBuilder::start::<Self>()
            .add(ActionsPlugin)
            .add(EnginePlugin)
            .maybe_core_audio()
            .add(UndoPlugin)
            .add(ClientBridgePlugin)
            .add(FixturePlugin)
            .add(SceneObjectPlugin)
            .add(FixtureCompositorPlugin)
            .add(WebsocketPlugin::new(self.websocket_port))
    }
}

/// Desk and fixture management plugins.
pub struct DeskPlugins {
    pub log_config: LogConfig,
}

impl PluginGroup for DeskPlugins {
    fn build(self) -> PluginGroupBuilder {
        PluginGroupBuilder::start::<Self>()
            .add(DeskPlugin {
                log_config: self.log_config,
            })
            .maybe_desk_audio()
            .add(ProgrammerPlugin)
            .add(CuePlugin)
            .maybe_fixture_library()
            .maybe_object_library()
    }
}

/// Effects and flow plugins.
pub struct FxPlugins;

impl PluginGroup for FxPlugins {
    fn build(self) -> PluginGroupBuilder {
        PluginGroupBuilder::start::<Self>()
            .add(FxPlugin)
            .add(FxModulePlugin)
            .add(FlowPlugin)
    }
}

/// Timecode and timeline plugins.
pub struct TimecodePlugins {
    /// Whether timeline audio output is enabled process-wide.
    pub timeline_audio_enabled: bool,
}

impl PluginGroup for TimecodePlugins {
    fn build(self) -> PluginGroupBuilder {
        PluginGroupBuilder::start::<Self>()
            .add(TimecodePlugin)
            .add(TimelinePlugin::new(self.timeline_audio_enabled))
    }
}

/// DMX input plugins.
pub struct InputPlugins {
    /// Whether network input plugins may receive data at startup.
    pub network_input_enabled: bool,
    /// Address used by the OSC input listener.
    pub osc_bind_addr: std::net::SocketAddr,
}

impl PluginGroup for InputPlugins {
    fn build(self) -> PluginGroupBuilder {
        PluginGroupBuilder::start::<Self>()
            .maybe_midi_input()
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
