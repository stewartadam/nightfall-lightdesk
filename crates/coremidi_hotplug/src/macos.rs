// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use core_foundation::runloop::CFRunLoop;
use coremidi::{Client as CoreMidiClient, Notification as CoreMidiNotification};

const CLIENT_NAME: &str = "nightfall-discovery-notifications";

pub(crate) fn spawn_device_update_listener() -> Option<std::sync::mpsc::Receiver<()>> {
    let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel(1);
    std::thread::Builder::new()
        .name("nightfall-midi-hotplug-listener".to_string())
        .spawn(move || {
            let (change_tx, change_rx) = std::sync::mpsc::channel();
            let client = CoreMidiClient::new_with_notifications(
                CLIENT_NAME,
                move |notification: &CoreMidiNotification| {
                    if matches!(
                        notification,
                        CoreMidiNotification::SetupChanged
                            | CoreMidiNotification::ObjectAdded(_)
                            | CoreMidiNotification::ObjectRemoved(_)
                            | CoreMidiNotification::PropertyChanged(_)
                    ) {
                        let _ = change_tx.send(());
                    }
                },
            );

            match client {
                Ok(_client) => {
                    let _ = ready_tx.send(Some(change_rx));
                    CFRunLoop::run_current();
                }
                Err(_) => {
                    let _ = ready_tx.send(None);
                }
            }
        })
        .expect("failed to spawn MIDI hotplug listener");

    ready_rx.recv().ok().flatten()
}
