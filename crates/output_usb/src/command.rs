// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Command that binds a saved USB DMX output to an attached adapter.

use bevy_ecs::prelude::*;
use nightfall_engine::prelude::*;
use nightfall_io::prelude::{IoRuntimeSettings, UsbDmxDeviceInfo};
use serde::{Deserialize, Serialize};

use crate::{
    AvailableUsbDmxDevices,
    targets::{UsbDmxDeviceAssignment, UsbDmxTargetStates},
};

/// Commands that bind USB DMX outputs to the adapters attached right now.
#[derive(Debug, Clone, Serialize, Deserialize, EnginePayload)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
#[serde(deny_unknown_fields)]
pub enum UsbDmxCommand {
    /// Point one USB output at an attached adapter, saving the port the adapter is on now.
    AssignDevice(UsbDmxDeviceAssignment),
}

impl IngressCommand for UsbDmxCommand {}

/// Applies USB DMX commands to the showfile's USB outputs and finishes each command.
pub(crate) fn handle_usb_dmx_commands(
    mut commands: MessageReader<CommandEnvelope<UsbDmxCommand>>,
    devices: Res<AvailableUsbDmxDevices>,
    states: Res<UsbDmxTargetStates>,
    mut settings: ResMut<IoRuntimeSettings>,
    mut responder: CommandResponder,
) {
    for envelope in commands.read() {
        let response = match &envelope.command {
            UsbDmxCommand::AssignDevice(assignment) => {
                match assign_device(assignment, &devices.0, &states, &settings) {
                    Ok(updated) => {
                        settings.usb_dmx_outputs = updated;
                        responder.succeed(envelope.command_id)
                    }
                    Err(error) => responder.fail(envelope.command_id, error),
                }
            }
        };
        if let Err(error) = response {
            tracing::error!(
                command_id = %envelope.command_id,
                %error,
                "usb_dmx_command_completion_failed"
            );
        }
    }
}

/// Returns the USB outputs with `assignment.target` saved for the attached adapter
/// `assignment.device`, recording the adapter's current serial, port and name. Refuses unknown
/// outputs, adapters that are not attached, and adapters another output is saved for or outputs
/// to right now.
fn assign_device(
    assignment: &UsbDmxDeviceAssignment,
    devices: &[UsbDmxDeviceInfo],
    states: &UsbDmxTargetStates,
    settings: &IoRuntimeSettings,
) -> Result<nightfall_io::prelude::UsbDmxOutputTargets, CommandError> {
    let Some(device) = devices.iter().find(|device| device.id == assignment.device) else {
        return Err(CommandError::new(
            "usb_dmx.device_not_attached",
            "That USB DMX adapter is no longer attached",
        ));
    };
    let mut targets = settings.usb_dmx_outputs.sanitized();
    let in_use = targets
        .targets
        .iter()
        .any(|target| target.id != assignment.target && target.device.trim() == device.id)
        || states.states.iter().any(|state| {
            state.target != assignment.target && state.status.output_device() == Some(&device.id)
        });
    if in_use {
        return Err(CommandError::new(
            "usb_dmx.device_in_use",
            "Another USB output already uses that adapter",
        ));
    }
    let Some(target) = targets
        .targets
        .iter_mut()
        .find(|target| target.id == assignment.target)
    else {
        return Err(CommandError::new(
            "usb_dmx.unknown_target",
            format!("There is no USB output named {}", assignment.target),
        ));
    };
    target.device = device.id.clone();
    target.device_label = Some(device.friendly_name());
    Ok(targets)
}

#[cfg(test)]
mod tests {
    use nightfall_io::prelude::{
        UDMX_PRODUCT_ID, UDMX_VENDOR_ID, UsbDmxOutputTarget, UsbDmxOutputTargets,
    };

    use super::*;

    /// Builds attached uDMX info with serial `0001` on port `20:<port>`.
    fn twin(port: &str) -> UsbDmxDeviceInfo {
        UsbDmxDeviceInfo {
            id: format!("id-16c0:05dc,serial-0001,port-20:{port}"),
            label: "Anyma uDMX".to_string(),
            vendor_id: UDMX_VENDOR_ID,
            product_id: UDMX_PRODUCT_ID,
            manufacturer: Some("Anyma".to_string()),
            product: Some("uDMX".to_string()),
            serial_number: Some("0001".to_string()),
            location: Some(format!("bus 20 port {port}")),
        }
    }

    /// Builds settings with outputs `left` and `right` saved for twins on ports 1 and 2.
    fn settings() -> IoRuntimeSettings {
        let target = |id: &str, port: &str| UsbDmxOutputTarget {
            id: id.to_string(),
            device: format!("id-16c0:05dc,serial-0001,port-20:{port}"),
            device_label: None,
        };
        IoRuntimeSettings {
            usb_dmx_outputs: UsbDmxOutputTargets {
                targets: vec![target("left", "1"), target("right", "2")],
            },
            ..Default::default()
        }
    }

    /// Resolves the outputs in [`settings`] against `devices`.
    fn states(devices: &[UsbDmxDeviceInfo]) -> UsbDmxTargetStates {
        UsbDmxTargetStates::resolve(&settings().usb_dmx_outputs.targets, devices)
    }

    /// Builds an assignment of `device` to `target`.
    fn assignment(target: &str, device: &UsbDmxDeviceInfo) -> UsbDmxDeviceAssignment {
        UsbDmxDeviceAssignment {
            target: target.to_string(),
            device: device.id.clone(),
        }
    }

    /// Verifies assigning an attached adapter saves its current port and name on the output.
    #[test]
    fn assign_saves_the_adapters_current_port() {
        let device = twin("3");
        let devices = std::slice::from_ref(&device);
        let targets = assign_device(
            &assignment("left", &device),
            devices,
            &states(devices),
            &settings(),
        )
        .expect("assignment applies");

        let left = targets.get("left").expect("left output is kept");
        assert_eq!(left.device, device.id);
        assert_eq!(left.device_label.as_deref(), Some("Anyma uDMX"));
        assert_eq!(
            targets.get("right").map(|target| target.device.as_str()),
            Some("id-16c0:05dc,serial-0001,port-20:2")
        );
    }

    /// Verifies adapters that are gone or saved on another output, and unknown outputs, are
    /// refused without changing anything.
    #[test]
    fn assign_refuses_missing_taken_and_unknown() {
        let attached = [twin("2"), twin("3")];
        let refused = |assignment: UsbDmxDeviceAssignment| {
            assign_device(&assignment, &attached, &states(&attached), &settings())
                .expect_err("assignment is refused")
                .code
        };

        assert_eq!(
            refused(assignment("left", &twin("4"))),
            "usb_dmx.device_not_attached"
        );
        assert_eq!(
            refused(assignment("left", &attached[0])),
            "usb_dmx.device_in_use"
        );
        assert_eq!(
            refused(assignment("spare", &attached[1])),
            "usb_dmx.unknown_target"
        );
    }

    /// Verifies an adapter another output follows to a new port is refused, so assigning it
    /// elsewhere never silently stops that output.
    #[test]
    fn assign_refuses_adapter_another_output_follows() {
        let moved = UsbDmxDeviceInfo {
            id: "id-16c0:05dc,serial-0002,port-20:4".to_string(),
            serial_number: Some("0002".to_string()),
            ..twin("4")
        };
        let mut settings = settings();
        settings.usb_dmx_outputs.targets.push(UsbDmxOutputTarget {
            id: "stage".to_string(),
            device: "id-16c0:05dc,serial-0002,port-20:1".to_string(),
            device_label: None,
        });
        let devices = std::slice::from_ref(&moved);
        let states = UsbDmxTargetStates::resolve(&settings.usb_dmx_outputs.targets, devices);

        let error = assign_device(&assignment("left", &moved), devices, &states, &settings)
            .expect_err("a followed adapter is refused");
        assert_eq!(error.code, "usb_dmx.device_in_use");
    }
}
