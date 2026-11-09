// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! The set of parked fixture parameters and the value each one is held at.

use std::collections::BTreeMap;

use bevy_ecs::prelude::*;
use nightfall::prelude::FixtureRef;
use nightfall_dmx::prelude::{Attribute, ParameterDmxValue};
use serde::{Deserialize, Serialize};

/// Identifies one parameter of a patched fixture by its element and attribute.
///
/// Fixture UIDs survive renumbering and show reloads, so a key keeps naming the same parameter
/// until the fixture is deleted.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct ParameterKey {
    /// Fixture element owning the parameter. The index is always set.
    pub element: FixtureRef,
    /// Attribute of the parameter on that element.
    pub attribute: Attribute,
}

/// One parked parameter and the logical value it is held at, as saved in showfiles and sent to
/// clients.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct ParkedParameter {
    /// Fixture element owning the parked parameter. The index is always set.
    pub element: FixtureRef,
    /// Attribute of the parked parameter on that element.
    pub attribute: Attribute,
    /// Logical value output while parked, in the same space as the parameter's layer values.
    pub value: ParameterDmxValue,
}

/// Every parked parameter, show-wide.
///
/// A parked parameter outputs its parked value whatever playbacks, the programmer, masters or
/// virtual dimmers do, until it is unparked. Release and clear leave it parked.
#[derive(Resource, Debug, Clone, Default, PartialEq)]
pub struct ParkedParameters {
    entries: BTreeMap<ParameterKey, ParameterDmxValue>,
}

impl ParkedParameters {
    /// Builds the set from saved or captured entries. A later entry for the same parameter
    /// replaces an earlier one.
    pub fn from_entries(entries: impl IntoIterator<Item = ParkedParameter>) -> Self {
        Self {
            entries: entries
                .into_iter()
                .map(|entry| {
                    let key = ParameterKey {
                        element: entry.element,
                        attribute: entry.attribute,
                    };
                    (key, entry.value)
                })
                .collect(),
        }
    }

    /// Returns every parked parameter, ordered by fixture, element and attribute.
    pub fn entries(&self) -> Vec<ParkedParameter> {
        self.entries
            .iter()
            .map(|(key, value)| ParkedParameter {
                element: key.element.clone(),
                attribute: key.attribute.clone(),
                value: *value,
            })
            .collect()
    }

    /// Iterates the parked parameters and their values in key order.
    pub fn iter(&self) -> impl Iterator<Item = (&ParameterKey, ParameterDmxValue)> {
        self.entries.iter().map(|(key, value)| (key, *value))
    }

    /// Returns the value a parameter is parked at, or `None` when it is not parked.
    pub fn value(&self, key: &ParameterKey) -> Option<ParameterDmxValue> {
        self.entries.get(key).copied()
    }

    /// Returns whether no parameter is parked.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Returns how many parameters are parked.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Parks a parameter at `value`, replacing the value of one already parked.
    pub fn park(&mut self, key: ParameterKey, value: ParameterDmxValue) {
        self.entries.insert(key, value);
    }

    /// Unparks a parameter, returning whether it was parked.
    pub fn unpark(&mut self, key: &ParameterKey) -> bool {
        self.entries.remove(key).is_some()
    }

    /// Unparks every parameter.
    pub fn clear(&mut self) {
        self.entries.clear();
    }
}

#[cfg(test)]
mod tests {
    use uuid::Uuid;

    use super::*;

    /// Builds a key for element 1 of a fixture.
    fn key(fixture_uid: Uuid, attribute: Attribute) -> ParameterKey {
        ParameterKey {
            element: FixtureRef {
                fixture_uid,
                index: Some(1),
            },
            attribute,
        }
    }

    /// Parking twice keeps the latest value, and unparking reports whether anything was parked.
    #[test]
    fn park_replaces_value_and_unpark_reports_presence() {
        let fixture = Uuid::new_v4();
        let mut parked = ParkedParameters::default();
        parked.park(key(fixture, Attribute::Red), 10.0);
        parked.park(key(fixture, Attribute::Red), 20.0);
        assert_eq!(parked.value(&key(fixture, Attribute::Red)), Some(20.0));
        assert_eq!(parked.len(), 1);
        assert!(parked.unpark(&key(fixture, Attribute::Red)));
        assert!(!parked.unpark(&key(fixture, Attribute::Red)));
        assert!(parked.is_empty());
    }

    /// Entries serialize with their element, attribute and value, and round-trip through
    /// `from_entries`.
    #[test]
    fn entries_round_trip_through_serialization() {
        let fixture = Uuid::new_v4();
        let mut parked = ParkedParameters::default();
        parked.park(key(fixture, Attribute::Pan), 127.5);
        parked.park(key(fixture, Attribute::Intensity), 0.0);
        let json = serde_json::to_value(parked.entries()).expect("entries serialize");
        assert!(json[0].get("element").is_some());
        assert!(json[0].get("value").is_some());
        let restored: Vec<ParkedParameter> =
            serde_json::from_value(json).expect("entries deserialize");
        assert_eq!(ParkedParameters::from_entries(restored), parked);
    }
}
