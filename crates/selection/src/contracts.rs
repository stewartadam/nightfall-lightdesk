// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use nightfall::prelude::*;

/// Minimal fixture metadata needed by pure selection resolution.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SelectionFixture {
    /// Stable fixture reference using the fixture UID.
    pub fixture_ref: FixtureRef,
    /// Number of controllable elements in the fixture.
    pub element_count: u32,
}

/// Minimal group metadata needed by pure selection resolution.
#[derive(Debug, Clone, PartialEq)]
pub struct SelectionGroup {
    /// Stable group object UID.
    pub uid: uuid::Uuid,
    /// User-facing numeric group ID.
    pub id: u32,
    /// User-facing group label.
    pub label: String,
    /// Stored group selection.
    pub selection: SpatialSelection,
}

/// Read-only lookup contract for resolving selection expressions.
///
/// Fixture storage and group storage are owned outside `nightfall-selection`; this
/// trait is the narrow read model needed by the pure selection algorithms.
pub trait SelectionDataSource {
    /// Look up a fixture by user-facing numeric ID.
    fn fixture_by_id(&self, fixture_id: u32) -> Option<SelectionFixture>;

    /// Look up a fixture by an already-resolved fixture reference.
    fn fixture_by_ref(&self, fixture_ref: &FixtureRef) -> Option<SelectionFixture>;

    /// Return whether group lookup is available for this resolution context.
    fn groups_available(&self) -> bool {
        false
    }

    /// Look up a group by stable UID.
    fn group_by_uid(&self, _uid: uuid::Uuid) -> Option<SelectionGroup> {
        None
    }

    /// Look up a group by user-facing numeric ID.
    fn group_by_id(&self, _group_id: u32) -> Option<SelectionGroup> {
        None
    }

    /// Look up a group by exact label match.
    fn group_by_label(&self, _label: &str) -> Option<SelectionGroup> {
        None
    }
}

/// Behavior exposed by selection resolvers, independent of their storage owner.
pub trait SpatialSelectionResolution {
    /// Collapse element refs that cover every element in a fixture into one whole-fixture ref.
    fn collapse_complete_fixture_element_sets(&self, fixtures: Vec<FixtureRef>) -> Vec<FixtureRef>;

    /// Resolve a spatial selection into canonical fixture refs and projection metadata.
    fn resolve(&self, selection: &SpatialSelection) -> PartialResult<ResolvedSelection>;
}
