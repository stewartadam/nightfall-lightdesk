// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::{fmt::Display, ops::Deref};

use serde::{Deserialize, Serialize};
use smart_default::SmartDefault;
use uuid::Uuid;

use crate::command_types::SpatialSelection;

#[derive(Default, Debug, Copy, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
/// Priority indicator, where lower priority values are first and higher priorities are last.
pub struct Priority(pub i8);
impl Deref for Priority {
    type Target = i8;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl Display for Priority {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// Stable identity fields shared by persisted showfile objects.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, SmartDefault)]
#[typeshare::typeshare]
pub struct Identifiers {
    pub id: u32,
    #[serde(with = "crate::serde_uuid_simple")]
    #[default(_code = "Uuid::new_v4()")]
    #[typeshare(serialized_as = "String")]
    pub uid: Uuid,
    pub label: String,
}

pub trait HasIdentifiers {
    fn identifiers(&self) -> &Identifiers;

    /// Whether this type requires globally unique IDs within the data store.
    /// Returns true by default; override to false for types with scoped IDs (e.g., Cues).
    fn requires_unique_id() -> bool {
        true
    }
}

/// Cross-object references stored by an object that depends on palettes or effects.
#[derive(Default, Debug, Clone, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct References {
    palettes: Vec<Uuid>,
    fx: Vec<Uuid>,
}

/// Definition of a selection group that stores a selection for later recall
#[derive(Default, Debug, Clone, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct Group {
    /// Identifiers for the group
    pub identifiers: Identifiers,
    /// The stored spatial selection
    pub selection: SpatialSelection,
    /// Optional description for the group
    pub description: String,
}

impl HasIdentifiers for Group {
    fn identifiers(&self) -> &Identifiers {
        &self.identifiers
    }
}

/// Reference to either a whole fixture or a specific indexed element within it.
#[derive(Default, Debug, Clone, Eq, Hash, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct FixtureRef {
    #[serde(with = "crate::serde_uuid_simple")]
    pub fixture_uid: Uuid,
    pub index: Option<u32>,
}

impl Display for FixtureRef {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if let Some(index) = self.index {
            write!(f, "{}.{}", self.fixture_uid, index)
        } else {
            write!(f, "{}", self.fixture_uid)
        }
    }
}

impl PartialOrd for FixtureRef {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for FixtureRef {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        let fixture_id_cmp = self.fixture_uid.cmp(&other.fixture_uid);
        if fixture_id_cmp != std::cmp::Ordering::Equal {
            return fixture_id_cmp;
        }

        self.index
            .cmp(&other.index)
            .then_with(|| std::cmp::Ordering::Equal)
    }
}
