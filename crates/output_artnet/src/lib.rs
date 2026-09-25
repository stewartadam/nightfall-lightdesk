// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! This crate provides Art-Net output

#![warn(missing_docs)]

use bevy_app::prelude::*;
use bevy_ecs::prelude::*;
use nightfall_engine::prelude::*;
use nightfall_io::ArtNetRecentFramesByUniverse;
use nightfall_io::prelude::{IoRuntimeSettings, NetworkInterfaceState, TransportRuntimePolicy};

pub mod output_artnet;
mod service;

/// Prelude for ergonomic imports
pub mod prelude {
    pub use crate::OutputArtnetPlugin;
}

/// Plugin for adding Art-Net output to the app
pub struct OutputArtnetPlugin {
    /// Whether network output is enabled.
    pub network_output_enabled: bool,
}

impl Default for OutputArtnetPlugin {
    fn default() -> Self {
        Self {
            network_output_enabled: true,
        }
    }
}

fn sync_artnet_output_binding(
    settings: Option<Res<IoRuntimeSettings>>,
    network_interface_state: Option<Res<NetworkInterfaceState>>,
    transport_policy: Option<Res<TransportRuntimePolicy>>,
) {
    let (Some(settings), Some(network_interface_state), Some(transport_policy)) =
        (settings, network_interface_state, transport_policy)
    else {
        return;
    };
    if !settings.is_changed() && !network_interface_state.is_changed() {
        return;
    }

    let _ = service::process_artnet_output_service().sync_with_settings(
        &settings,
        &network_interface_state,
        &transport_policy,
    );
}

impl Plugin for OutputArtnetPlugin {
    fn build(&self, app: &mut App) {
        tracing::debug!("Registering OutputArtnetPlugin");
        app.init_resource::<TransportRuntimePolicy>();
        let artnet_service = service::process_artnet_output_service();
        let _ = artnet_service.configure_network_output_enabled(self.network_output_enabled);
        let artnet_recent_frames = ArtNetRecentFramesByUniverse::new();

        app.insert_resource(artnet_service.client());
        app.insert_resource(artnet_recent_frames);
        app.add_systems(
            Update,
            output_artnet::output
                .after(nightfall_fixtures::output_frames::compose_output_frames)
                .in_set(DmxOutput),
        );
        app.add_systems(Update, sync_artnet_output_binding.after(EventHandling));
    }
}
