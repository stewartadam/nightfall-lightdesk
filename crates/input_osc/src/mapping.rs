// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! OSC mapping storage and lookup.

use bevy_ecs::prelude::*;
use nightfall_actions::ActionReference;

use crate::command::{OscLastEvent, OscMapping};

/// Resource storing configured OSC mappings.
#[derive(Resource, Default, Debug, Clone)]
pub struct OscMappings {
    mappings: Vec<OscMapping>,
}

impl OscMappings {
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
        }]);

        assert_eq!(
            mappings.lookup(&test_event(vec![])),
            Some(&ActionReference::new("test.start", json!({ "id": 9 })))
        );
    }
}
