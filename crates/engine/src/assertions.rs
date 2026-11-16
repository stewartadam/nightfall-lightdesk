// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Attribute values and timing asserted on fixtures, shared by every domain that stores them.
//!
//! The programmer and cues hold the same shape of content: values for attributes, optional
//! transitions, and an optional live blueprint reference. Bound to a selection, that content
//! says what a set of fixtures should do.

use std::collections::HashMap;

use nightfall::prelude::*;
use nightfall_dmx::prelude::Attribute;
use nightfall_selection::{
    SelectionValidatedEntity, SpatialSelectionResolution, selection_validation_warnings,
};
use partially::Partial;
use serde::{Deserialize, Serialize};
use serde_with::DisplayFromStr;

/// Attribute values and transitions asserted on fixtures, without a selection.
///
/// Held by programmer instructions and by cue and cue part instructions.
#[serde_with::serde_as]
#[derive(Default, Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct AssertionSet {
    /// The values for each attribute
    #[serde_as(as = "HashMap<DisplayFromStr, _>")]
    #[typeshare(serialized_as = "Record<String, ValueSource>")]
    pub values: HashMap<Attribute, ValueSource>,
    /// Optional live Blueprint operation occupying this set's authoring position.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blueprint_application: Option<BlueprintApplication>,
    /// Per-attribute transitions that override the set-wide transitions
    #[serde_as(as = "HashMap<DisplayFromStr, _>")]
    #[typeshare(serialized_as = "Record<String, PartialTransition>")]
    pub transitions_by_attribute: AttributeTransitions,
    /// Per-fixture, per-attribute transitions that override set-wide and
    /// attribute-wide transitions.
    #[serde(default)]
    pub transitions_by_fixture_attribute: Vec<FixtureAttributeTransition>,
    /// Optional color path applied to logical color transitions in this set.
    #[serde(default)]
    pub color_path_id: Option<ColorPathId>,
    /// Default transition that applies to all attributes
    pub transitions: PartialTransition,
}

/// Per-fixture transition overrides grouped by attribute.
#[serde_with::serde_as]
#[derive(Default, Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct FixtureAttributeTransition {
    /// Fixture or fixture element this override applies to.
    pub fixture: FixtureRef,
    /// Attribute-specific transition overrides for this fixture ref.
    #[serde_as(as = "HashMap<DisplayFromStr, _>")]
    #[typeshare(serialized_as = "Record<String, PartialTransition>")]
    pub transitions_by_attribute: AttributeTransitions,
}

impl AssertionSet {
    /// Reports whether this set dynamically references the Blueprint.
    pub fn references_blueprint(&self, uid: uuid::Uuid) -> bool {
        self.blueprint_application
            .as_ref()
            .is_some_and(|application| application.blueprint_uid == uid)
    }

    /// Merges another set into this one.
    ///
    /// Values from `other` replace values for the same attribute. Transitions merge field by
    /// field, so a transition field `other` leaves unset keeps its current value. A blueprint
    /// reference or color path in `other` replaces the current one.
    pub fn merge(&mut self, other: AssertionSet) {
        self.values.extend(other.values);
        if other.blueprint_application.is_some() {
            self.blueprint_application = other.blueprint_application;
        }
        self.transitions.apply_some(other.transitions);
        for (key, value) in other.transitions_by_attribute {
            self.transitions_by_attribute
                .entry(key)
                .and_modify(|e| {
                    e.apply_some(value.clone());
                })
                .or_insert(value);
        }
        for other_fixture_transition in other.transitions_by_fixture_attribute {
            if let Some(existing) = self
                .transitions_by_fixture_attribute
                .iter_mut()
                .find(|entry| entry.fixture == other_fixture_transition.fixture)
            {
                for (key, value) in other_fixture_transition.transitions_by_attribute {
                    existing
                        .transitions_by_attribute
                        .entry(key)
                        .and_modify(|entry| {
                            entry.apply_some(value.clone());
                        })
                        .or_insert(value);
                }
            } else {
                self.transitions_by_fixture_attribute
                    .push(other_fixture_transition);
            }
        }
        if other.color_path_id.is_some() {
            self.color_path_id = other.color_path_id;
        }
    }
}

/// An [`AssertionSet`] bound to the fixtures it applies to.
#[derive(Default, Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct BoundAssertionSet {
    /// The spatial selection the assertions apply to
    pub selection: SpatialSelection,
    /// The values and transitions asserted on the selection
    pub assertions: AssertionSet,
}

impl SelectionValidatedEntity for BoundAssertionSet {
    /// Return validation warnings for this set's selection.
    fn selection_validation_warnings(
        &self,
        resolver: &dyn SpatialSelectionResolution,
    ) -> Vec<String> {
        selection_validation_warnings(&self.selection, resolver)
    }
}
