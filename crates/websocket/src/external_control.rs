// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Host-scoped listener preferences, persistence, and interface resolution.

use std::{
    io::Write,
    net::{Ipv4Addr, SocketAddr},
    path::{Path, PathBuf},
};

use bevy_ecs::prelude::*;
use nightfall_io::{ExternalControlSettings, ExternalControlState, NetworkInterfaceState};
use tokio::sync::watch;

/// Listener configuration passed from the engine to its native host task.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ListenerRequest {
    pub settings: ExternalControlSettings,
    pub addresses: Vec<SocketAddr>,
    pub error: Option<String>,
}

/// Native listener channels and host persistence configuration.
pub(crate) struct ListenerTaskConfig {
    pub port: u16,
    pub requests: watch::Receiver<ListenerRequest>,
    pub status: watch::Sender<ExternalControlState>,
    pub settings_path: Option<PathBuf>,
}

/// Channels connecting engine-owned preferences to the asynchronous listener.
#[derive(Resource)]
pub(crate) struct ListenerControl {
    pub requests: watch::Sender<ListenerRequest>,
    pub status: watch::Receiver<ExternalControlState>,
}

/// Loads host preferences and initializes the engine side of listener control before transport startup.
pub(crate) fn initialize_listener_control(
    mut commands: Commands,
    mut state: ResMut<ExternalControlState>,
    interfaces: Res<NetworkInterfaceState>,
    config: Res<crate::AxumTaskConfig>,
) -> ListenerTaskConfig {
    let path = settings_path();
    let (settings, error) = load_settings(path.as_deref());
    *state = ExternalControlState {
        available: true,
        settings,
        error,
        listening_addresses: Vec::new(),
    };
    let request = resolve_request(&state.settings, &interfaces, config.bind_port);
    let (requests, request_rx) = watch::channel(request);
    let (status_tx, status) = watch::channel(state.clone());
    commands.insert_resource(ListenerControl { requests, status });
    ListenerTaskConfig {
        port: config.bind_port,
        requests: request_rx,
        status: status_tx,
        settings_path: path,
    }
}

/// Resolves permitted IPv4 endpoints without falling back from a missing selection to All.
pub(crate) fn resolve_request(
    settings: &ExternalControlSettings,
    interfaces: &NetworkInterfaceState,
    port: u16,
) -> ListenerRequest {
    let mut addresses = vec![SocketAddr::from((Ipv4Addr::LOCALHOST, port))];
    let mut error = None;
    if settings.enabled {
        if let Some(name) = &settings.interface {
            if let Some(interface) = interfaces
                .available_interfaces
                .iter()
                .find(|interface| &interface.name == name)
            {
                addresses.extend(
                    interface
                        .addresses
                        .iter()
                        .filter_map(|address| address.parse::<Ipv4Addr>().ok())
                        .filter(|address| !address.is_unspecified() && !address.is_loopback())
                        .map(|address| SocketAddr::from((address, port))),
                );
                if addresses.len() == 1 {
                    error = Some(format!(
                        "Interface {name} has no usable IPv4 address. Only local control is available."
                    ));
                }
            } else {
                error = Some(format!(
                    "Interface {name} is unavailable. Only local control is available."
                ));
            }
        } else {
            addresses = vec![SocketAddr::from((Ipv4Addr::UNSPECIFIED, port))];
        }
    }
    addresses.sort();
    addresses.dedup();
    ListenerRequest {
        settings: settings.clone(),
        addresses,
        error,
    }
}

/// Returns a host data path independent of whichever showfile is open.
pub(crate) fn settings_path() -> Option<PathBuf> {
    nightfall::nightfall_data_dir().map(|directory| directory.join("external-control.json"))
}

/// Loads host preferences, defaulting to local-only control on absent or invalid data.
pub(crate) fn load_settings(path: Option<&Path>) -> (ExternalControlSettings, Option<String>) {
    let Some(path) = path else {
        return (ExternalControlSettings::default(), None);
    };
    match std::fs::read(path) {
        Ok(bytes) => match serde_json::from_slice(&bytes) {
            Ok(settings) => (settings, None),
            Err(error) => (
                ExternalControlSettings::default(),
                Some(format!(
                    "Could not read external control preferences: {error}"
                )),
            ),
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            (ExternalControlSettings::default(), None)
        }
        Err(error) => (
            ExternalControlSettings::default(),
            Some(format!(
                "Could not read external control preferences: {error}"
            )),
        ),
    }
}

/// Atomically replaces the host preference file so interrupted writes fail closed.
pub(crate) fn save_settings(
    path: Option<&Path>,
    settings: &ExternalControlSettings,
) -> Result<(), String> {
    let path = path.ok_or("Host data directory is unavailable")?;
    let parent = path
        .parent()
        .ok_or("Host preference path has no directory")?;
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
    serde_json::to_writer_pretty(&mut file, settings).map_err(|error| error.to_string())?;
    file.flush().map_err(|error| error.to_string())?;
    file.as_file()
        .sync_all()
        .map_err(|error| error.to_string())?;
    file.persist(path).map_err(|error| error.to_string())?;
    Ok(())
}

/// Applies changed preferences/interface addresses and publishes matching listener results.
pub(crate) fn sync_listener_control(
    config: Res<crate::AxumTaskConfig>,
    control: Option<ResMut<ListenerControl>>,
    mut state: ResMut<ExternalControlState>,
    interfaces: Res<NetworkInterfaceState>,
) {
    let Some(mut control) = control else {
        return;
    };
    let request = resolve_request(&state.settings, &interfaces, config.bind_port);
    if *control.requests.borrow() != request {
        control.requests.send_replace(request);
    }
    if control.status.has_changed().unwrap_or(false) {
        let status = control.status.borrow_and_update().clone();
        if status.settings == state.settings {
            state.listening_addresses = status.listening_addresses;
            state.error = status.error;
        }
    }
}

#[cfg(test)]
mod tests {
    use nightfall_io::NetworkInterfaceInfo;

    use super::*;

    /// Builds a host interface snapshot without querying the test machine.
    fn interfaces() -> NetworkInterfaceState {
        NetworkInterfaceState {
            available_interfaces: vec![NetworkInterfaceInfo {
                name: "lan".into(),
                friendly_name: None,
                addresses: vec!["192.0.2.1".into()],
            }],
            default_interface: None,
        }
    }

    /// Ensures disabled, All, selected, and missing selections preserve the intended exposure.
    #[test]
    fn resolves_control_bindings_without_unsafe_fallback() {
        let mut settings = ExternalControlSettings::default();
        assert_eq!(
            resolve_request(&settings, &interfaces(), 3000).addresses,
            vec!["127.0.0.1:3000".parse().unwrap()]
        );
        settings.enabled = true;
        assert_eq!(
            resolve_request(&settings, &interfaces(), 3000).addresses,
            vec!["0.0.0.0:3000".parse().unwrap()]
        );
        settings.interface = Some("lan".into());
        assert_eq!(
            resolve_request(&settings, &interfaces(), 3000).addresses,
            vec![
                "127.0.0.1:3000".parse().unwrap(),
                "192.0.2.1:3000".parse().unwrap()
            ]
        );
        settings.interface = Some("missing".into());
        let request = resolve_request(&settings, &interfaces(), 3000);
        assert_eq!(request.addresses, vec!["127.0.0.1:3000".parse().unwrap()]);
        assert!(request.error.unwrap().contains("unavailable"));
    }

    /// Ensures host settings round-trip independently and invalid data disables remote access.
    #[test]
    fn host_preferences_round_trip_and_fail_closed() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("external-control.json");
        assert_eq!(
            load_settings(Some(&path)).0,
            ExternalControlSettings::default()
        );
        let settings = ExternalControlSettings {
            enabled: true,
            interface: Some("lan".into()),
        };
        save_settings(Some(&path), &settings).unwrap();
        assert_eq!(load_settings(Some(&path)), (settings, None));
        std::fs::write(&path, b"invalid").unwrap();
        let (settings, error) = load_settings(Some(&path));
        assert!(!settings.enabled);
        assert!(error.is_some());
    }
}
