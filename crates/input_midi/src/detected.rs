// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Announces MIDI devices that connect while the engine runs, so clients can offer to set them
//! up.

use std::collections::HashSet;

use bevy_ecs::prelude::*;

use crate::mapping::MidiMappings;

/// MIDI devices that connected while the engine runs and wait to be announced to clients.
///
/// Devices already connected when the world starts are known from the outset, and every device
/// seen later becomes known too, so a controller is announced at most once per world even when
/// it is unplugged and plugged back in.
#[derive(Resource, Debug, Default)]
pub(crate) struct DetectedMidiDevices {
    /// Names of every device seen so far.
    known: HashSet<String>,
    /// Newly seen device names not yet announced, in the order they appeared.
    pending: Vec<String>,
}

impl DetectedMidiDevices {
    /// Starts tracking with `connected` devices treated as known, so they are never announced.
    pub(crate) fn new(connected: impl IntoIterator<Item = String>) -> Self {
        Self {
            known: connected.into_iter().collect(),
            pending: Vec::new(),
        }
    }

    /// Records the currently connected devices, queueing each one not seen before for
    /// announcement.
    pub(crate) fn observe<'a>(&mut self, connected: impl IntoIterator<Item = &'a str>) {
        for name in connected {
            if !self.known.contains(name) {
                self.known.insert(name.to_string());
                self.pending.push(name.to_string());
            }
        }
    }

    /// Returns whether any newly seen device waits to be announced.
    pub(crate) fn has_pending(&self) -> bool {
        !self.pending.is_empty()
    }

    /// Takes the devices waiting to be announced, leaving out those the show already maps.
    ///
    /// A mapped controller is already set up, so offering to set it up again would only be noise.
    pub(crate) fn take_unmapped(&mut self, mappings: &MidiMappings) -> Vec<String> {
        let mut pending = std::mem::take(&mut self.pending);
        pending.retain(|name| {
            !mappings
                .mappings()
                .iter()
                .any(|mapping| mapping.device_name == *name)
        });
        pending
    }
}

#[cfg(test)]
mod tests {
    use nightfall_actions::{ActionReference, ControlBehavior};

    use super::*;
    use crate::command::{MidiMapping, MidiSource};

    /// Builds mappings holding one control on `device`.
    fn mappings_for(device: &str) -> MidiMappings {
        let mut mappings = MidiMappings::default();
        mappings.upsert(
            MidiMapping {
                id: uuid::Uuid::from_u128(1),
                device_name: device.to_string(),
                source: MidiSource::Note {
                    channel: 0,
                    note: 60,
                },
                behavior: ControlBehavior::Press,
                action: ActionReference::new("test.trigger", serde_json::json!({})),
                led: Default::default(),
            },
            |_| None,
        );
        mappings
    }

    /// Verifies devices connected at startup are never announced, while later ones are, once.
    #[test]
    fn announces_only_devices_that_connect_later() {
        let mut detected = DetectedMidiDevices::new(["Launchpad".to_string()]);
        let mappings = MidiMappings::default();

        detected.observe(["Launchpad"]);
        assert!(!detected.has_pending());

        detected.observe(["Launchpad", "APC mini"]);
        assert_eq!(detected.take_unmapped(&mappings), vec!["APC mini"]);
        assert!(!detected.has_pending());
    }

    /// Verifies unplugging and replugging a device does not announce it again.
    #[test]
    fn replugged_device_is_not_announced_again() {
        let mut detected = DetectedMidiDevices::new([]);
        let mappings = MidiMappings::default();

        detected.observe(["Grid"]);
        assert_eq!(detected.take_unmapped(&mappings), vec!["Grid"]);

        detected.observe([]);
        detected.observe(["Grid"]);
        assert!(!detected.has_pending());
    }

    /// Verifies a device the show already maps is not announced.
    #[test]
    fn mapped_device_is_not_announced() {
        let mut detected = DetectedMidiDevices::new([]);

        detected.observe(["Grid", "Launchpad"]);
        assert_eq!(
            detected.take_unmapped(&mappings_for("Grid")),
            vec!["Launchpad"]
        );
    }
}
