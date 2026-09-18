// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! This crate provides SACN output

#![warn(missing_docs)]

use bevy_app::prelude::*;
use bevy_ecs::prelude::*;
use nightfall_engine::prelude::*;
use nightfall_io::SacnOutputIdentity;
use nightfall_io::prelude::{IoRuntimeSettings, NetworkInterfaceState, TransportRuntimePolicy};

pub mod output_sacn;
mod service;

/// Prelude for ergonomic imports
pub mod prelude {
    pub use crate::OutputSacnPlugin;
}

fn sync_sacn_output_identity(
    sacn_client: Option<Res<service::SacnOutputClient>>,
    sacn_output_identity: Option<ResMut<SacnOutputIdentity>>,
) {
    let (Some(sacn_client), Some(mut sacn_output_identity)) = (sacn_client, sacn_output_identity)
    else {
        return;
    };
    let source_cid = sacn_client.source_cid();
    if sacn_output_identity.cid != source_cid {
        sacn_output_identity.cid = source_cid;
    }
}

fn sync_sacn_output_binding(
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

    let _ = service::process_sacn_output_service().sync_with_settings(
        &settings,
        &network_interface_state,
        &transport_policy,
    );
}

/// Plugin for adding SACN output to the app
pub struct OutputSacnPlugin {
    /// Whether network output is enabled.
    pub network_output_enabled: bool,
}

impl Default for OutputSacnPlugin {
    fn default() -> Self {
        Self {
            network_output_enabled: true,
        }
    }
}

impl Plugin for OutputSacnPlugin {
    fn build(&self, app: &mut App) {
        tracing::debug!("Registering OutputSacnPlugin");
        app.init_resource::<TransportRuntimePolicy>();
        let sacn_service = service::process_sacn_output_service();
        let _ = sacn_service.configure_network_output_enabled(self.network_output_enabled);
        let sacn_client = sacn_service.client();
        let source_cid = sacn_client.source_cid();
        let sacn_output_identity = SacnOutputIdentity { cid: source_cid };

        app.insert_resource(sacn_client);
        app.insert_resource(sacn_output_identity);
        app.add_systems(Update, sync_sacn_output_identity.in_set(InputHandling));
        app.add_systems(Update, sync_sacn_output_binding.after(EventHandling));
        app.add_systems(
            Update,
            output_sacn::output
                .after(nightfall_fixtures::universe::dmx_universes)
                .in_set(DmxOutput),
        );
    }
}
