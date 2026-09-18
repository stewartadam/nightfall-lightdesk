// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! MIDI mapping storage and lookup

use bevy_ecs::prelude::*;
use nightfall_actions::ActionReference;

use crate::command::MidiMapping;

/// Resource storing all MIDI input mappings
#[derive(Resource, Default, Debug, Clone)]
pub struct MidiMappings {
    mappings: Vec<MidiMapping>,
}

impl MidiMappings {
    /// Create a new empty mappings collection
    pub fn new() -> Self {
        Self {
            mappings: Vec::new(),
        }
    }

    /// Replace all mappings with the provided list
    pub fn set_mappings(&mut self, mappings: Vec<MidiMapping>) {
        self.mappings = mappings;
    }

    /// Get all mappings
    pub fn mappings(&self) -> &[MidiMapping] {
        &self.mappings
    }

    /// Delete a mapping by index
    pub fn delete_mapping(&mut self, index: usize) -> bool {
        if index < self.mappings.len() {
            self.mappings.remove(index);
            true
        } else {
            false
        }
    }

    /// Look up an action for a given MIDI event
    ///
    /// Returns the first matching action, or None if no mapping matches.
    pub fn lookup(
        &self,
        device: &str,
        channel: u8,
        note: u8,
        velocity: u8,
    ) -> Option<&ActionReference> {
        self.mappings
            .iter()
            .find(|m| {
                m.device_name == device
                    && m.channel == channel
                    && m.note == note
                    && m.velocity.is_none_or(|v| v == velocity)
            })
            .map(|m| &m.action)
    }
}

#[cfg(test)]
mod tests {
    use nightfall_actions::ActionReference;
    use serde_json::json;

    use super::*;

    #[test]
    fn test_lookup_exact_match() {
        let mut mappings = MidiMappings::new();
        mappings.set_mappings(vec![MidiMapping {
            device_name: "Device A".to_string(),
            channel: 144,
            note: 60,
            velocity: Some(127),
            action: ActionReference::new("test.action", json!({ "id": 1 })),
        }]);

        // Exact match
        assert_eq!(
            mappings.lookup("Device A", 144, 60, 127),
            Some(&ActionReference::new("test.action", json!({ "id": 1 })))
        );

        // Wrong velocity
        assert!(mappings.lookup("Device A", 144, 60, 100).is_none());

        // Wrong device
        assert!(mappings.lookup("Device B", 144, 60, 127).is_none());
    }

    #[test]
    fn test_lookup_any_velocity() {
        let mut mappings = MidiMappings::new();
        mappings.set_mappings(vec![MidiMapping {
            device_name: "Device A".to_string(),
            channel: 144,
            note: 60,
            velocity: None, // Match any velocity
            action: ActionReference::new("test.action", json!({ "id": 1 })),
        }]);

        // Any velocity should match
        assert!(mappings.lookup("Device A", 144, 60, 0).is_some());
        assert!(mappings.lookup("Device A", 144, 60, 64).is_some());
        assert!(mappings.lookup("Device A", 144, 60, 127).is_some());
    }
}
