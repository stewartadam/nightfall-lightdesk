// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! The host's network interfaces: the watcher that refreshes them, the client feed, and the
//! alerts shown when the interface the transports bind to disappears or returns.

#[cfg(feature = "native-network-watch")]
use std::sync::mpsc::{self, Receiver, TryRecvError};

use bevy_ecs::prelude::*;
use bevy_ecs::system::SystemParam;
use nightfall_engine::prelude::*;
use serde::Serialize;

use crate::{
    IoRuntimeSettings, NetworkInterfaceInfo, NetworkInterfaceState, NetworkInterfaceStatus,
    resolve_network_interface_status,
};

pub(crate) mod alerts;

/// Network interface messages sent to clients.
#[derive(Serialize)]
#[serde(tag = "type", content = "data")]
#[typeshare::typeshare]
enum IoWsMessage<'a> {
    /// Network interfaces the transports can bind to.
    AvailableNetworkInterfaces(&'a [NetworkInterfaceInfo]),
    /// The interface the transports currently use and how it was chosen.
    NetworkInterfaceStatus(&'a NetworkInterfaceStatus),
}

/// The available network interfaces and resolved interface status feed.
#[derive(SystemParam)]
pub(crate) struct NetworkInterfacesFeed<'w> {
    settings: Res<'w, IoRuntimeSettings>,
    interfaces: Res<'w, NetworkInterfaceState>,
}

impl ClientFeed for NetworkInterfacesFeed<'static> {
    /// Publishes the available interfaces and the resolved interface status from one snapshot.
    fn publish(feed: &NetworkInterfacesFeed<'_>, sink: &ClientEventSink) {
        let status = resolve_network_interface_status(&feed.settings, &feed.interfaces);
        sink.publish(
            DISCRIMINATOR_NON_DROPPABLE,
            &IoWsMessage::AvailableNetworkInterfaces(&feed.interfaces.available_interfaces),
        );
        sink.publish(
            DISCRIMINATOR_NON_DROPPABLE,
            &IoWsMessage::NetworkInterfaceStatus(&status),
        );
    }
}

/// Run condition that passes when the host's interfaces or the selected interface change, and
/// not for unrelated IO settings edits.
pub(crate) fn network_interfaces_changed(
    settings: Res<IoRuntimeSettings>,
    interfaces: Res<NetworkInterfaceState>,
    mut sent_selection: Local<Option<Option<String>>>,
) -> bool {
    let selection_changed = sent_selection.as_ref() != Some(&settings.network_interface);
    if selection_changed {
        *sent_selection = Some(settings.network_interface.clone());
    }
    selection_changed || interfaces.is_changed()
}

/// Keeps the host's network interface watcher alive and receives its change callbacks.
#[cfg(feature = "native-network-watch")]
pub(crate) struct NetworkInterfaceWatcher {
    _handle: netwatcher::WatchHandle,
    event_rx: Receiver<()>,
    disconnected: bool,
}

/// Starts the host's network interface watcher, logging and carrying on without automatic
/// refreshes when the platform refuses it.
#[cfg(feature = "native-network-watch")]
pub(crate) fn init_network_interface_watcher(world: &mut World) {
    let (event_tx, event_rx) = mpsc::channel();
    match netwatcher::watch_interfaces_with_callback(move |_| {
        let _ = event_tx.send(());
    }) {
        Ok(handle) => {
            world.insert_non_send(NetworkInterfaceWatcher {
                _handle: handle,
                event_rx,
                disconnected: false,
            });
        }
        Err(error) => {
            tracing::warn!(
                ?error,
                "Could not start network interface watcher; interface state will not auto-refresh"
            );
        }
    }
}

/// Captures a new interface snapshot after the watcher reports a change, storing it only when it
/// differs so unrelated host events do not resend the feed.
#[cfg(feature = "native-network-watch")]
pub(crate) fn refresh_network_interface_state(
    mut network_interface_state: ResMut<NetworkInterfaceState>,
    network_interface_watcher: Option<NonSendMut<NetworkInterfaceWatcher>>,
) {
    let Some(mut network_interface_watcher) = network_interface_watcher else {
        return;
    };
    if network_interface_watcher.disconnected {
        return;
    }

    let mut saw_event = false;
    loop {
        match network_interface_watcher.event_rx.try_recv() {
            Ok(()) => {
                saw_event = true;
            }
            Err(TryRecvError::Empty) => break,
            Err(TryRecvError::Disconnected) => {
                tracing::warn!(
                    "Network interface watcher disconnected; interface state will not auto-refresh"
                );
                network_interface_watcher.disconnected = true;
                break;
            }
        }
    }

    if !saw_event {
        return;
    }

    let next_state = NetworkInterfaceState::capture();
    if *network_interface_state != next_state {
        *network_interface_state = next_state;
    }
}
