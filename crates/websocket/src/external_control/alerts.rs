// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Tells operators when the interface External control listens on disappears or returns.
//!
//! The listener never falls back from a missing interface to another one, so other devices stay
//! locked out until the same interface reappears. These toasts make that visible and point the
//! operator at the setting that changes it.

use bevy_ecs::prelude::*;
use nightfall_engine::prelude::{ToastAction, ToastLevel, UiNotification};
use nightfall_io::NetworkInterfaceState;

use super::{ExternalControlSettings, ExternalControlState};

/// Compares each new host interface snapshot with the previous one and toasts the transitions
/// that affect the External control listener.
///
/// The first snapshot seen is only recorded: a listener that starts with its interface missing
/// is already reported by Settings, and toasting at startup would repeat on every launch.
pub(crate) fn announce_external_control_interface_changes(
    interfaces: Res<NetworkInterfaceState>,
    external_control: Res<ExternalControlState>,
    mut previous: Local<Option<NetworkInterfaceState>>,
    mut ui_notifications: MessageWriter<UiNotification>,
) {
    let Some(last) = previous.as_ref() else {
        *previous = Some(interfaces.clone());
        return;
    };
    if !interfaces.is_changed() || *last == *interfaces {
        return;
    }
    if external_control.available {
        ui_notifications.write_batch(external_control_toasts(
            last,
            &interfaces,
            &external_control.settings,
        ));
    }
    *previous = Some(interfaces.clone());
}

/// Builds toasts for the interface External control listens on.
///
/// Listening on all interfaces cannot lose a selection, and a missing selection leaves only local
/// control available until the same interface returns.
fn external_control_toasts(
    previous: &NetworkInterfaceState,
    current: &NetworkInterfaceState,
    settings: &ExternalControlSettings,
) -> Vec<UiNotification> {
    let Some(name) = settings.interface.as_ref().filter(|_| settings.enabled) else {
        return Vec::new();
    };
    let toast = match (previous.find(name), current.find(name)) {
        (Some(lost), None) => UiNotification::toast_with_actions(
            ToastLevel::Warning,
            format!(
                "External control interface {} disconnected. Other devices can't connect until \
                 it reconnects, or choose another interface.",
                lost.display_label()
            ),
            vec![ToastAction::OpenExternalControlSettings],
        ),
        (None, Some(back)) => UiNotification::toast(
            ToastLevel::Info,
            format!(
                "External control interface {} reconnected. Other devices can connect again.",
                back.display_label()
            ),
        ),
        _ => return Vec::new(),
    };
    vec![toast]
}

#[cfg(test)]
mod tests {
    use bevy_app::{App, Update};
    use bevy_ecs::message::Messages;
    use nightfall_io::NetworkInterfaceInfo;

    use super::*;

    /// Builds an interface with one IPv4 address and no friendly name.
    fn iface(name: &str) -> NetworkInterfaceInfo {
        NetworkInterfaceInfo {
            name: name.to_string(),
            friendly_name: None,
            addresses: vec!["192.0.2.10".to_string()],
        }
    }

    /// Builds a host snapshot from the listed interfaces with no default route.
    fn snapshot(available: &[NetworkInterfaceInfo]) -> NetworkInterfaceState {
        NetworkInterfaceState {
            available_interfaces: available.to_vec(),
            default_interface: None,
        }
    }

    /// Splits a toast into its parts for assertions.
    fn parts(notification: &UiNotification) -> (ToastLevel, &str, &[ToastAction]) {
        let UiNotification::ShowToast {
            level,
            message,
            actions,
        } = notification
        else {
            panic!("expected a toast, got {notification:?}");
        };
        (*level, message, actions)
    }

    /// External control warns only for an enabled listener bound to one interface.
    #[test]
    fn external_control_interface_loss_is_announced() {
        let with_lan = snapshot(&[iface("en7")]);
        let without_lan = snapshot(&[]);
        let selected = ExternalControlSettings {
            enabled: true,
            interface: Some("en7".to_string()),
        };

        let lost = external_control_toasts(&with_lan, &without_lan, &selected);
        let (level, message, actions) = parts(&lost[0]);
        assert_eq!(level, ToastLevel::Warning);
        assert!(message.starts_with("External control interface en7 disconnected."));
        assert_eq!(actions, [ToastAction::OpenExternalControlSettings]);
        assert!(
            parts(&external_control_toasts(&without_lan, &with_lan, &selected)[0])
                .1
                .contains("reconnected")
        );

        let all_interfaces = ExternalControlSettings {
            enabled: true,
            interface: None,
        };
        assert!(external_control_toasts(&with_lan, &without_lan, &all_interfaces).is_empty());
        let disabled = ExternalControlSettings {
            enabled: false,
            ..selected
        };
        assert!(external_control_toasts(&with_lan, &without_lan, &disabled).is_empty());
    }

    /// The system records the startup snapshot silently, then toasts later transitions only on a
    /// host whose listener is available.
    #[test]
    fn system_toasts_only_after_the_first_snapshot() {
        let mut app = App::new();
        app.add_message::<UiNotification>()
            .insert_resource(ExternalControlState {
                available: true,
                settings: ExternalControlSettings {
                    enabled: true,
                    interface: Some("en7".to_string()),
                },
                ..ExternalControlState::default()
            })
            .insert_resource(snapshot(&[]))
            .add_systems(Update, announce_external_control_interface_changes);

        app.update();
        app.update();
        *app.world_mut().resource_mut::<NetworkInterfaceState>() = snapshot(&[iface("en7")]);
        app.update();
        let toasts: Vec<_> = app
            .world_mut()
            .resource_mut::<Messages<UiNotification>>()
            .drain()
            .collect();
        assert_eq!(toasts.len(), 1);
        assert_eq!(parts(&toasts[0]).0, ToastLevel::Info);
    }
}
