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
use bevy_ecs::system::SystemParam;
use nightfall_actions::BindingDiagnostic;
use nightfall_engine::prelude::*;
use serde::Serialize;

use crate::command::{MidiLastEvent, MidiMapping};
use crate::detected::DetectedMidiDevices;
use crate::devices::{MidiDevices, display_name, profile_default};
use crate::mapping::MidiMappings;
use crate::profile::{self, MidiDeviceProfile};
use crate::{LastMidiEvent, MidiControlTouches, MidiMappingDiagnostics};

/// One MIDI device the show saves or that is connected, as clients list it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
#[typeshare::typeshare]
pub struct MidiDevice {
    /// Device ID mappings store; a connected new unit is saved under it once mapped.
    #[serde(with = "nightfall::serde_uuid_simple")]
    #[typeshare(serialized_as = "String")]
    pub id: uuid::Uuid,
    /// Name the device is shown under: its model, numbered from the second unit.
    pub name: String,
    /// Device model name, which controller profiles are matched by.
    pub model: String,
    /// Number telling identical units of the model apart, from 1.
    pub number: u32,
    /// Whether the show saves the device; a connected unit that is not saved is new.
    pub saved: bool,
    /// Whether the device is connected.
    pub connected: bool,
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
    /// Saved and connected MIDI devices: saved devices in the order they were added, then
    /// connected new units
    MidiDeviceList(&'a [MidiDevice]),
    /// Controller profiles of connected and saved devices, one per model
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
    /// Names of units that connected while the engine runs and that the show does not map
    /// yet, so clients can offer to set them up. Each unit is announced once.
    MidiDeviceDetected(&'a [String]),
}

/// The connected and mapped MIDI devices that the device list and profile feeds describe.
#[derive(SystemParam)]
pub(crate) struct MidiDevicesFeed<'w> {
    devices: Res<'w, MidiDevices>,
    mappings: Res<'w, MidiMappings>,
}

impl ClientFeed for MidiDevicesFeed<'static> {
    /// Publishes the connected devices with whether each one has feedback enabled.
    fn publish(feed: &MidiDevicesFeed<'_>, sink: &ClientEventSink) {
        send_device_list(&feed.devices, &feed.mappings, sink);
    }
}

/// The controller profiles of every connected or mapped device that has one.
#[derive(SystemParam)]
pub(crate) struct MidiDeviceProfilesFeed<'w> {
    devices: MidiDevicesFeed<'w>,
}

impl ClientFeed for MidiDeviceProfilesFeed<'static> {
    /// Publishes the profile of every profiled device.
    fn publish(feed: &MidiDeviceProfilesFeed<'_>, sink: &ClientEventSink) {
        let models = profiled_models(&feed.devices.devices, &feed.devices.mappings);
        send_device_profiles(&models, sink);
    }
}

/// Run condition that passes when the devices or mappings change the set of profiled devices.
pub(crate) fn profiled_devices_changed(
    devices: Res<MidiDevices>,
    mappings: Res<MidiMappings>,
    mut last_passed: Local<Option<Vec<String>>>,
) -> bool {
    if !devices.is_changed() && !mappings.is_changed() {
        return false;
    }
    let models = profiled_models(&devices, &mappings);
    if last_passed.as_ref() == Some(&models) {
        return false;
    }
    *last_passed = Some(models);
    true
}

impl ResourceFeed for MidiMappings {
    /// Publishes the configured MIDI mappings.
    fn publish(&self, sink: &ClientEventSink) {
        send_mappings(self, sink);
    }
}

impl ResourceFeed for MidiMappingDiagnostics {
    /// Publishes the MIDI mappings that cannot currently invoke their action.
    fn publish(&self, sink: &ClientEventSink) {
        send_diagnostics(self, sink);
    }
}

impl ResourceFeed for LastMidiEvent {
    /// Publishes the last MIDI event, if any.
    fn publish(&self, sink: &ClientEventSink) {
        if let Some(event) = &self.0 {
            send_last_event(event, sink);
        }
    }
}

/// Announces newly connected unmapped devices and sends the messages received while controller
/// mapping mode is active, draining both.
pub fn send_midi_announcements(
    mappings: Res<MidiMappings>,
    devices: Res<MidiDevices>,
    mut touches: ResMut<MidiControlTouches>,
    mut detected: ResMut<DetectedMidiDevices>,
    broadcaster: Res<ClientEventSink>,
) {
    if detected.has_pending() {
        let names = detected.take_unmapped(&devices, &mappings);
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
}

/// Lists the saved devices, each with whether it is connected, followed by the connected
/// units the show does not save yet.
pub(crate) fn device_list(devices: &MidiDevices, mappings: &MidiMappings) -> Vec<MidiDevice> {
    let saved = mappings.devices().settings().iter().map(|setting| {
        let connected = devices.by_device(setting.id);
        MidiDevice {
            id: setting.id,
            name: setting.display_name(),
            model: setting.model.clone(),
            number: setting.number,
            saved: true,
            connected: connected.is_some(),
            has_output: connected.is_some_and(|connected| connected.has_output),
            feedback: setting.feedback_enabled(),
        }
    });
    // A unit saved this frame stays listed as new until its port is reassigned, so it is
    // left out here rather than listed twice.
    let unsaved = devices.iter().filter_map(|connected| {
        let number = connected.unsaved_number?;
        if mappings.devices().get(connected.device).is_some() {
            return None;
        }
        Some(MidiDevice {
            id: connected.device,
            name: display_name(&connected.model, number),
            model: connected.model.clone(),
            number,
            saved: false,
            connected: true,
            has_output: connected.has_output,
            feedback: profile_default(&connected.model),
        })
    });
    saved.chain(unsaved).collect()
}

/// Publishes the saved and connected devices.
fn send_device_list(devices: &MidiDevices, mappings: &MidiMappings, broadcaster: &ClientEventSink) {
    let device_list = device_list(devices, mappings);
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &MidiWsMessage::MidiDeviceList(&device_list),
    );
    tracing::trace!("Sending MIDI device list to WebSocket clients");
}

/// Returns the models of connected and saved devices that match a controller profile, in
/// name order.
fn profiled_models(devices: &MidiDevices, mappings: &MidiMappings) -> Vec<String> {
    devices
        .iter()
        .map(|connected| connected.model.as_str())
        .chain(
            mappings
                .devices()
                .settings()
                .iter()
                .map(|device| device.model.as_str()),
        )
        .filter(|model| profile::for_device(model).is_some())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .map(str::to_string)
        .collect()
}

/// Send the controller profile of each model to WebSocket clients, so LED colors can be
/// named even for a controller that is not plugged in.
fn send_device_profiles(models: &[String], broadcaster: &ClientEventSink) {
    let profiles: Vec<MidiDeviceProfile> = models
        .iter()
        .filter_map(|model| {
            profile::for_device(model).map(|profile| MidiDeviceProfile::new(model, profile))
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
