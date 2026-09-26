// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! OSC mapping storage and lookup.

use bevy_ecs::prelude::*;
use nightfall_actions::{
    ActionInputKind, ActionReference, BindingStore, InvocationError, SourceSignal,
};
use uuid::Uuid;

use crate::command::{OscLastEvent, OscMapping, OscType, OscValueRange};

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

    /// Replace all mappings, as when loading a showfile.
    pub fn set_mappings(&mut self, mappings: Vec<OscMapping>) {
        self.mappings = mappings.into_iter().map(normalize_mapping).collect();
    }

    /// Return all mappings.
    pub fn mappings(&self) -> &[OscMapping] {
        &self.mappings
    }

    /// Creates or replaces a mapping and returns the other mappings it displaced.
    ///
    /// Mappings with identical match criteria address the same control, which fires at most
    /// one action per edge, so any such mapping that would fire from the same edge is removed
    /// (see [`nightfall_actions::ControlBehavior::overlaps`]). `input_kind` reports the input kind
    /// of a bound action. An existing mapping with the same ID keeps its list position.
    pub fn upsert(
        &mut self,
        mapping: OscMapping,
        input_kind: impl Fn(&ActionReference) -> Option<ActionInputKind>,
    ) -> Vec<OscMapping> {
        let mapping = normalize_mapping(mapping);
        let kind = input_kind(&mapping.action);
        let (displaced, kept) = std::mem::take(&mut self.mappings)
            .into_iter()
            .partition::<Vec<_>, _>(|existing| {
                existing.id != mapping.id
                    && same_criteria(existing, &mapping)
                    && mapping.behavior.overlaps(
                        kind,
                        existing.behavior,
                        input_kind(&existing.action),
                    )
            });
        self.mappings = kept;
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

    /// Returns the mappings bound to the control that sent an OSC message.
    ///
    /// The first mapping whose criteria match identifies the control; every mapping with the
    /// same criteria is returned with it, at most one per edge.
    pub fn lookup(&self, event: &OscLastEvent) -> impl Iterator<Item = &OscMapping> {
        let control = self
            .mappings
            .iter()
            .find(|mapping| mapping_matches_event(mapping, event));
        self.mappings
            .iter()
            .filter(move |mapping| control.is_some_and(|control| same_criteria(control, mapping)))
    }
}

impl BindingStore for OscMappings {
    type Binding = OscMapping;

    /// Returns the mappings in list order.
    fn bindings(&self) -> &[OscMapping] {
        &self.mappings
    }

    /// Returns the mappings for undo and redo restoration.
    fn bindings_mut(&mut self) -> &mut Vec<OscMapping> {
        &mut self.mappings
    }

    /// Returns the mapping's stable ID.
    fn binding_id(binding: &OscMapping) -> Uuid {
        binding.id
    }
}

impl OscMapping {
    /// Returns the signal a matched message carries for this mapping.
    ///
    /// A mapping with pressed and released argument values reports button edges. One that
    /// matches only an exact argument value, or reads no argument, treats each message as a
    /// stateless pulse. Otherwise the selected argument is read as a button (booleans) or a
    /// normalized level (numbers).
    pub fn signal(&self, event: &OscLastEvent) -> SourceSignal {
        if let Some(pressed) = self.arg_value.as_deref() {
            let arg = event
                .args
                .get(usize::from(self.arg_index.unwrap_or(0)))
                .map(OscType::as_match_value);
            return match self.release_value.as_deref() {
                Some(released) if arg.as_deref() == Some(released.trim()) => {
                    SourceSignal::Button(false)
                }
                Some(_) if arg.as_deref() == Some(pressed.trim()) => SourceSignal::Button(true),
                _ => SourceSignal::Pulse,
            };
        }
        let Some(arg_index) = self.arg_index else {
            return SourceSignal::Pulse;
        };
        match event.args.get(usize::from(arg_index)) {
            Some(OscType::Bool(pressed)) => SourceSignal::Button(*pressed),
            Some(arg) => self
                .level(arg)
                .map_or(SourceSignal::Pulse, SourceSignal::Level),
            None => SourceSignal::Pulse,
        }
    }

    /// Converts a numeric argument into a level in `0..=1`.
    ///
    /// A valid explicit range maps linearly between its ends; without one (or with an
    /// invalid one, which diagnostics report) the argument's units are inferred.
    fn level(&self, arg: &OscType) -> Option<f32> {
        match self
            .range
            .and_then(|range| range.normalize(arg.as_number()?))
        {
            Some(level) => Some(level),
            None => arg
                .as_hardware_fader_percent()
                .map(|percent| percent / 100.0),
        }
    }

    /// Checks the mapping's own settings, independent of the action it binds.
    pub fn validate(&self) -> Result<(), InvocationError> {
        self.range.as_ref().map_or(Ok(()), OscValueRange::validate)
    }

    /// Returns whether messages matched by this mapping can drive an action input kind.
    pub fn can_drive(&self, kind: ActionInputKind) -> bool {
        self.reports_release() || SourceSignal::Pulse.can_drive(kind)
    }

    /// Returns whether matched messages report the control being released.
    ///
    /// Mappings with a released value, or that read an argument without matching a value,
    /// report button edges or levels; value-matched mappings without one are pulses.
    pub fn reports_release(&self) -> bool {
        self.release_value.is_some() || (self.arg_value.is_none() && self.arg_index.is_some())
    }

    /// Explains in plain language why matched messages cannot drive the action `label`.
    ///
    /// Describes what the mapping reads from each message and how to change it: a mapping
    /// matching one exact value only fires, and one without an argument index reads nothing.
    pub fn explain_undrivable(&self, label: &str) -> String {
        match self.arg_value.as_deref() {
            Some(value) => format!(
                "OSC {} only matches the value {value}, so it cannot set '{label}'. Clear the \
                 argument match so the mapping reads the value.",
                self.address
            ),
            None => format!(
                "OSC {} is not set to read a value, so it cannot set '{label}'. Send a number \
                 with the message, such as 0.5, and map it again.",
                self.address
            ),
        }
    }
}

/// Returns whether two mappings match exactly the same messages.
fn same_criteria(left: &OscMapping, right: &OscMapping) -> bool {
    left.source == right.source
        && left.address == right.address
        && left.arg_index == right.arg_index
        && left.arg_value == right.arg_value
}

/// Returns whether one OSC message matches a mapping's source, address, and argument criteria.
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
    let release_value = mapping.release_value.as_deref().map(str::trim);
    event
        .args
        .get(arg_index)
        .map(|value| value.as_match_value())
        .is_some_and(|value| value == expected_value || Some(value.as_str()) == release_value)
}

/// Clears blank optional filters so they behave as unset.
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
    // A released value only distinguishes edges alongside a pressed value.
    if mapping.arg_value.is_none()
        || mapping
            .release_value
            .as_deref()
            .is_some_and(|value| value.trim().is_empty())
    {
        mapping.release_value = None;
    }
    mapping
}

#[cfg(test)]
mod tests {
    use nightfall_actions::ActionReference;
    use nightfall_actions::ControlBehavior;
    use serde_json::json;

    use super::*;
    use crate::command::OscType;

    /// Returns the action of the first mapping bound to the control that sent an event.
    fn first_action<'a>(
        mappings: &'a OscMappings,
        event: &OscLastEvent,
    ) -> Option<&'a ActionReference> {
        mappings.lookup(event).next().map(|mapping| &mapping.action)
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
            id: Uuid::nil(),
            source: Some("127.0.0.1:9000".to_string()),
            address: "/exec/start".to_string(),
            arg_index: None,
            arg_value: None,
            release_value: None,
            range: None,
            behavior: ControlBehavior::Press,
            action: ActionReference::new("test.start", json!({ "id": 5 })),
        }]);

        assert_eq!(
            first_action(&mappings, &test_event(vec![])),
            Some(&ActionReference::new("test.start", json!({ "id": 5 })))
        );
    }

    #[test]
    fn lookup_matches_arg_value_with_default_index_zero() {
        let mut mappings = OscMappings::new();
        mappings.set_mappings(vec![OscMapping {
            id: Uuid::nil(),
            source: None,
            address: "/exec/start".to_string(),
            arg_index: None,
            arg_value: Some("42".to_string()),
            release_value: None,
            range: None,
            behavior: ControlBehavior::Press,
            action: ActionReference::new("test.go", json!({ "id": 7 })),
        }]);

        assert_eq!(
            first_action(&mappings, &test_event(vec![OscType::Int(42)])),
            Some(&ActionReference::new("test.go", json!({ "id": 7 })))
        );
        assert!(first_action(&mappings, &test_event(vec![OscType::Int(41)])).is_none());
    }

    #[test]
    fn lookup_matches_custom_arg_index() {
        let mut mappings = OscMappings::new();
        mappings.set_mappings(vec![OscMapping {
            id: Uuid::nil(),
            source: None,
            address: "/exec/start".to_string(),
            arg_index: Some(1),
            arg_value: Some("go".to_string()),
            release_value: None,
            range: None,
            behavior: ControlBehavior::Press,
            action: ActionReference::new("test.eval", json!({ "command": "clip 1 go" })),
        }]);

        assert_eq!(
            first_action(
                &mappings,
                &test_event(vec![OscType::Int(1), OscType::String("go".to_string())])
            ),
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
            id: Uuid::nil(),
            source: Some("".to_string()),
            address: "/exec/start".to_string(),
            arg_index: None,
            arg_value: Some("   ".to_string()),
            release_value: None,
            range: None,
            behavior: ControlBehavior::Press,
            action: ActionReference::new("test.start", json!({ "id": 9 })),
        }]);

        assert_eq!(
            first_action(&mappings, &test_event(vec![])),
            Some(&ActionReference::new("test.start", json!({ "id": 9 })))
        );
    }

    /// Builds a button mapping that reports `1` as pressed and `0` as released.
    fn button_mapping(id: u128, behavior: ControlBehavior, action: &str) -> OscMapping {
        OscMapping {
            id: Uuid::from_u128(id),
            source: None,
            address: "/exec/start".to_string(),
            arg_index: Some(0),
            arg_value: Some("1".to_string()),
            release_value: Some("0".to_string()),
            range: None,
            behavior,
            action: ActionReference::new(action, json!({})),
        }
    }

    /// Verifies pressed and released values turn matching messages into button edges.
    #[test]
    fn release_values_report_button_edges() {
        let mapping = button_mapping(1, ControlBehavior::Press, "test.hold");

        assert_eq!(
            mapping.signal(&test_event(vec![OscType::Int(1)])),
            SourceSignal::Button(true)
        );
        assert_eq!(
            mapping.signal(&test_event(vec![OscType::Int(0)])),
            SourceSignal::Button(false)
        );
        assert!(mapping.reports_release());
        assert!(mapping.can_drive(ActionInputKind::Absolute));
        let pulse_only = OscMapping {
            release_value: None,
            ..mapping
        };
        assert!(!pulse_only.reports_release());
        assert!(!pulse_only.can_drive(ActionInputKind::Absolute));
        assert!(pulse_only.can_drive(ActionInputKind::Trigger));
    }

    /// Verifies a button keeps press and release trigger bindings side by side.
    #[test]
    fn press_and_release_bindings_share_a_button() {
        let triggers = |_: &ActionReference| Some(ActionInputKind::Trigger);
        let mut mappings = OscMappings::new();
        mappings.upsert(
            button_mapping(1, ControlBehavior::Press, "test.start"),
            triggers,
        );
        let displaced = mappings.upsert(
            button_mapping(2, ControlBehavior::Release, "test.stop"),
            triggers,
        );

        assert!(displaced.is_empty());
        let actions = mappings
            .lookup(&test_event(vec![OscType::Int(0)]))
            .map(|mapping| mapping.action.id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(actions, vec!["test.start", "test.stop"]);
    }
}
