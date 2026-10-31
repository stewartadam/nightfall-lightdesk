// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! WebSocket integration for MIDI input
//!
//! This module provides:
//! - Command deserializer for MidiCommand
//! - Broadcasters for device list, newly detected devices, mappings, and last event

use std::collections::BTreeSet;

use bevy_ecs::prelude::*;
use nightfall_actions::BindingDiagnostic;
use nightfall_engine::prelude::*;
use serde::Serialize;

use crate::command::{MidiLastEvent, MidiMapping};
use crate::detected::DetectedMidiDevices;
use crate::mapping::MidiMappings;
use crate::profile::{self, MidiDeviceProfile};
use crate::{LastMidiEvent, MidiControlTouches, MidiDevices, MidiMappingDiagnostics};

/// MIDI device information sent to the UI
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
#[typeshare::typeshare]
pub struct MidiDevice {
    /// Device name
    pub name: String,
    /// Whether the device has an output port that LED feedback can be sent to.
    pub has_output: bool,
    /// Whether LED feedback is turned on for the device.
    pub feedback: bool,
}

/// WebSocket message types for MIDI
#[derive(Serialize)]
#[serde(tag = "type", content = "data")]
#[typeshare::typeshare]
#[allow(clippy::enum_variant_names)]
enum MidiWsMessage<'a> {
    /// List of connected MIDI devices
    MidiDeviceList(&'a [MidiDevice]),
    /// Controller profiles of connected and mapped devices, one per device name
    MidiDeviceProfiles(&'a [MidiDeviceProfile]),
    /// Current MIDI mappings configuration
    MidiMappings(&'a [MidiMapping]),
    /// Last received MIDI event (for identification)
    MidiLastEvent(&'a MidiLastEvent),
    /// MIDI mappings that cannot currently invoke their action, and why
    MidiMappingDiagnostics(&'a [BindingDiagnostic]),
    /// Controls touched in one frame while controller mapping mode is active, in order.
    ///
    /// Unlike `MidiLastEvent`, these are never dropped or coalesced across controls, so a
    /// mapping client reliably arms the control that was touched.
    MidiControlTouched(&'a [MidiLastEvent]),
    /// Devices that connected while the engine runs and that the show does not map yet, so
    /// clients can offer to set them up. Each device is announced once.
    MidiDeviceDetected(&'a [String]),
}

/// System to send MIDI state on resync
pub fn handle_resync_state(
    mut resync: ResyncReplies,
    devices: Res<MidiDevices>,
    mappings: Res<MidiMappings>,
    diagnostics: Res<MidiMappingDiagnostics>,
    last_event: Res<LastMidiEvent>,
) {
    let Some(broadcaster) = resync.sink() else {
        return;
    };

    send_device_list(&devices, &mappings, &broadcaster);
    send_device_profiles(&profiled_device_names(&devices, &mappings), &broadcaster);
    send_mappings(&mappings, &broadcaster);
    send_diagnostics(&diagnostics, &broadcaster);
    if let Some(ref event) = last_event.0 {
        send_last_event(event, &broadcaster);
    }
}

/// System to periodically send MIDI state updates
pub fn send_midi_state(
    devices: Res<MidiDevices>,
    mappings: Res<MidiMappings>,
    diagnostics: Res<MidiMappingDiagnostics>,
    last_event: Res<LastMidiEvent>,
    mut touches: ResMut<MidiControlTouches>,
    mut detected: ResMut<DetectedMidiDevices>,
    broadcaster: Res<ClientEventSink>,
    mut last_profiled_devices: Local<Vec<String>>,
) {
    if detected.has_pending() {
        let names = detected.take_unmapped(&mappings);
        if !names.is_empty() {
            broadcaster.publish(
                DISCRIMINATOR_NON_DROPPABLE,
                &MidiWsMessage::MidiDeviceDetected(&names),
            );
        }
    }

    if !touches.0.is_empty() {
        broadcaster.publish(
            DISCRIMINATOR_NON_DROPPABLE,
            &MidiWsMessage::MidiControlTouched(&touches.0),
        );
        touches.0.clear();
    }

    // Only send if resources have changed
    if devices.is_changed() || mappings.is_changed() {
        send_device_list(&devices, &mappings, &broadcaster);
        let names = profiled_device_names(&devices, &mappings);
        if *last_profiled_devices != names {
            send_device_profiles(&names, &broadcaster);
            *last_profiled_devices = names;
        }
    }

    if mappings.is_changed() {
        tracing::debug!(
            "MIDI mappings changed, broadcasting {} mappings",
            mappings.mappings().len()
        );
        send_mappings(&mappings, &broadcaster);
    }

    if diagnostics.is_changed() {
        send_diagnostics(&diagnostics, &broadcaster);
    }

    if last_event.is_changed() {
        if let Some(ref event) = last_event.0 {
            send_last_event(event, &broadcaster);
        }
    }
}

/// Send device list to WebSocket clients
fn send_device_list(devices: &MidiDevices, mappings: &MidiMappings, broadcaster: &ClientEventSink) {
    let device_list: Vec<MidiDevice> = devices
        .devices()
        .map(|(name, has_output)| MidiDevice {
            name: name.to_string(),
            has_output,
            feedback: mappings.feedback_devices().is_enabled(name),
        })
        .collect();

    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &MidiWsMessage::MidiDeviceList(&device_list),
    );
    tracing::trace!("Sending MIDI device list to WebSocket clients");
}

/// Returns the connected or mapped devices that match a controller profile, in name order.
fn profiled_device_names(devices: &MidiDevices, mappings: &MidiMappings) -> Vec<String> {
    devices
        .devices()
        .map(|(name, _)| name)
        .chain(
            mappings
                .mappings()
                .iter()
                .map(|mapping| mapping.device_name.as_str()),
        )
        .filter(|name| profile::for_device(name).is_some())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .map(str::to_string)
        .collect()
}

/// Send the controller profile of each named device to WebSocket clients, so LED colors can
/// be named even for a controller that is not plugged in.
fn send_device_profiles(names: &[String], broadcaster: &ClientEventSink) {
    let profiles: Vec<MidiDeviceProfile> = names
        .iter()
        .filter_map(|device| {
            profile::for_device(device).map(|profile| MidiDeviceProfile::new(device, profile))
        })
        .collect();

    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &MidiWsMessage::MidiDeviceProfiles(&profiles),
    );
}

/// Send mappings to WebSocket clients
fn send_mappings(mappings: &MidiMappings, broadcaster: &ClientEventSink) {
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &MidiWsMessage::MidiMappings(mappings.mappings()),
    );
    tracing::trace!("Sending MIDI mappings to WebSocket clients");
}

/// Send the current MIDI mapping diagnostics to WebSocket clients.
fn send_diagnostics(diagnostics: &MidiMappingDiagnostics, broadcaster: &ClientEventSink) {
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &MidiWsMessage::MidiMappingDiagnostics(&diagnostics.0),
    );
}

/// Send last MIDI event to WebSocket clients
fn send_last_event(event: &MidiLastEvent, broadcaster: &ClientEventSink) {
    broadcaster.publish(
        DISCRIMINATOR_DROPPABLE,
        &MidiWsMessage::MidiLastEvent(event),
    );
}
