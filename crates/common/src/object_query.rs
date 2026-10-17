// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Stored filters that select showfile objects of one type by their identifiers.

use serde::{Deserialize, Serialize};

use crate::{command_types::ObjectType, data::Identifiers};

/// Inclusive range of user-facing object IDs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct ObjectIdRange {
    /// Lowest matching ID.
    pub first: u32,
    /// Highest matching ID.
    pub last: u32,
}

impl ObjectIdRange {
    /// Returns whether `id` falls inside the range, accepting bounds given in either order.
    pub fn contains(&self, id: u32) -> bool {
        let (low, high) = if self.first <= self.last {
            (self.first, self.last)
        } else {
            (self.last, self.first)
        };
        (low..=high).contains(&id)
    }
}

/// Live filter over the objects of one type, stored instead of a resolved object list.
///
/// Consumers keep the query and re-evaluate it as objects are created, renumbered, renamed
/// or deleted, so the matching set never goes stale.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct ObjectQuery {
    /// Object namespace the query selects from.
    pub object_type: ObjectType,
    /// Optional inclusive ID range; `None` accepts every ID.
    #[serde(default)]
    pub id_range: Option<ObjectIdRange>,
    /// Optional case-insensitive substring the label must contain; empty accepts every label.
    #[serde(default)]
    pub label_contains: Option<String>,
}

impl ObjectQuery {
    /// Creates a query that matches every object of `object_type`.
    pub fn all(object_type: ObjectType) -> Self {
        Self {
            object_type,
            id_range: None,
            label_contains: None,
        }
    }

    /// Returns whether an object of the query's type with these identifiers matches.
    pub fn matches(&self, identifiers: &Identifiers) -> bool {
        let id_matches = self
            .id_range
            .is_none_or(|range| range.contains(identifiers.id));
        let label_matches = self
            .label_contains
            .as_deref()
            .map(str::trim)
            .filter(|needle| !needle.is_empty())
            .is_none_or(|needle| {
                identifiers
                    .label
                    .to_lowercase()
                    .contains(&needle.to_lowercase())
            });
        id_matches && label_matches
    }

    /// Filters identified objects to the matching ones, ordered by ascending ID.
    pub fn select<'a, T>(
        &self,
        objects: impl IntoIterator<Item = &'a T>,
        identifiers: impl Fn(&T) -> &Identifiers,
    ) -> Vec<&'a T>
    where
        T: 'a,
    {
        let mut matches: Vec<&T> = objects
            .into_iter()
            .filter(|object| self.matches(identifiers(object)))
            .collect();
        matches.sort_by_key(|object| identifiers(object).id);
        matches
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds identifiers with a fixed ID and label for query tests.
    fn identifiers(id: u32, label: &str) -> Identifiers {
        Identifiers {
            id,
            label: label.to_string(),
            ..Default::default()
        }
    }

    /// An empty query accepts every object of its type.
    #[test]
    fn empty_query_matches_everything() {
        let query = ObjectQuery::all(ObjectType::Blueprint);
        assert!(query.matches(&identifiers(1, "Red")));
        assert!(query.matches(&identifiers(900, "")));
    }

    /// ID ranges are inclusive and tolerate reversed bounds.
    #[test]
    fn id_range_is_inclusive_in_either_order() {
        let query = ObjectQuery {
            id_range: Some(ObjectIdRange {
                first: 20,
                last: 10,
            }),
            ..ObjectQuery::all(ObjectType::Clip)
        };
        assert!(query.matches(&identifiers(10, "")));
        assert!(query.matches(&identifiers(20, "")));
        assert!(!query.matches(&identifiers(21, "")));
    }

    /// Label filters match case-insensitive substrings and ignore blank filters.
    #[test]
    fn label_filter_is_case_insensitive_substring() {
        let query = ObjectQuery {
            label_contains: Some("col".to_string()),
            ..ObjectQuery::all(ObjectType::Blueprint)
        };
        assert!(query.matches(&identifiers(1, "Front COLOR")));
        assert!(!query.matches(&identifiers(2, "Position")));

        let blank = ObjectQuery {
            label_contains: Some("  ".to_string()),
            ..ObjectQuery::all(ObjectType::Blueprint)
        };
        assert!(blank.matches(&identifiers(2, "Position")));
    }

    /// Selection keeps only matches and orders them by ascending ID.
    #[test]
    fn select_orders_matches_by_id() {
        let objects = [
            identifiers(3, "Blue"),
            identifiers(1, "Red"),
            identifiers(2, "Pos"),
        ];
        let query = ObjectQuery {
            id_range: Some(ObjectIdRange { first: 1, last: 3 }),
            label_contains: Some("e".to_string()),
            ..ObjectQuery::all(ObjectType::Blueprint)
        };
        let selected: Vec<u32> = query
            .select(objects.iter(), |object| object)
            .into_iter()
            .map(|object| object.id)
            .collect();
        assert_eq!(selected, vec![1, 3]);
    }
}
