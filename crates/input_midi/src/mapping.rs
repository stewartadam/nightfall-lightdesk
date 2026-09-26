// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! MIDI mapping storage and lookup

use bevy_ecs::prelude::*;
use nightfall_actions::{ActionInputKind, ActionReference, ActionRegistry, ActionSurface};
use nightfall_engine::controller_learning::{LearnedControllerSource, LearnedGesture};
use nightfall_engine::prelude::CommandError;
use serde::Deserialize;

use crate::command::{MidiBindingInput, MidiMapping};

/// Coordinates encoded by the MIDI adapter during learning.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LearnedMidiSelector {
    device_name: String,
    channel: u8,
    note: u8,
}

/// Resource storing all MIDI input mappings
#[derive(Resource, Default, Debug, Clone)]
pub struct MidiMappings {
    mappings: Vec<MidiMapping>,
}

impl MidiMappings {
    /// Adds current domain target failures to cached contract and source diagnostics.
    /// Existing errors retain priority, and unavailable targets never remove saved bindings.
    pub fn target_validation_errors(
        &self,
        world: &World,
        registry: &ActionRegistry,
        contract_errors: &[Option<CommandError>],
    ) -> Vec<Option<CommandError>> {
        self.mappings
            .iter()
            .zip(contract_errors)
            .map(|(mapping, error)| {
                error.clone().or_else(|| {
                    registry
                        .validate_target(world, &mapping.action)
                        .err()
                        .map(|error| CommandError::new(error.code, error.message))
                })
            })
            .collect()
    }

    /// Identifies ambiguous identities or sources independently of action validity.
    pub(crate) fn bindings_conflict(left: &MidiMapping, right: &MidiMapping) -> bool {
        left.id == right.id
            || (left.device_name == right.device_name
                && left.channel == right.channel
                && left.note == right.note)
    }

    /// Diagnoses each retained binding independently, disabling both sides of an ambiguous source.
    pub fn validation_errors(&self, registry: &ActionRegistry) -> Vec<Option<CommandError>> {
        self.mappings
            .iter()
            .enumerate()
            .map(|(index, mapping)| {
                if let Err(error) = Self::validate_all(std::slice::from_ref(mapping), registry) {
                    return Some(error);
                }
                let conflicts = self
                    .mappings
                    .iter()
                    .enumerate()
                    .any(|(other_index, other)| {
                        index != other_index && Self::bindings_conflict(mapping, other)
                    });
                conflicts.then(|| {
                    CommandError::new(
                        "midi.mapping_conflict",
                        "This binding shares its identity or MIDI source with another binding",
                    )
                })
            })
            .collect()
    }

    /// Saves one exact-version edit atomically while retaining every unrelated binding.
    pub fn store_mapping(
        &mut self,
        expected: Option<&MidiMapping>,
        mapping: MidiMapping,
        registry: &ActionRegistry,
    ) -> Result<(), CommandError> {
        if expected.is_some_and(|previous| previous.id != mapping.id)
            || self
                .mappings
                .iter()
                .find(|current| current.id == mapping.id)
                != expected
        {
            return Err(CommandError::new(
                "midi.mapping_changed",
                "The binding changed; refresh before saving it",
            ));
        }
        let mut proposed = self.mappings.clone();
        let edited_index =
            if let Some(index) = proposed.iter().position(|current| current.id == mapping.id) {
                proposed[index] = mapping;
                index
            } else {
                proposed.push(mapping);
                proposed.len() - 1
            };
        let proposed = Self { mappings: proposed };
        if let Some(error) = proposed
            .validation_errors(registry)
            .into_iter()
            .nth(edited_index)
            .flatten()
        {
            return Err(error);
        }
        self.mappings = proposed.mappings;
        Ok(())
    }

    /// Rejects invalid bulk edits before mutating the collection.
    pub fn validate_all(
        mappings: &[MidiMapping],
        registry: &ActionRegistry,
    ) -> Result<(), CommandError> {
        for (index, mapping) in mappings.iter().enumerate() {
            if mapping.id.is_nil()
                || mapping.note > 127
                || !matches!(mapping.channel & 0xf0, 0x90 | 0xb0)
                || mapping.velocity.is_some_and(|value| value > 127)
            {
                return Err(CommandError::new(
                    "midi.invalid_binding",
                    "The MIDI binding has invalid source coordinates or identity",
                ));
            }
            if mappings[..index].iter().any(|other| {
                other.id == mapping.id
                    || (other.device_name == mapping.device_name
                        && other.channel == mapping.channel
                        && other.note == mapping.note)
            }) {
                return Err(CommandError::new(
                    "midi.mapping_conflict",
                    "MIDI bindings must have unique identities and sources",
                ));
            }
            let input_kind = if mapping.input == MidiBindingInput::Continuous {
                ActionInputKind::Scalar
            } else {
                ActionInputKind::Trigger
            };
            registry
                .validate_binding(&mapping.action, ActionSurface::Midi, input_kind)
                .map_err(|error| CommandError::new(error.code, error.message))?;
        }
        Ok(())
    }
    /// Validates and atomically installs a learned binding, rejecting stale or conflicting edits.
    pub fn bind_learned(
        &mut self,
        source: LearnedControllerSource,
        action: ActionReference,
        replace: Option<&MidiMapping>,
        registry: &ActionRegistry,
    ) -> Result<MidiMapping, CommandError> {
        let selector: LearnedMidiSelector = serde_json::from_value(source.selector)
            .map_err(|error| CommandError::new("midi.invalid_source", error.to_string()))?;
        if source.surface != ActionSurface::Midi
            || !matches!(selector.channel & 0xf0, 0x90 | 0xb0)
            || selector.note > 127
        {
            return Err(CommandError::new(
                "midi.invalid_source",
                "The captured MIDI source is unsupported",
            ));
        }
        let descriptor = registry.get(&action.id).ok_or_else(|| {
            CommandError::new(
                "action.not_registered",
                "The selected action is unavailable",
            )
        })?;
        let input = match descriptor.input_kind {
            ActionInputKind::Scalar => MidiBindingInput::Continuous,
            ActionInputKind::Trigger if source.gesture == LearnedGesture::Release => {
                MidiBindingInput::Release
            }
            ActionInputKind::Trigger => MidiBindingInput::Press,
        };
        registry
            .validate_binding(&action, ActionSurface::Midi, descriptor.input_kind)
            .map_err(|error| CommandError::new(error.code, error.message))?;
        if let Some(expected) = replace
            && !self.mappings.iter().any(|mapping| mapping == expected)
        {
            return Err(CommandError::new(
                "midi.mapping_changed",
                "The binding changed; refresh before replacing it",
            ));
        }
        if let Some(conflict) = self.mappings.iter().find(|mapping| {
            replace.is_none_or(|expected| mapping.id != expected.id)
                && mapping.device_name == selector.device_name
                && mapping.channel == selector.channel
                && mapping.note == selector.note
        }) {
            return Err(CommandError::new(
                "midi.mapping_conflict",
                "This controller already has a binding",
            )
            .with_details(serde_json::to_value(conflict).expect("MIDI bindings serialize")));
        }
        let mapping = MidiMapping {
            id: replace.map_or_else(uuid::Uuid::new_v4, |mapping| mapping.id),
            input,
            device_name: selector.device_name,
            channel: selector.channel,
            note: selector.note,
            velocity: None,
            action,
        };
        if let Some(expected) = replace {
            let slot = self
                .mappings
                .iter_mut()
                .find(|mapping| mapping.id == expected.id)
                .expect("replacement was validated");
            *slot = mapping.clone();
        } else {
            self.mappings.push(mapping.clone());
        }
        Ok(mapping)
    }

    /// Removes the exact version the client selected, independent of its current list position.
    pub fn remove_expected(&mut self, expected: &MidiMapping) -> Result<(), CommandError> {
        let index = self
            .mappings
            .iter()
            .position(|mapping| mapping == expected)
            .ok_or_else(|| {
                CommandError::new(
                    "midi.mapping_changed",
                    "The binding changed or was already removed",
                )
            })?;
        self.mappings.remove(index);
        Ok(())
    }
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

    /// Provides a domain-independent action for exercising binding validation and conflicts.
    fn registry() -> ActionRegistry {
        let mut registry = ActionRegistry::default();
        registry.register::<serde_json::Value, _>(
            nightfall_actions::ActionDescriptor {
                id: nightfall_actions::ActionId::new("test.go"),
                capabilities: Vec::new(),
                label: "Go".into(),
                allowed_surfaces: vec![ActionSurface::Midi],
                input_kind: ActionInputKind::Trigger,
                argument_schema: json!({ "type": "object" }),
            },
            |_, _, _| Ok(nightfall_actions::InvocationDispatch::succeeded()),
        );
        registry
    }

    /// Saving conflicts and stale replacements leave the previously installed binding intact.
    #[test]
    fn learned_binding_save_is_atomic_and_retains_identity_on_replacement() {
        let registry = registry();
        let source = LearnedControllerSource {
            surface: ActionSurface::Midi,
            selector: json!({ "device_name": "Keys", "channel": 144, "note": 42 }),
            label: "Keys 42".into(),
            gesture: LearnedGesture::Press,
        };
        let action = ActionReference::new("test.go", json!({ "slot": 1 }));
        let mut mappings = MidiMappings::default();
        let first = mappings
            .bind_learned(source.clone(), action.clone(), None, &registry)
            .unwrap();
        assert_eq!(
            mappings
                .bind_learned(source.clone(), action, None, &registry)
                .unwrap_err()
                .code,
            "midi.mapping_conflict"
        );
        assert_eq!(mappings.mappings(), &[first.clone()]);
        let second = mappings
            .bind_learned(
                source.clone(),
                ActionReference::new("test.go", json!({ "slot": 2 })),
                Some(&first),
                &registry,
            )
            .unwrap();
        assert_eq!(first.id, second.id);
        assert_eq!(
            mappings
                .bind_learned(source, first.action.clone(), Some(&first), &registry)
                .unwrap_err()
                .code,
            "midi.mapping_changed"
        );
        assert!(mappings.remove_expected(&first).is_err());
        assert_eq!(mappings.mappings(), &[second.clone()]);
        mappings.remove_expected(&second).unwrap();
        assert!(mappings.mappings().is_empty());
    }

    #[test]
    fn test_lookup_exact_match() {
        let mut mappings = MidiMappings::new();
        mappings.set_mappings(vec![MidiMapping {
            device_name: "Device A".to_string(),
            channel: 144,
            note: 60,
            velocity: Some(127),
            id: uuid::Uuid::new_v4(),
            input: crate::command::MidiBindingInput::Press,
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
            id: uuid::Uuid::new_v4(),
            input: crate::command::MidiBindingInput::Continuous,
            action: ActionReference::new("test.action", json!({ "id": 1 })),
        }]);

        // Any velocity should match
        assert!(mappings.lookup("Device A", 144, 60, 0).is_some());
        assert!(mappings.lookup("Device A", 144, 60, 64).is_some());
        assert!(mappings.lookup("Device A", 144, 60, 127).is_some());
    }
}
