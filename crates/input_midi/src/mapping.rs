// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! MIDI mapping storage and lookup

use bevy_ecs::prelude::*;
use uuid::Uuid;

use crate::command::{MidiMapping, MidiSource};

/// Resource storing all MIDI input mappings.
#[derive(Resource, Default, Debug, Clone)]
pub struct MidiMappings {
    mappings: Vec<MidiMapping>,
}

impl MidiMappings {
    /// Create a new empty mappings collection.
    pub fn new() -> Self {
        Self {
            mappings: Vec::new(),
        }
    }

    /// Replace all mappings with the provided list, as when loading a showfile.
    pub fn set_mappings(&mut self, mappings: Vec<MidiMapping>) {
        self.mappings = mappings;
    }

    /// Get all mappings.
    pub fn mappings(&self) -> &[MidiMapping] {
        &self.mappings
    }

    /// Creates or replaces a mapping and returns the IDs of other mappings it displaced.
    ///
    /// A control drives at most one action, so any other mapping on the same device and
    /// control is removed. An existing mapping with the same ID keeps its list position.
    pub fn upsert(&mut self, mapping: MidiMapping) -> Vec<Uuid> {
        let displaced = self
            .mappings
            .iter()
            .filter(|existing| {
                existing.id != mapping.id
                    && existing.device_name == mapping.device_name
                    && existing.source == mapping.source
            })
            .map(|existing| existing.id)
            .collect::<Vec<_>>();
        self.mappings
            .retain(|existing| !displaced.contains(&existing.id));
        match self
            .mappings
            .iter_mut()
            .find(|existing| existing.id == mapping.id)
        {
            Some(existing) => *existing = mapping,
            None => self.mappings.push(mapping),
        }
        displaced
    }

    /// Deletes a mapping by ID and reports whether it existed.
    pub fn delete(&mut self, id: Uuid) -> bool {
        let before = self.mappings.len();
        self.mappings.retain(|mapping| mapping.id != id);
        self.mappings.len() != before
    }

    /// Looks up the mapping bound to one control on a device.
    pub fn lookup(&self, device: &str, source: MidiSource) -> Option<&MidiMapping> {
        self.mappings
            .iter()
            .find(|mapping| mapping.device_name == device && mapping.source == source)
    }
}

#[cfg(test)]
mod tests {
    use nightfall_actions::ActionReference;
    use serde_json::json;

    use super::*;

    /// Builds a note mapping with a deterministic ID.
    fn note_mapping(id: u128, device: &str, note: u8, action: &str) -> MidiMapping {
        MidiMapping {
            id: Uuid::from_u128(id),
            device_name: device.to_string(),
            source: MidiSource::Note { channel: 0, note },
            action: ActionReference::new(action, json!({})),
        }
    }

    /// Verifies lookup matches both the device and the control.
    #[test]
    fn lookup_matches_device_and_control() {
        let mut mappings = MidiMappings::new();
        mappings.upsert(note_mapping(1, "Device A", 60, "test.a"));

        assert!(
            mappings
                .lookup(
                    "Device A",
                    MidiSource::Note {
                        channel: 0,
                        note: 60
                    }
                )
                .is_some()
        );
        assert!(
            mappings
                .lookup(
                    "Device B",
                    MidiSource::Note {
                        channel: 0,
                        note: 60
                    }
                )
                .is_none()
        );
        assert!(
            mappings
                .lookup(
                    "Device A",
                    MidiSource::ControlChange {
                        channel: 0,
                        controller: 60
                    }
                )
                .is_none()
        );
    }

    /// Verifies binding a control again replaces its previous mapping.
    #[test]
    fn upsert_replaces_other_mappings_on_the_same_control() {
        let mut mappings = MidiMappings::new();
        mappings.upsert(note_mapping(1, "Device A", 60, "test.a"));
        mappings.upsert(note_mapping(2, "Device A", 61, "test.b"));

        let displaced = mappings.upsert(note_mapping(3, "Device A", 60, "test.c"));

        assert_eq!(displaced, vec![Uuid::from_u128(1)]);
        assert_eq!(
            mappings
                .mappings()
                .iter()
                .map(|mapping| mapping.action.id.as_str())
                .collect::<Vec<_>>(),
            vec!["test.b", "test.c"]
        );
    }

    /// Verifies editing a mapping by ID updates it in place.
    #[test]
    fn upsert_edits_existing_mapping_in_place() {
        let mut mappings = MidiMappings::new();
        mappings.upsert(note_mapping(1, "Device A", 60, "test.a"));
        mappings.upsert(note_mapping(2, "Device A", 61, "test.b"));

        let displaced = mappings.upsert(note_mapping(1, "Device A", 62, "test.c"));

        assert!(displaced.is_empty());
        assert_eq!(mappings.mappings()[0].action.id.as_str(), "test.c");
        assert!(mappings.delete(Uuid::from_u128(1)));
        assert!(!mappings.delete(Uuid::from_u128(1)));
    }
}
