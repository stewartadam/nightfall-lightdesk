// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Notifies when macOS CoreMIDI devices are connected or disconnected.
//!
//! MIDI device discovery uses this to reopen its MIDI client when devices change, so newly
//! connected devices show up. On other platforms the listener isn't available and
//! [`spawn_device_update_listener`] returns `None`.

#[cfg(not(target_arch = "wasm32"))]
// Leaf crate: mark the cargo-hakari workspace-hack as used so cargo's unused_dependencies lint passes.
use nightfall_workspace_hack as _;

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
