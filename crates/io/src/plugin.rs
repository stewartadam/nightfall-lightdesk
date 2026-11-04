// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Registers the transport settings, the network interface feed, and IO failure toasts.

use bevy_app::prelude::*;
use bevy_ecs::prelude::*;
use nightfall_engine::prelude::*;

use crate::{
    InputUniverseVisibilityMode, IoRuntimeNotification, IoRuntimeSettings, NetworkDmxOutputTargets,
    NetworkInterfaceState, NetworkStats, RouteTransport, UsbDmxOutputTargets, network_interfaces,
    network_stats, sanitize_input_signal_loss_timeout, settings_command,
};

/// Section the showfile's input and output transport settings are saved and sent under.
pub const IO_SETTINGS_SECTION: SettingsSection<IoRuntimeSettings> = SettingsSection::new("io");

/// `Update` system set, inside [`EventHandling`] and after [`SettingsCommandHandling`], in which
/// the IO settings are clamped and copied into the resources transports read, and the host's
/// network interface snapshot is refreshed.
///
/// Systems that react to IO settings or interface changes order themselves after this set, so
/// they see the clamped settings and the new snapshot in the same frame.
#[derive(SystemSet, Debug, Clone, PartialEq, Eq, Hash)]
pub struct IoStateSync;

/// Owns the showfile's transport settings and their command, the live output targets derived
/// from them, the host's network interfaces with their feed and loss alerts, and the toasts for
/// IO listener failures.
pub struct IoPlugin;

impl Plugin for IoPlugin {
    /// Registers the IO settings section and command, the resources transports read, and the
    /// systems that keep them, the client feed, and operator alerts current.
    fn build(&self, app: &mut App) {
        tracing::debug!("Registering IoPlugin");
        app.register_settings_section(IO_SETTINGS_SECTION);
        app.add_settings_command(settings_command::apply);
        app.init_resource::<NetworkDmxOutputTargets>();
        app.init_resource::<UsbDmxOutputTargets>();
        app.init_resource::<InputUniverseVisibilityMode>();
        app.init_resource::<NetworkInterfaceState>();
        app.init_resource::<NetworkStats>();
        app.add_message::<NotificationEnvelope<IoRuntimeNotification>>();

        app.configure_sets(
            Update,
            IoStateSync
                .in_set(EventHandling)
                .after(SettingsCommandHandling),
        );
        app.add_systems(
            Update,
            (
                sync_runtime_resources_from_settings.in_set(IoStateSync),
                network_interfaces::alerts::announce_network_interface_changes
                    .in_set(EventHandling)
                    .after(IoStateSync),
            ),
        );
        #[cfg(feature = "native-network-watch")]
        {
            app.add_systems(Startup, network_interfaces::init_network_interface_watcher);
            app.add_systems(
                Update,
                network_interfaces::refresh_network_interface_state.in_set(IoStateSync),
            );
        }
        app.add_systems(
            PostUpdate,
            forward_io_runtime_notifications
                .in_set(ClientFeedback)
                .before(nightfall_engine::ui_notification::forward_ui_notifications),
        );
        app.add_systems(
            Render,
            (
                network_interfaces::send_network_interfaces_on_change,
                network_stats::feed::send_failures_on_change,
            )
                .in_set(ClientOutput),
        );
        app.add_systems(
            Update,
            (
                network_interfaces::handle_resync_state,
                network_stats::feed::handle_resync_state,
            )
                .in_set(ResyncHandling)
                .before(nightfall_engine::ui_notification::send_pending_ui_notifications_on_resync),
        );
    }
}

/// Copies changed transport settings into the resources transports read each frame: sanitized
/// output targets and the input visibility mode. A signal-loss timeout loaded from a showfile is
/// clamped in place so the saved settings match what inputs use.
pub(crate) fn sync_runtime_resources_from_settings(
    mut settings: ResMut<IoRuntimeSettings>,
    mut network_dmx_outputs: ResMut<NetworkDmxOutputTargets>,
    mut usb_dmx_outputs: ResMut<UsbDmxOutputTargets>,
    mut visibility_mode: ResMut<InputUniverseVisibilityMode>,
) {
    if !settings.is_changed() {
        return;
    }
    let timeout = sanitize_input_signal_loss_timeout(settings.input_signal_loss_timeout);
    if settings.input_signal_loss_timeout != timeout {
        settings.input_signal_loss_timeout = timeout;
    }
    let sanitized = settings.network_dmx_outputs.sanitized();
    if *network_dmx_outputs != sanitized {
        *network_dmx_outputs = sanitized;
    }
    let sanitized = settings.usb_dmx_outputs.sanitized();
    if *usb_dmx_outputs != sanitized {
        *usb_dmx_outputs = sanitized;
    }
    if *visibility_mode != settings.input_universe_visibility_mode {
        *visibility_mode = settings.input_universe_visibility_mode;
    }
}

/// Shows IO listener failures to the operator, so protocol adapters report them without
/// depending on UI notification contracts.
pub(crate) fn forward_io_runtime_notifications(
    mut notifications: MessageReader<NotificationEnvelope<IoRuntimeNotification>>,
    mut ui_notifications: MessageWriter<UiNotification>,
) {
    for event in notifications.read() {
        match event.notification {
            IoRuntimeNotification::InputBindFailed { transport, port } => {
                let protocol = match transport {
                    RouteTransport::ArtNet => "Art-Net",
                    RouteTransport::Sacn => "sACN",
                    RouteTransport::Udmx => "uDMX",
                };
                ui_notifications.write(UiNotification::toast(
                    ToastLevel::Warning,
                    format!(
                        "{protocol} input could not bind UDP {port}; network input has been \
                         disabled."
                    ),
                ));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    /// Verifies IO failures are presented as warnings without adapter-owned UI contracts.
    #[test]
    fn io_bind_failures_forward_to_operator_warnings() {
        let mut app = App::new();
        app.add_message::<NotificationEnvelope<IoRuntimeNotification>>();
        app.add_message::<UiNotification>();
        app.add_systems(Update, forward_io_runtime_notifications);
        for (transport, port) in [(RouteTransport::ArtNet, 6454), (RouteTransport::Sacn, 5568)] {
            app.world_mut()
                .write_message(NotificationEnvelope::detached(
                    IoRuntimeNotification::InputBindFailed { transport, port },
                ));
        }
        app.update();
        let messages: Vec<_> = app
            .world_mut()
            .resource_mut::<Messages<UiNotification>>()
            .drain()
            .collect();
        assert_eq!(messages.len(), 2);
        for (notification, expected) in messages.iter().zip([
            "Art-Net input could not bind UDP 6454",
            "sACN input could not bind UDP 5568",
        ]) {
            let UiNotification::ShowToast { level, message, .. } = notification else {
                panic!("expected a toast")
            };
            assert_eq!(*level, ToastLevel::Warning);
            assert!(message.starts_with(expected));
            assert!(message.ends_with("network input has been disabled."));
        }
    }

    /// Verifies loaded or edited settings reach the resources transports read, and that a zero
    /// signal-loss timeout is clamped in the saved settings too.
    #[test]
    fn settings_changes_reach_runtime_resources() {
        let mut app = App::new();
        app.init_resource::<IoRuntimeSettings>()
            .init_resource::<NetworkDmxOutputTargets>()
            .init_resource::<UsbDmxOutputTargets>()
            .init_resource::<InputUniverseVisibilityMode>()
            .add_systems(Update, sync_runtime_resources_from_settings);
        app.update();

        {
            let mut settings = app.world_mut().resource_mut::<IoRuntimeSettings>();
            settings.input_signal_loss_timeout = Duration::ZERO;
            settings.input_universe_visibility_mode = InputUniverseVisibilityMode::AllDetected;
        }
        app.update();

        assert_eq!(
            *app.world().resource::<InputUniverseVisibilityMode>(),
            InputUniverseVisibilityMode::AllDetected
        );
        assert_eq!(
            app.world()
                .resource::<IoRuntimeSettings>()
                .input_signal_loss_timeout,
            Duration::from_millis(1)
        );
        assert_eq!(
            *app.world().resource::<NetworkDmxOutputTargets>(),
            app.world()
                .resource::<IoRuntimeSettings>()
                .network_dmx_outputs
                .sanitized()
        );
    }
}
