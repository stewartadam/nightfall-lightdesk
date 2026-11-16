// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::ops::RangeInclusive;

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

    /// Return the IDs of the fixtures numbered within `range`, in ascending order.
    ///
    /// Range selections walk these instead of every number in the range, so a range far wider
    /// than the rig, such as `1 thru 4000000000`, costs no more than the rig itself.
    fn fixture_ids_in(&self, range: RangeInclusive<u32>) -> Vec<u32>;

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

    /// Return the IDs of the groups numbered within `range`, in ascending order.
    ///
    /// Group ranges walk these instead of every number in the range, like
    /// [`Self::fixture_ids_in`]. Sources without groups return an empty list.
    fn group_ids_in(&self, range: RangeInclusive<u32>) -> Vec<u32>;
}

/// Return the IDs within `range` from a lookup that can test single IDs and list all of them.
///
/// Probes each number of the range when it is no wider than the lookup holds, and otherwise
/// filters and sorts the listed IDs, so the cost is bounded by the smaller of the two.
pub fn ids_in_range<I>(
    range: RangeInclusive<u32>,
    id_count: usize,
    contains: impl Fn(u32) -> bool,
    all_ids: impl FnOnce() -> I,
) -> Vec<u32>
where
    I: IntoIterator<Item = u32>,
{
    let (start, end) = (*range.start(), *range.end());
    if start > end {
        return Vec::new();
    }
    let span = u64::from(end) - u64::from(start) + 1;
    if span <= id_count as u64 {
        return range.filter(|id| contains(*id)).collect();
    }
    let mut ids = all_ids()
        .into_iter()
        .filter(|id| range.contains(id))
        .collect::<Vec<_>>();
    ids.sort_unstable();
    ids.dedup();
    ids
}

/// Behavior exposed by selection resolvers, independent of their storage owner.
pub trait SpatialSelectionResolution {
    /// Collapse element refs that cover every element in a fixture into one whole-fixture ref.
    fn collapse_complete_fixture_element_sets(&self, fixtures: Vec<FixtureRef>) -> Vec<FixtureRef>;

    /// Resolve a spatial selection into canonical fixture refs and projection metadata.
    fn resolve(&self, selection: &SpatialSelection) -> PartialResult<ResolvedSelection>;
}
