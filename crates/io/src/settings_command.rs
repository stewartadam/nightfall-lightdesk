// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Command that changes the showfile's input and output transport settings.

use std::time::Duration;

use nightfall_engine::prelude::*;
use serde::{Deserialize, Serialize};

use crate::{
    InputSignalLossPolicy, InputUniverseVisibilityMode, IoRuntimeSettings, NetworkDmxOutputTargets,
    UsbDmxOutputTargets, sanitize_dmx_output_rate_hz, sanitize_input_signal_loss_timeout,
};

/// Commands that change [`IoRuntimeSettings`].
#[derive(Debug, Clone, Serialize, Deserialize, EnginePayload)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
#[serde(deny_unknown_fields)]
pub enum IoSettingsCommand {
    /// Set the network interface Art-Net and sACN bind to; `None` follows the system default.
    SetNetworkInterface(Option<String>),
    /// Set whether network DMX output is enabled.
    SetNetworkOutputEnabled(bool),
    /// Set whether network DMX input is enabled.
    SetNetworkInputEnabled(bool),
    /// Set whether USB DMX output is enabled.
    SetUsbOutputEnabled(bool),
    /// Set named network DMX output targets.
    SetNetworkDmxOutputs(NetworkDmxOutputTargets),
    /// Set named USB DMX output targets.
    SetUsbDmxOutputs(UsbDmxOutputTargets),
    /// Set what happens to input channels when their source goes quiet.
    SetInputSignalLossPolicy(InputSignalLossPolicy),
    /// Set how long an input may stay quiet before it counts as lost.
    SetInputSignalLossTimeout(Duration),
    /// Set network DMX packets sent per second; clamped to 1..=60 Hz.
    SetDmxOutputRate(u32),
    /// Set whether input views show only external inputs or every detected input.
    SetInputUniverseVisibilityMode(InputUniverseVisibilityMode),
}

impl IngressCommand for IoSettingsCommand {}

/// Writes one transport settings change, sanitizing output targets and clamping the signal-loss
/// timeout and output rate into their supported ranges. These edits cannot fail.
pub(crate) fn apply(
    command: &IoSettingsCommand,
    settings: &mut IoRuntimeSettings,
) -> Result<(), CommandError> {
    match command {
        IoSettingsCommand::SetNetworkInterface(interface) => {
            settings.network_interface = interface.clone();
        }
        IoSettingsCommand::SetNetworkOutputEnabled(enabled) => {
            settings.network_output_enabled = *enabled;
        }
        IoSettingsCommand::SetNetworkInputEnabled(enabled) => {
            settings.network_input_enabled = *enabled;
        }
        IoSettingsCommand::SetUsbOutputEnabled(enabled) => settings.usb_output_enabled = *enabled,
        IoSettingsCommand::SetNetworkDmxOutputs(targets) => {
            settings.network_dmx_outputs = targets.sanitized();
        }
        IoSettingsCommand::SetUsbDmxOutputs(targets) => {
            settings.usb_dmx_outputs = targets.sanitized();
        }
        IoSettingsCommand::SetInputSignalLossPolicy(policy) => {
            settings.input_signal_loss_policy = *policy;
        }
        IoSettingsCommand::SetInputSignalLossTimeout(timeout) => {
            settings.input_signal_loss_timeout = sanitize_input_signal_loss_timeout(*timeout);
        }
        IoSettingsCommand::SetDmxOutputRate(rate_hz) => {
            settings.dmx_output_rate_hz = sanitize_dmx_output_rate_hz(*rate_hz);
        }
        IoSettingsCommand::SetInputUniverseVisibilityMode(mode) => {
            settings.input_universe_visibility_mode = *mode;
        }
    }
    tracing::debug!(?command, "IO setting applied");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::MAX_DMX_OUTPUT_RATE_HZ;

    /// Applies `command` to default settings and returns the result.
    fn applied(command: IoSettingsCommand) -> IoRuntimeSettings {
        let mut settings = IoRuntimeSettings::default();
        apply(&command, &mut settings).expect("IO settings edits cannot fail");
        settings
    }

    /// Verifies plain setters store their payload in the field they name.
    #[test]
    fn setters_store_their_payload() {
        assert_eq!(
            applied(IoSettingsCommand::SetNetworkInterface(Some("eth0".into())))
                .network_interface
                .as_deref(),
            Some("eth0")
        );
        assert!(!applied(IoSettingsCommand::SetUsbOutputEnabled(false)).usb_output_enabled);
        assert_eq!(
            applied(IoSettingsCommand::SetInputUniverseVisibilityMode(
                InputUniverseVisibilityMode::AllDetected
            ))
            .input_universe_visibility_mode,
            InputUniverseVisibilityMode::AllDetected
        );
    }

    /// Verifies the output rate and signal-loss timeout are clamped into their supported ranges,
    /// since any connected client can send them.
    #[test]
    fn rate_and_timeout_are_clamped() {
        assert_eq!(
            applied(IoSettingsCommand::SetDmxOutputRate(10_000)).dmx_output_rate_hz,
            MAX_DMX_OUTPUT_RATE_HZ
        );
        assert_eq!(
            applied(IoSettingsCommand::SetInputSignalLossTimeout(Duration::ZERO))
                .input_signal_loss_timeout,
            Duration::from_millis(1)
        );
    }
}
