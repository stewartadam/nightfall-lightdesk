// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! OSC mapping storage and lookup.

use bevy_ecs::prelude::*;
use nightfall_actions::{ActionInputKind, ActionReference, ActionRegistry, ActionSurface};
use nightfall_engine::controller_learning::{LearnedControllerSource, LearnedGesture};
use nightfall_engine::prelude::CommandError;

use crate::command::{OscBindingInput, OscLastEvent, OscMapping};

/// Resource storing configured OSC mappings.
#[derive(Resource, Default, Debug, Clone)]
pub struct OscMappings {
    mappings: Vec<OscMapping>,
}

impl OscMappings {
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
    pub(crate) fn bindings_conflict(left: &OscMapping, right: &OscMapping) -> bool {
        left.id == right.id || selectors_overlap(left, right)
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
                        "osc.mapping_conflict",
                        "This binding shares its identity or OSC source with another binding",
                    )
                })
            })
            .collect()
    }

    /// Saves one exact-version edit atomically while retaining every unrelated binding.
    pub fn store_mapping(
        &mut self,
        expected: Option<&OscMapping>,
        mapping: OscMapping,
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
                "osc.mapping_changed",
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

    /// Validates source ranges, identities, overlapping selectors and domain input contracts.
    pub fn validate_all(
        mappings: &[OscMapping],
        registry: &ActionRegistry,
    ) -> Result<(), CommandError> {
        for (index, mapping) in mappings.iter().enumerate() {
            if mapping.id.is_nil() || !mapping.address.starts_with('/') {
                return Err(CommandError::new(
                    "osc.invalid_binding",
                    "OSC bindings require an identity and an address beginning with /",
                ));
            }
            let kind = match mapping.input {
                OscBindingInput::LegacyContinuous => ActionInputKind::Scalar,
                OscBindingInput::Continuous { minimum, maximum } => {
                    if !minimum.is_finite()
                        || !maximum.is_finite()
                        || maximum <= minimum
                        || !(maximum - minimum).is_finite()
                    {
                        return Err(CommandError::new(
                            "osc.invalid_range",
                            "The OSC range must be finite with a maximum greater than its minimum",
                        ));
                    }
                    ActionInputKind::Scalar
                }
                _ => ActionInputKind::Trigger,
            };
            registry
                .validate_binding(&mapping.action, ActionSurface::Osc, kind)
                .map_err(|error| CommandError::new(error.code, error.message))?;
            if let Some(conflict) = mappings[..index]
                .iter()
                .find(|other| other.id == mapping.id || selectors_overlap(other, mapping))
            {
                return Err(CommandError::new(
                    "osc.mapping_conflict",
                    "This OSC source already has a binding",
                )
                .with_details(serde_json::to_value(conflict).expect("OSC bindings serialize")));
            }
        }
        Ok(())
    }

    /// Installs a captured source atomically, preserving identity when explicitly replacing it.
    pub fn bind_learned(
        &mut self,
        source: LearnedControllerSource,
        action: ActionReference,
        replace: Option<&OscMapping>,
        arg_index: Option<u8>,
        input: Option<OscBindingInput>,
        registry: &ActionRegistry,
    ) -> Result<OscMapping, CommandError> {
        let address = source
            .selector
            .get("address")
            .and_then(|value| value.as_str())
            .filter(|_| source.surface == ActionSurface::Osc)
            .ok_or_else(|| {
                CommandError::new(
                    "osc.invalid_source",
                    "The captured OSC source is unavailable",
                )
            })?;
        let descriptor = registry.get(&action.id).ok_or_else(|| {
            CommandError::new(
                "action.not_registered",
                "The selected action is unavailable",
            )
        })?;
        if source.gesture == LearnedGesture::Pulse
            && descriptor.input_kind == ActionInputKind::Scalar
        {
            return Err(CommandError::new(
                "osc.incompatible_input",
                "This OSC source has no value. Choose a button action or learn a fader instead.",
            ));
        }
        let input = input.unwrap_or_else(|| match descriptor.input_kind {
            ActionInputKind::Scalar => OscBindingInput::Continuous {
                minimum: 0.0,
                maximum: 1.0,
            },
            ActionInputKind::Trigger => match source.gesture {
                LearnedGesture::Release => OscBindingInput::Release,
                LearnedGesture::Pulse => OscBindingInput::Pulse,
                _ => OscBindingInput::Press,
            },
        });
        if let Some(expected) = replace
            && !self.mappings.contains(expected)
        {
            return Err(CommandError::new(
                "osc.mapping_changed",
                "The binding changed; refresh before replacing it",
            ));
        }
        let mapping = OscMapping {
            id: replace.map_or_else(uuid::Uuid::new_v4, |mapping| mapping.id),
            source: None,
            address: address.into(),
            arg_index: Some(arg_index.unwrap_or(0)),
            arg_value: None,
            input,
            action,
        };
        if let Some(conflict) = self.mappings.iter().find(|existing| {
            existing.id != mapping.id && Self::bindings_conflict(existing, &mapping)
        }) {
            return Err(CommandError::new(
                "osc.mapping_conflict",
                "This OSC source already has a binding",
            )
            .with_details(serde_json::to_value(conflict).expect("OSC bindings serialize")));
        }
        self.store_mapping(replace, mapping.clone(), registry)?;
        Ok(mapping)
    }

    /// Removes the exact version read by the client, rejecting stale deletion requests.
    pub fn remove_expected(&mut self, expected: &OscMapping) -> Result<(), CommandError> {
        let index = self
            .mappings
            .iter()
            .position(|mapping| mapping == expected)
            .ok_or_else(|| {
                CommandError::new(
                    "osc.mapping_changed",
                    "The binding changed or was already removed",
                )
            })?;
        self.mappings.remove(index);
        Ok(())
    }
    /// Create empty mappings.
    pub fn new() -> Self {
        Self {
            mappings: Vec::new(),
        }
    }

    /// Replace all mappings.
    pub fn set_mappings(&mut self, mappings: Vec<OscMapping>) {
        self.mappings = mappings.into_iter().map(normalize_mapping).collect();
    }

    /// Return all mappings.
    pub fn mappings(&self) -> &[OscMapping] {
        &self.mappings
    }

    /// Delete mapping by index.
    pub fn delete_mapping(&mut self, index: usize) -> bool {
        if index < self.mappings.len() {
            self.mappings.remove(index);
            true
        } else {
            false
        }
    }

    /// Return the first matching action for the provided OSC event.
    pub fn lookup(&self, event: &OscLastEvent) -> Option<&ActionReference> {
        self.lookup_mapping(event).map(|mapping| &mapping.action)
    }

    /// Return the first matching mapping for the provided OSC event.
    pub fn lookup_mapping(&self, event: &OscLastEvent) -> Option<&OscMapping> {
        self.mappings
            .iter()
            .find(|mapping| mapping_matches_event(mapping, event))
    }
}

/// Detects overlapping source filters, including an unrestricted sender or argument value.
fn selectors_overlap(left: &OscMapping, right: &OscMapping) -> bool {
    left.address == right.address
        && (left.source.is_none() || right.source.is_none() || left.source == right.source)
        && (left.arg_value.is_none()
            || right.arg_value.is_none()
            || left.arg_index.unwrap_or(0) != right.arg_index.unwrap_or(0)
            || left.arg_value == right.arg_value)
}

fn mapping_matches_event(mapping: &OscMapping, event: &OscLastEvent) -> bool {
    let source_filter = mapping
        .source
        .as_deref()
        .map(str::trim)
        .filter(|source| !source.is_empty());
    if source_filter.is_some_and(|source| source != event.source) {
        return false;
    }
    if mapping.address != event.address {
        return false;
    }

    let expected_value = mapping
        .arg_value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let Some(expected_value) = expected_value else {
        return true;
    };

    let arg_index = mapping.arg_index.unwrap_or(0) as usize;
    event
        .args
        .get(arg_index)
        .map(|value| value.as_match_value())
        .is_some_and(|value| value == expected_value)
}

fn normalize_mapping(mut mapping: OscMapping) -> OscMapping {
    if mapping
        .source
        .as_deref()
        .is_some_and(|source| source.trim().is_empty())
    {
        mapping.source = None;
    }
    if mapping
        .arg_value
        .as_deref()
        .is_some_and(|value| value.trim().is_empty())
    {
        mapping.arg_value = None;
    }
    mapping
}

#[cfg(test)]
mod tests {
    use nightfall_actions::ActionReference;
    use serde_json::json;

    use super::*;
    use crate::command::OscType;

    /// A value-less captured pulse cannot be saved as a continuous action, even with overrides.
    #[test]
    fn learned_pulse_rejects_scalar_binding_without_mutating_storage() {
        use nightfall_actions::{ActionDescriptor, InvocationDispatch};
        let mut registry = ActionRegistry::default();
        registry.register::<serde_json::Value, _>(
            ActionDescriptor {
                id: nightfall_actions::ActionId::new("test.scalar"),
                label: "Scalar".into(),
                allowed_surfaces: vec![ActionSurface::Osc],
                input_kind: ActionInputKind::Scalar,
                argument_schema: json!({}),
                capabilities: vec![],
            },
            |_, _, _| Ok(InvocationDispatch::succeeded()),
        );
        let mut mappings = OscMappings::new();
        for input in [
            None,
            Some(OscBindingInput::Continuous {
                minimum: 0.0,
                maximum: 1.0,
            }),
        ] {
            let result = mappings.bind_learned(
                LearnedControllerSource {
                    surface: ActionSurface::Osc,
                    selector: json!({"address": "/pulse", "arg_index": 0}),
                    label: "Pulse".into(),
                    gesture: LearnedGesture::Pulse,
                },
                ActionReference::new("test.scalar", json!({})),
                None,
                None,
                input,
                &registry,
            );
            assert_eq!(result.unwrap_err().code, "osc.incompatible_input");
            assert!(mappings.mappings().is_empty());
        }
    }

    fn test_event(args: Vec<OscType>) -> OscLastEvent {
        OscLastEvent {
            source: "127.0.0.1:9000".to_string(),
            address: "/exec/start".to_string(),
            args,
        }
    }

    #[test]
    fn lookup_matches_on_address_and_source() {
        let mut mappings = OscMappings::new();
        mappings.set_mappings(vec![OscMapping {
            source: Some("127.0.0.1:9000".to_string()),
            address: "/exec/start".to_string(),
            arg_index: None,
            arg_value: None,
            action: ActionReference::new("test.start", json!({ "id": 5 })),
            id: uuid::Uuid::new_v4(),
            input: crate::command::OscBindingInput::Pulse,
        }]);

        assert_eq!(
            mappings.lookup(&test_event(vec![])),
            Some(&ActionReference::new("test.start", json!({ "id": 5 })))
        );
    }

    #[test]
    fn lookup_matches_arg_value_with_default_index_zero() {
        let mut mappings = OscMappings::new();
        mappings.set_mappings(vec![OscMapping {
            source: None,
            address: "/exec/start".to_string(),
            arg_index: None,
            arg_value: Some("42".to_string()),
            action: ActionReference::new("test.go", json!({ "id": 7 })),
            id: uuid::Uuid::new_v4(),
            input: crate::command::OscBindingInput::Pulse,
        }]);

        assert_eq!(
            mappings.lookup(&test_event(vec![OscType::Int(42)])),
            Some(&ActionReference::new("test.go", json!({ "id": 7 })))
        );
        assert!(
            mappings
                .lookup(&test_event(vec![OscType::Int(41)]))
                .is_none()
        );
    }

    #[test]
    fn lookup_matches_custom_arg_index() {
        let mut mappings = OscMappings::new();
        mappings.set_mappings(vec![OscMapping {
            source: None,
            address: "/exec/start".to_string(),
            arg_index: Some(1),
            arg_value: Some("go".to_string()),
            action: ActionReference::new("test.eval", json!({ "command": "clip 1 go" })),
            id: uuid::Uuid::new_v4(),
            input: crate::command::OscBindingInput::Pulse,
        }]);

        assert_eq!(
            mappings.lookup(&test_event(vec![
                OscType::Int(1),
                OscType::String("go".to_string())
            ])),
            Some(&ActionReference::new(
                "test.eval",
                json!({ "command": "clip 1 go" })
            ))
        );
    }

    #[test]
    fn lookup_treats_blank_optional_filters_as_unset() {
        let mut mappings = OscMappings::new();
        mappings.set_mappings(vec![OscMapping {
            source: Some("".to_string()),
            address: "/exec/start".to_string(),
            arg_index: None,
            arg_value: Some("   ".to_string()),
            action: ActionReference::new("test.start", json!({ "id": 9 })),
            id: uuid::Uuid::new_v4(),
            input: crate::command::OscBindingInput::Pulse,
        }]);

        assert_eq!(
            mappings.lookup(&test_event(vec![])),
            Some(&ActionReference::new("test.start", json!({ "id": 9 })))
        );
    }
}
