// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Host and transport settings commands, telemetry consent, and device lists

use std::collections::HashMap;
use std::time::Duration;

use nightfall_engine::prelude::*;
use nightfall_fixtures::prelude::RouteValidationMode;
use nightfall_io::prelude::{
    ExternalControlSettings, InputSignalLossPolicy, InputUniverseVisibilityMode,
    NetworkDmxOutputTargets, UsbDmxOutputTargets,
};
use serde::{Deserialize, Serialize};

/// Snapshot of audio outputs currently surfaced to desk clients.
#[derive(bevy_ecs::prelude::Resource, Debug, Default, Clone)]
pub struct AvailableAudioDevices(pub HashMap<String, String>);

/// Operator choices about anonymous telemetry, kept with the host rather than any showfile
/// so that opening a show on another computer never changes what that computer shares.
#[derive(Debug, Default, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[typeshare::typeshare]
#[serde(default)]
pub struct TelemetryConsent {
    /// Whether the operator has answered the telemetry prompt; while false the UI keeps asking.
    pub decided: bool,
    /// Whether anonymous usage reports (hardware, patch makeup, app starts) may be sent.
    pub share_usage: bool,
    /// Whether automatic error and crash reports may be sent.
    pub share_errors: bool,
}

/// Host telemetry consent plus the anonymous identifier that groups one installation's reports.
#[derive(
    Debug, Default, Clone, Serialize, Deserialize, PartialEq, Eq, bevy_ecs::prelude::Resource,
)]
#[typeshare::typeshare]
pub struct TelemetryState {
    /// Whether this runtime can store host preferences; false in the browser demo and tests.
    pub available: bool,
    /// The operator's current choices.
    pub consent: TelemetryConsent,
    /// Random identifier attached to reports so monthly installs can be counted; empty until loaded.
    pub install_id: String,
    /// Persistence failure the operator should see.
    pub error: Option<String>,
}

/// Graphics hardware the desktop app's own window renders with, which only the web view can see.
#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[typeshare::typeshare]
pub struct GraphicsReport {
    /// Graphics processor model as the web view names it, when it names one.
    pub gpu: Option<String>,
    /// Rendering API the visualizer can use, such as `WebGPU` or `WebGL 2`.
    pub backend: String,
}

impl GraphicsReport {
    /// Longest text kept from a client-supplied field.
    const MAX_FIELD_LENGTH: usize = 160;

    /// Returns the report with surrounding whitespace removed, empty names dropped, and each
    /// field cut to a bounded length, since any connected client can send one.
    pub fn sanitized(&self) -> Self {
        let clean = |value: &str| {
            let value = value.trim();
            let end = value
                .char_indices()
                .nth(Self::MAX_FIELD_LENGTH)
                .map_or(value.len(), |(index, _)| index);
            value[..end].to_string()
        };
        Self {
            gpu: self.gpu.as_deref().map(clean).filter(|gpu| !gpu.is_empty()),
            backend: clean(&self.backend),
        }
    }
}

/// The most recent graphics report from the desktop app's window, kept out of client sync.
#[derive(Debug, Default, Clone, PartialEq, Eq, bevy_ecs::prelude::Resource)]
pub struct ReportedGraphics(pub Option<GraphicsReport>);

/// Commands for host preferences, input and output transport settings, and device lists
#[derive(Debug, Clone, Serialize, Deserialize, EnginePayload)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
#[serde(deny_unknown_fields)]
pub enum SettingsCommand {
    /// Set the selected network interface (None = system default)
    SetNetworkInterface(Option<String>),
    /// Sets host-owned external control permission and interface selection.
    SetExternalControl(ExternalControlSettings),
    /// Sets host-owned telemetry consent.
    SetTelemetryConsent(TelemetryConsent),
    /// Replaces the anonymous telemetry identifier with a new random one.
    ResetTelemetryInstallId,
    /// Records the graphics hardware the desktop app's window renders with, for usage reports.
    ReportGraphics(GraphicsReport),
    /// Set whether network DMX output is enabled
    SetNetworkOutputEnabled(bool),
    /// Set whether network DMX input is enabled
    SetNetworkInputEnabled(bool),
    /// Set whether USB DMX output is enabled
    SetUsbOutputEnabled(bool),
    /// Set named network DMX output targets.
    SetNetworkDmxOutputs(NetworkDmxOutputTargets),
    /// Set named USB DMX output targets.
    SetUsbDmxOutputs(UsbDmxOutputTargets),
    /// Set the input signal-loss policy
    SetInputSignalLossPolicy(InputSignalLossPolicy),
    /// Set the stale input age threshold
    SetInputSignalLossTimeout(Duration),
    /// Set network DMX packets sent per second; clamped to 1..=60 Hz
    SetDmxOutputRate(u32),
    /// Set patch overlap validation mode
    SetRouteValidationMode(RouteValidationMode),
    /// Set whether input views show only external inputs or all detected inputs
    SetInputUniverseVisibilityMode(InputUniverseVisibilityMode),
    /// Request list of available network interfaces
    GetAvailableNetworkInterfaces,
    /// Request list of available audio devices
    GetAvailableAudioDevices,
    /// Request list of compatible USB DMX devices
    GetAvailableUsbDmxDevices,
}

impl IngressCommand for SettingsCommand {}
