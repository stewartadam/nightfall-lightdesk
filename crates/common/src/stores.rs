// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use nightfall_dmx::prelude::*;
use serde::{Deserialize, Serialize};

/// Controls whether a store keeps references to source objects or captures copies.
#[derive(Clone, Copy, Default, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[typeshare::typeshare]
pub enum InclusionMode {
    REFERENCE,
    #[default]
    COPY,
}

/// Predicate used to include or exclude fixtures from a store.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum FilterType {
    FixtureType { make: String, model: String },
    AttributeCategory { category: AttributeCategory },
    Attribute { attribute: Attribute },
}

/// Inclusion and exclusion rules that decide which fixtures belong to a store.
#[derive(Clone, Default, Debug, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct InclusionSettings {
    pub inclusion_mode: InclusionMode,
    pub inclusion_filters: Vec<FilterType>,
    pub exclusion_filters: Vec<FilterType>,
}
