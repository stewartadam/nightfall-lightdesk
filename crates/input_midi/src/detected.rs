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

use crate::devices::MidiDevices;
use crate::mapping::MidiMappings;
use crate::service::is_session_key;

/// MIDI units that connected while the engine runs and wait to be announced to clients.
///
/// Units already connected when the world starts are known from the outset, and every unit
/// seen later becomes known too, so a controller is announced at most once per world even when
/// it is unplugged and plugged back in. Units are told apart by their unit key, so a second
/// identical controller is announced too.
#[derive(Resource, Debug, Default)]
pub(crate) struct DetectedMidiDevices {
    /// Unit keys of every unit seen so far.
    known: HashSet<String>,
    /// Newly seen unit keys not yet announced, in the order they appeared.
    pending: Vec<String>,
}

impl DetectedMidiDevices {
    /// Starts tracking with the `connected` units treated as known, so they are never
    /// announced.
    pub(crate) fn new(connected: &MidiDevices) -> Self {
        Self {
            known: connected.iter().map(announcement_key).collect(),
            pending: Vec::new(),
        }
    }

    /// Records the currently connected units, queueing each one not seen before for
    /// announcement.
    pub(crate) fn observe(&mut self, connected: &MidiDevices) {
        for device in connected.iter() {
            let key = announcement_key(device);
            if self.known.insert(key.clone()) {
                self.pending.push(key);
            }
        }
    }

    /// Returns whether any newly seen unit waits to be announced.
    pub(crate) fn has_pending(&self) -> bool {
        !self.pending.is_empty()
    }

    /// Takes the names of the units waiting to be announced, leaving out units that
    /// disconnected since and those whose device the show already maps.
    ///
    /// A mapped controller is already set up, so offering to set it up again would only be noise.
    pub(crate) fn take_unmapped(
        &mut self,
        connected: &MidiDevices,
        mappings: &MidiMappings,
    ) -> Vec<String> {
        std::mem::take(&mut self.pending)
            .into_iter()
            .filter_map(|key| {
                let device = connected
                    .iter()
                    .find(|device| announcement_key(device) == key)?;
                if mappings.maps_device(device.device) {
                    return None;
                }
                Some(device.name.clone())
            })
            .collect()
    }
}

/// Returns the key a unit is announced once under: its unit key, or its model when the key
/// only holds for the session and would change on every replug.
fn announcement_key(device: &crate::devices::ConnectedDevice) -> String {
    if is_session_key(&device.unit) {
        format!("model:{}", device.model)
    } else {
        device.unit.clone()
    }
}

#[cfg(test)]
mod tests {
    use nightfall_actions::{ActionReference, ControlBehavior};
    use uuid::Uuid;

    use super::*;
    use crate::command::{MidiMapping, MidiSource};
    use crate::devices::{ConnectedDevice, display_name};

    /// Builds connected units, each `(model, unit key, unsaved number)` with its own device.
    fn connected(units: &[(&str, &str, u32)]) -> MidiDevices {
        MidiDevices::new(
            units
                .iter()
                .enumerate()
                .map(|(index, (model, unit, number))| ConnectedDevice {
                    port: format!("port-{index}"),
                    model: (*model).to_string(),
                    unit: (*unit).to_string(),
                    has_output: true,
                    device: Uuid::from_u128(index as u128 + 1),
                    name: display_name(model, *number),
                    unsaved_number: Some(*number),
                })
                .collect(),
        )
    }

    /// Builds mappings holding one control on device `device`.
    fn mappings_for(device: Uuid) -> MidiMappings {
        let mut mappings = MidiMappings::default();
        mappings.upsert(
            MidiMapping {
                id: Uuid::from_u128(100),
                device,
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

    /// Verifies units connected at startup are never announced, while later ones are, once,
    /// including a second unit of a model already connected.
    #[test]
    fn announces_only_units_that_connect_later() {
        let mut detected = DetectedMidiDevices::new(&connected(&[("Launchpad", "a", 1)]));
        let mappings = MidiMappings::default();

        detected.observe(&connected(&[("Launchpad", "a", 1)]));
        assert!(!detected.has_pending());

        let later = connected(&[("Launchpad", "a", 1), ("Launchpad", "b", 2)]);
        detected.observe(&later);
        assert_eq!(
            detected.take_unmapped(&later, &mappings),
            vec!["Launchpad (2)"]
        );
        assert!(!detected.has_pending());
    }

    /// Verifies unplugging and replugging a unit does not announce it again.
    #[test]
    fn replugged_unit_is_not_announced_again() {
        let mut detected = DetectedMidiDevices::new(&MidiDevices::default());
        let mappings = MidiMappings::default();
        let grid = connected(&[("Grid", "a", 1)]);

        detected.observe(&grid);
        assert_eq!(detected.take_unmapped(&grid, &mappings), vec!["Grid"]);

        detected.observe(&MidiDevices::default());
        detected.observe(&grid);
        assert!(!detected.has_pending());
    }

    /// Verifies a unit whose device the show already maps is not announced.
    #[test]
    fn mapped_device_is_not_announced() {
        let mut detected = DetectedMidiDevices::new(&MidiDevices::default());
        let both = connected(&[("Grid", "a", 1), ("Launchpad", "b", 1)]);

        detected.observe(&both);
        assert_eq!(
            detected.take_unmapped(&both, &mappings_for(Uuid::from_u128(1))),
            vec!["Launchpad"]
        );
    }
}
