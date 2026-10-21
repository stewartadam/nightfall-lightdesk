// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Runtime-authored capability declarations shared with connected clients.

use bevy_ecs::prelude::{Res, Resource};
use serde::{Deserialize, Serialize};

/// Identifies the host environment running the engine world.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub enum RuntimeMode {
    /// Native Nightfall process with platform host services.
    Native,
    /// Static browser demo backed by an embedded WebAssembly engine.
    EmbeddedDemo,
}

/// Describes access to a native content library.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub enum LibraryCapability {
    /// Native library discovery and import are available.
    Native,
    /// Only entries compiled into the runtime are available; discovery and import are not.
    BuiltInOnly,
    /// Library discovery and import are unavailable.
    Unavailable,
}

/// Describes the dynamic FX-module host attached to the runtime.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub enum FxModuleCapability {
    /// Native Wasmtime-backed FX modules are available.
    Native,
    /// Dynamic FX modules are unavailable.
    Unavailable,
}

/// Describes the timeline audio output host attached to the runtime.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub enum TimelineAudioCapability {
    /// Native timeline audio playback and file management are available.
    Native,
    /// Playback is limited to bundled browser-demo media.
    BundledBrowser,
    /// Timeline audio output is unavailable.
    Unavailable,
}

/// Complete capability snapshot authored by the active runtime composition.
#[derive(Debug, Clone, PartialEq, Eq, Resource, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct RuntimeCapabilities {
    /// Host environment running the engine.
    pub runtime_mode: RuntimeMode,
    /// Whether the host can read and write showfiles on disk (open, save, drafts, import,
    /// export, and the show trash).
    pub disk_storage: bool,
    /// Fixture-library support.
    pub fixture_library: LibraryCapability,
    /// Scene-object-library support.
    pub object_library: LibraryCapability,
    /// Dynamic FX-module execution support.
    pub fx_modules: FxModuleCapability,
    /// Timeline audio output support.
    pub timeline_audio: TimelineAudioCapability,
    /// Whether MIDI input is available.
    pub midi_input: bool,
    /// Whether OSC input is available.
    pub osc_input: bool,
    /// Whether Art-Net or sACN input is available.
    pub network_dmx_input: bool,
    /// Whether Art-Net or sACN output is available.
    pub network_dmx_output: bool,
    /// Whether USB DMX output is available.
    pub usb_dmx_output: bool,
    /// Whether incomplete flow authoring and execution are enabled for this process.
    pub experimental_flows: bool,
}

impl Default for RuntimeCapabilities {
    /// Return the conservative engine-only capability set used until a host supplies policy.
    fn default() -> Self {
        Self {
            runtime_mode: RuntimeMode::Native,
            disk_storage: false,
            fixture_library: LibraryCapability::Unavailable,
            object_library: LibraryCapability::Unavailable,
            fx_modules: FxModuleCapability::Unavailable,
            timeline_audio: TimelineAudioCapability::Unavailable,
            midi_input: false,
            osc_input: false,
            network_dmx_input: false,
            network_dmx_output: false,
            usb_dmx_output: false,
            experimental_flows: false,
        }
    }
}

impl RuntimeCapabilities {
    /// Return the fixed public browser-demo capability set.
    #[must_use]
    pub const fn embedded_demo() -> Self {
        Self {
            runtime_mode: RuntimeMode::EmbeddedDemo,
            disk_storage: false,
            fixture_library: LibraryCapability::BuiltInOnly,
            object_library: LibraryCapability::Unavailable,
            fx_modules: FxModuleCapability::Unavailable,
            timeline_audio: TimelineAudioCapability::BundledBrowser,
            midi_input: false,
            osc_input: false,
            network_dmx_input: false,
            network_dmx_output: false,
            usb_dmx_output: false,
            experimental_flows: false,
        }
    }
}

/// Run condition that reports whether the host can read and write showfiles on disk.
///
/// A missing capability resource counts as unavailable, so engine-only compositions reject
/// storage commands instead of silently ignoring them.
pub fn disk_storage_available(capabilities: Option<Res<RuntimeCapabilities>>) -> bool {
    capabilities.is_some_and(|capabilities| capabilities.disk_storage)
}
