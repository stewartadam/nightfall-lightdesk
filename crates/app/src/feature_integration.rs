// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::net::SocketAddr;

use bevy::app::PluginGroupBuilder;
#[cfg(feature = "audio")]
use nightfall_audio::prelude::*;
#[cfg(feature = "audio")]
use nightfall_desk_audio::prelude::*;
#[cfg(feature = "fixture-library")]
use nightfall_fixture_library::prelude::*;
#[cfg(feature = "artnet")]
use nightfall_input_artnet::prelude::*;
#[cfg(feature = "midi")]
use nightfall_input_midi::prelude::*;
#[cfg(feature = "osc")]
use nightfall_input_osc::prelude::*;
#[cfg(feature = "sacn")]
use nightfall_input_sacn::prelude::*;
#[cfg(feature = "object-library")]
use nightfall_object_library::prelude::*;
#[cfg(feature = "artnet")]
use nightfall_output_artnet::prelude::*;
#[cfg(feature = "sacn")]
use nightfall_output_sacn::prelude::*;
#[cfg(feature = "usb")]
use nightfall_output_usb::prelude::*;

pub trait FeatureIntegrationExt {
    fn maybe_core_audio(self) -> Self;
    fn maybe_desk_audio(self) -> Self;
    fn maybe_fixture_library(self) -> Self;
    fn maybe_object_library(self) -> Self;
    fn maybe_midi_input(self) -> Self;
    fn maybe_osc_input(self, bind_addr: SocketAddr) -> Self;
    fn maybe_artnet_input(self, network_input_enabled: bool) -> Self;
    fn maybe_sacn_input(self, network_input_enabled: bool) -> Self;
    fn maybe_sacn_output(self, network_output_enabled: bool) -> Self;
    fn maybe_artnet_output(self, network_output_enabled: bool) -> Self;
    fn maybe_usb_output(self) -> Self;
}

impl FeatureIntegrationExt for PluginGroupBuilder {
    #[cfg(feature = "audio")]
    fn maybe_core_audio(self) -> Self {
        self.add(AudioPlugin)
    }

    #[cfg(not(feature = "audio"))]
    fn maybe_core_audio(self) -> Self {
        self
    }

    #[cfg(feature = "audio")]
    fn maybe_desk_audio(self) -> Self {
        self.add(DeskAudioPlugin)
    }

    #[cfg(not(feature = "audio"))]
    fn maybe_desk_audio(self) -> Self {
        self
    }

    #[cfg(feature = "fixture-library")]
    fn maybe_fixture_library(self) -> Self {
        self.add(FixtureLibraryPlugin)
    }

    #[cfg(not(feature = "fixture-library"))]
    fn maybe_fixture_library(self) -> Self {
        self
    }

    #[cfg(feature = "object-library")]
    fn maybe_object_library(self) -> Self {
        self.add(ObjectLibraryPlugin)
    }

    #[cfg(not(feature = "object-library"))]
    fn maybe_object_library(self) -> Self {
        self
    }

    #[cfg(feature = "midi")]
    fn maybe_midi_input(self) -> Self {
        self.add(InputMidiPlugin)
    }

    #[cfg(not(feature = "midi"))]
    fn maybe_midi_input(self) -> Self {
        self
    }

    #[cfg(feature = "osc")]
    fn maybe_osc_input(self, bind_addr: SocketAddr) -> Self {
        self.add(InputOscPlugin::new(bind_addr))
    }

    #[cfg(not(feature = "osc"))]
    fn maybe_osc_input(self, _bind_addr: SocketAddr) -> Self {
        self
    }

    #[cfg(feature = "artnet")]
    fn maybe_artnet_input(self, network_input_enabled: bool) -> Self {
        self.add(InputArtnetPlugin {
            network_input_enabled,
        })
    }

    #[cfg(not(feature = "artnet"))]
    fn maybe_artnet_input(self, _network_input_enabled: bool) -> Self {
        self
    }

    #[cfg(feature = "sacn")]
    fn maybe_sacn_input(self, network_input_enabled: bool) -> Self {
        self.add(InputSacnPlugin {
            network_input_enabled,
        })
    }

    #[cfg(not(feature = "sacn"))]
    fn maybe_sacn_input(self, _network_input_enabled: bool) -> Self {
        self
    }

    #[cfg(feature = "sacn")]
    fn maybe_sacn_output(self, network_output_enabled: bool) -> Self {
        self.add(OutputSacnPlugin {
            network_output_enabled,
        })
    }

    #[cfg(not(feature = "sacn"))]
    fn maybe_sacn_output(self, _network_output_enabled: bool) -> Self {
        self
    }

    #[cfg(feature = "artnet")]
    fn maybe_artnet_output(self, network_output_enabled: bool) -> Self {
        self.add(OutputArtnetPlugin {
            network_output_enabled,
        })
    }

    #[cfg(not(feature = "artnet"))]
    fn maybe_artnet_output(self, _network_output_enabled: bool) -> Self {
        self
    }

    #[cfg(feature = "usb")]
    fn maybe_usb_output(self) -> Self {
        self.add(OutputUdmxUsbPlugin)
    }

    #[cfg(not(feature = "usb"))]
    fn maybe_usb_output(self) -> Self {
        self
    }
}
