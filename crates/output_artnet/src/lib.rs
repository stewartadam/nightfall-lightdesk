// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Art-Net DMX output.
//!
//! Each render, the composed frames for every Art-Net output target are handed to a
//! process-lifetime worker, which sends them on the shared schedule of DMX send times.

#![warn(missing_docs)]

use bevy_app::prelude::*;
use bevy_ecs::prelude::*;
use nightfall_engine::prelude::*;
use nightfall_io::prelude::{
    DmxOutputStandby, IoRuntimeSettings, NetworkInterfaceState, TransportRuntimePolicy,
};

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

/// Rebinds the Art-Net worker when IO settings, network interfaces or the standby state change.
///
/// Art-Net has no source priority, so a standby backup keeps its worker stopped instead of
/// sending alongside the primary.
fn sync_artnet_output_binding(
    settings: Option<Res<IoRuntimeSettings>>,
    network_interface_state: Option<Res<NetworkInterfaceState>>,
    transport_policy: Option<Res<TransportRuntimePolicy>>,
    standby: Option<Res<DmxOutputStandby>>,
) {
    let (Some(settings), Some(network_interface_state), Some(transport_policy)) =
        (settings, network_interface_state, transport_policy)
    else {
        return;
    };
    let standby_changed = standby.as_ref().is_some_and(|standby| standby.is_changed());
    if !settings.is_changed() && !network_interface_state.is_changed() && !standby_changed {
        return;
    }

    let _ = service::process_artnet_output_service().sync_with_settings(
        &settings,
        &network_interface_state,
        &unprioritized_output_policy(&transport_policy, standby.as_deref().copied()),
    );
}

/// Returns the host transport policy with network output withheld while this node is a standby
/// backup.
fn unprioritized_output_policy(
    policy: &TransportRuntimePolicy,
    standby: Option<DmxOutputStandby>,
) -> TransportRuntimePolicy {
    let allowed = standby.unwrap_or_default().allows_unprioritized_output();
    TransportRuntimePolicy {
        allow_network_output: policy.allow_network_output && allowed,
        ..*policy
    }
}

impl Plugin for OutputArtnetPlugin {
    fn build(&self, app: &mut App) {
        tracing::debug!("Registering OutputArtnetPlugin");
        app.init_resource::<TransportRuntimePolicy>();
        app.init_resource::<nightfall_io::NetworkStats>();
        output_artnet::register_diagnostics(app);
        let artnet_service = service::process_artnet_output_service();
        let _ = artnet_service.configure_network_output_enabled(self.network_output_enabled);

        app.insert_resource(artnet_service.client());
        app.insert_resource(artnet_service.recent_frames());
        app.add_systems(
            Render,
            output_artnet::output
                .after(nightfall_fixtures::output_frames::compose_output_frames)
                .in_set(DmxOutput),
        );
        app.add_systems(Update, sync_artnet_output_binding.after(EventHandling));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A standby backup withholds Art-Net output even where the host allows it, and an active
    /// node keeps the host's own choice.
    #[test]
    fn standby_withholds_network_output() {
        let allowed = TransportRuntimePolicy::default();
        assert!(
            !unprioritized_output_policy(&allowed, Some(DmxOutputStandby(true)))
                .allow_network_output
        );
        assert!(
            unprioritized_output_policy(&allowed, Some(DmxOutputStandby(false)))
                .allow_network_output
        );
        assert!(unprioritized_output_policy(&allowed, None).allow_network_output);
        let denied = TransportRuntimePolicy::new(false, true, true);
        assert!(
            !unprioritized_output_policy(&denied, Some(DmxOutputStandby(false)))
                .allow_network_output
        );
    }
}
