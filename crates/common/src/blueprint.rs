// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Blueprint types for selection-less attribute value storage

use std::collections::HashMap;

use nightfall_dmx::prelude::{Attribute, AttributeCategory};
use serde::{Deserialize, Serialize};
use serde_with::serde_as;

use crate::data::{HasIdentifiers, Identifiers, References};
use crate::stores::InclusionSettings;
use crate::value_source::ValueSource;

/// Operator-facing address used to resolve a Blueprint at command execution time.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum BlueprintAddress {
    /// Resolve the Blueprint whose mutable numeric identifier matches exactly.
    Id(u32),
    /// Resolve a case-insensitive exact label, rejecting ambiguous matches.
    Label(String),
}

/// Logical portion of a Blueprint retained by a referenced application.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum BlueprintSelector {
    /// Apply every logical attribute currently contained by the Blueprint.
    All,
    /// Apply the single requested logical attribute.
    Attribute(Attribute),
    /// Apply every current Blueprint attribute in the requested category.
    Category(AttributeCategory),
}

/// Stable live relationship between a cue instruction and a Blueprint definition.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct BlueprintApplication {
    /// Stable identity of the referenced Blueprint.
    #[serde(with = "crate::serde_uuid_simple")]
    #[typeshare(serialized_as = "String")]
    pub blueprint_uid: uuid::Uuid,
    /// Logical attributes selected dynamically from the current definition.
    pub selector: BlueprintSelector,
}

/// Whether applying a Blueprint retains a live relationship or copies its current values.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub enum BlueprintResolution {
    /// Retain the Blueprint UUID and selector for future materialization.
    #[default]
    Reference,
    /// Resolve matching logical values when the command executes.
    Absolute,
}

/// Blueprint - selection-less attribute value storage
#[serde_as]
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct Blueprint {
    /// Identifiers for the blueprint
    pub identifiers: Identifiers,
    /// Logical values captured without fixture or selection identity.
    #[serde_as(as = "HashMap<serde_with::DisplayFromStr, _>")]
    #[typeshare(serialized_as = "Record<String, ValueSource>")]
    pub values: HashMap<Attribute, ValueSource>,
    /// Settings for including/excluding attributes
    pub inclusion_settings: InclusionSettings,
    /// References to other objects
    pub references: References,
}

impl HasIdentifiers for Blueprint {
    fn identifiers(&self) -> &Identifiers {
        &self.identifiers
    }
}

impl Blueprint {
    /// Returns the Blueprint's authored logical values independent of fixture parameters.
    pub fn logical_values(&self) -> HashMap<Attribute, ValueSource> {
        self.values.clone()
    }

    /// Resolves the current logical values selected by one Blueprint application.
    pub fn selected_values(&self, selector: &BlueprintSelector) -> HashMap<Attribute, ValueSource> {
        self.logical_values()
            .into_iter()
            .filter(|(attribute, _)| match selector {
                BlueprintSelector::All => true,
                BlueprintSelector::Attribute(selected) => attribute == selected,
                BlueprintSelector::Category(category) => attribute.category() == *category,
            })
            .collect()
    }
}
