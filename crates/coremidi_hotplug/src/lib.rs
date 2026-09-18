// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

#[cfg(target_os = "macos")]
mod macos;

/// Spawn a listener that emits a unit value when CoreMIDI reports device topology changes.
#[cfg(target_os = "macos")]
pub fn spawn_device_update_listener() -> Option<std::sync::mpsc::Receiver<()>> {
    macos::spawn_device_update_listener()
}

/// CoreMIDI topology notifications are only available on macOS.
#[cfg(not(target_os = "macos"))]
pub fn spawn_device_update_listener() -> Option<std::sync::mpsc::Receiver<()>> {
    None
}
