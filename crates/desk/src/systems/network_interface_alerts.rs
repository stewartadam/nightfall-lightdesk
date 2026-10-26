// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Tells operators when a network interface their show or remote devices rely on disappears or
//! returns.
//!
//! Transports never fall back from a missing configured interface to another one; they stay
//! unbound until the same interface reappears. These toasts make that state visible and point the
//! operator at the setting that changes it.

use bevy_ecs::prelude::*;
use nightfall_io::prelude::{
    ExternalControlSettings, ExternalControlState, IoRuntimeSettings, NetworkInterfaceInfo,
    NetworkInterfaceState, TransportRuntimePolicy,
};

use crate::ui_notification::{ToastAction, ToastLevel, UiNotification};

/// Compares each new host interface snapshot with the previous one and toasts the transitions
/// that affect configured DMX transports or the External control listener.
///
/// The first snapshot seen is only recorded: a show that starts with its interface missing is
/// already reported by Settings, and toasting at startup would repeat on every launch.
pub fn announce_network_interface_changes(
    interfaces: Res<NetworkInterfaceState>,
    io_settings: Res<IoRuntimeSettings>,
    transport_policy: Option<Res<TransportRuntimePolicy>>,
    external_control: Option<Res<ExternalControlState>>,
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
    let policy = transport_policy.map(|policy| *policy).unwrap_or_default();
    let mut toasts = dmx_interface_toasts(last, &interfaces, &io_settings, &policy);
    if let Some(external_control) = external_control.filter(|state| state.available) {
        toasts.extend(external_control_toasts(
            last,
            &interfaces,
            &external_control.settings,
        ));
    }
    ui_notifications.write_batch(toasts);
    *previous = Some(interfaces.clone());
}

/// Names which network DMX directions the interface carries, or `None` when neither is on so a
/// network change cannot affect the show.
fn dmx_transport_label(
    settings: &IoRuntimeSettings,
    policy: &TransportRuntimePolicy,
) -> Option<&'static str> {
    match (
        policy.network_input_enabled(settings),
        policy.network_output_enabled(settings),
    ) {
        (true, true) => Some("Art-Net and sACN input and output"),
        (true, false) => Some("Art-Net and sACN input"),
        (false, true) => Some("Art-Net and sACN output"),
        (false, false) => None,
    }
}

/// Builds toasts for the interface Art-Net and sACN bind to.
///
/// An explicitly chosen interface that vanishes stops the transports until that same interface
/// returns. With System default selected, the transports follow the host's default route, so the
/// toast says where they moved.
fn dmx_interface_toasts(
    previous: &NetworkInterfaceState,
    current: &NetworkInterfaceState,
    settings: &IoRuntimeSettings,
    policy: &TransportRuntimePolicy,
) -> Vec<UiNotification> {
    let Some(transports) = dmx_transport_label(settings, policy) else {
        return Vec::new();
    };
    let open_settings = vec![ToastAction::OpenNetworkSettings];
    let toast = match &settings.network_interface {
        Some(name) => match (find(previous, name), find(current, name)) {
            (Some(lost), None) => UiNotification::toast_with_actions(
                ToastLevel::Warning,
                format!(
                    "Network interface {} disconnected. {transports} stopped and resumes when it \
                     reconnects, or choose another interface.",
                    label(lost)
                ),
                open_settings,
            ),
            (None, Some(back)) => UiNotification::toast(
                ToastLevel::Info,
                format!(
                    "Network interface {} reconnected. {transports} resumed.",
                    label(back)
                ),
            ),
            _ => return Vec::new(),
        },
        None => match (&previous.default_interface, &current.default_interface) {
            (Some(old), Some(new)) if old.name != new.name => UiNotification::toast_with_actions(
                ToastLevel::Info,
                format!(
                    "The system default network changed from {} to {}. {transports} moved to {}.",
                    label(old),
                    label(new),
                    label(new)
                ),
                open_settings,
            ),
            (Some(lost), None) => UiNotification::toast_with_actions(
                ToastLevel::Warning,
                format!(
                    "Network interface {} disconnected and no other network is available. \
                     {transports} stopped.",
                    label(lost)
                ),
                open_settings,
            ),
            (None, Some(new)) => UiNotification::toast(
                ToastLevel::Info,
                format!(
                    "{transports} resumed on {}, the system default network.",
                    label(new)
                ),
            ),
            _ => return Vec::new(),
        },
    };
    vec![toast]
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
    let toast = match (find(previous, name), find(current, name)) {
        (Some(lost), None) => UiNotification::toast_with_actions(
            ToastLevel::Warning,
            format!(
                "External control interface {} disconnected. Other devices can't connect until \
                 it reconnects, or choose another interface.",
                label(lost)
            ),
            vec![ToastAction::OpenExternalControlSettings],
        ),
        (None, Some(back)) => UiNotification::toast(
            ToastLevel::Info,
            format!(
                "External control interface {} reconnected. Other devices can connect again.",
                label(back)
            ),
        ),
        _ => return Vec::new(),
    };
    vec![toast]
}

/// Looks up an interface by its system name in a host snapshot.
fn find<'a>(state: &'a NetworkInterfaceState, name: &str) -> Option<&'a NetworkInterfaceInfo> {
    state
        .available_interfaces
        .iter()
        .find(|interface| interface.name == name)
}

/// Formats an interface as its friendly name with the system name in parentheses, or just the
/// system name when the platform reports no friendly name.
fn label(interface: &NetworkInterfaceInfo) -> String {
    match interface.friendly_name.as_deref() {
        Some(friendly) if friendly != interface.name => {
            format!("{friendly} ({})", interface.name)
        }
        _ => interface.name.clone(),
    }
}

#[cfg(test)]
mod tests {
    use bevy_app::{App, Update};
    use bevy_ecs::message::Messages;

    use super::*;

    /// Builds an interface with one IPv4 address and an optional friendly name.
    fn iface(name: &str, friendly: Option<&str>) -> NetworkInterfaceInfo {
        NetworkInterfaceInfo {
            name: name.to_string(),
            friendly_name: friendly.map(str::to_string),
            addresses: vec!["192.0.2.10".to_string()],
        }
    }

    /// Builds a host snapshot from the listed interfaces, using `default` as the default route.
    fn snapshot(
        available: &[NetworkInterfaceInfo],
        default: Option<&NetworkInterfaceInfo>,
    ) -> NetworkInterfaceState {
        NetworkInterfaceState {
            available_interfaces: available.to_vec(),
            default_interface: default.cloned(),
        }
    }

    /// Returns IO settings with network output on and the given interface selected.
    fn output_settings(interface: Option<&str>) -> IoRuntimeSettings {
        IoRuntimeSettings {
            network_interface: interface.map(str::to_string),
            network_output_enabled: true,
            network_input_enabled: false,
            ..IoRuntimeSettings::default()
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

    /// Losing the selected interface warns with a settings button, and its return says output
    /// resumed, without ever naming another interface to fall back to.
    #[test]
    fn selected_interface_loss_and_return_are_announced() {
        let wifi = iface("en0", Some("Wi-Fi"));
        let usb = iface("en7", Some("USB Ethernet"));
        let both = snapshot(&[wifi.clone(), usb.clone()], Some(&wifi));
        let without_usb = snapshot(std::slice::from_ref(&wifi), Some(&wifi));
        let settings = output_settings(Some("en7"));
        let policy = TransportRuntimePolicy::default();

        let lost = dmx_interface_toasts(&both, &without_usb, &settings, &policy);
        assert_eq!(lost.len(), 1);
        let (level, message, actions) = parts(&lost[0]);
        assert_eq!(level, ToastLevel::Warning);
        assert!(message.starts_with("Network interface USB Ethernet (en7) disconnected."));
        assert!(message.contains("Art-Net and sACN output stopped"));
        assert!(!message.contains("Wi-Fi"));
        assert_eq!(actions, [ToastAction::OpenNetworkSettings]);

        let back = dmx_interface_toasts(&without_usb, &both, &settings, &policy);
        let (level, message, actions) = parts(&back[0]);
        assert_eq!(level, ToastLevel::Info);
        assert_eq!(
            message,
            "Network interface USB Ethernet (en7) reconnected. Art-Net and sACN output resumed."
        );
        assert!(actions.is_empty());
    }

    /// Changes that don't touch the selected interface, or happen while network DMX is off, stay
    /// silent.
    #[test]
    fn unrelated_changes_and_disabled_transports_are_silent() {
        let wifi = iface("en0", None);
        let usb = iface("en7", None);
        let both = snapshot(&[wifi.clone(), usb.clone()], Some(&wifi));
        let without_wifi = snapshot(std::slice::from_ref(&usb), None);
        let policy = TransportRuntimePolicy::default();

        assert!(
            dmx_interface_toasts(&both, &without_wifi, &output_settings(Some("en7")), &policy)
                .is_empty()
        );
        let off = IoRuntimeSettings {
            network_output_enabled: false,
            network_input_enabled: false,
            ..output_settings(Some("en7"))
        };
        assert!(
            dmx_interface_toasts(
                &both,
                &snapshot(&[wifi.clone()], Some(&wifi)),
                &off,
                &policy
            )
            .is_empty()
        );
    }

    /// With System default selected, a new default route is announced as a move, and losing the
    /// only network is a warning.
    #[test]
    fn system_default_changes_are_announced() {
        let wifi = iface("en0", Some("Wi-Fi"));
        let ethernet = iface("en1", Some("Ethernet"));
        let settings = output_settings(None);
        let policy = TransportRuntimePolicy::default();
        let on_wifi = snapshot(&[wifi.clone(), ethernet.clone()], Some(&wifi));
        let on_ethernet = snapshot(std::slice::from_ref(&ethernet), Some(&ethernet));
        let offline = snapshot(&[], None);

        let moved = dmx_interface_toasts(&on_wifi, &on_ethernet, &settings, &policy);
        let (level, message, actions) = parts(&moved[0]);
        assert_eq!(level, ToastLevel::Info);
        assert!(message.contains("from Wi-Fi (en0) to Ethernet (en1)"));
        assert_eq!(actions, [ToastAction::OpenNetworkSettings]);

        let lost = dmx_interface_toasts(&on_ethernet, &offline, &settings, &policy);
        assert_eq!(parts(&lost[0]).0, ToastLevel::Warning);

        let back = dmx_interface_toasts(&offline, &on_ethernet, &settings, &policy);
        assert!(parts(&back[0]).1.contains("resumed on Ethernet (en1)"));
    }

    /// External control warns only for an enabled listener bound to one interface.
    #[test]
    fn external_control_interface_loss_is_announced() {
        let lan = iface("en7", None);
        let with_lan = snapshot(std::slice::from_ref(&lan), None);
        let without_lan = snapshot(&[], None);
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

    /// The system records the startup snapshot silently and toasts once per later transition.
    #[test]
    fn system_toasts_only_after_the_first_snapshot() {
        let usb = iface("en7", None);
        let mut app = App::new();
        app.add_message::<UiNotification>()
            .insert_resource(output_settings(Some("en7")))
            .insert_resource(snapshot(&[], None))
            .add_systems(Update, announce_network_interface_changes);

        app.update();
        app.update();
        assert!(
            app.world_mut()
                .resource_mut::<Messages<UiNotification>>()
                .drain()
                .next()
                .is_none(),
            "a missing interface at startup is not announced"
        );

        *app.world_mut().resource_mut::<NetworkInterfaceState>() =
            snapshot(std::slice::from_ref(&usb), None);
        app.update();
        *app.world_mut().resource_mut::<NetworkInterfaceState>() = snapshot(&[], None);
        app.update();
        let toasts: Vec<_> = app
            .world_mut()
            .resource_mut::<Messages<UiNotification>>()
            .drain()
            .collect();
        assert_eq!(toasts.len(), 2);
        assert_eq!(parts(&toasts[0]).0, ToastLevel::Info);
        assert_eq!(parts(&toasts[1]).0, ToastLevel::Warning);
    }
}
