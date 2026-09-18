// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use nightfall::prelude::*;

use crate::contracts::{SelectionDataSource, SpatialSelectionResolution};

pub(super) const MISSING_FIXTURE_REFERENCES_WARNING: &str =
    "Some fixtures referenced were not found.";
pub(super) const MISSING_FIXTURE_ELEMENTS_WARNING: &str =
    "Some fixture elements referenced were not found.";

/// Entity hook for surfacing stale or otherwise invalid stored selections.
pub trait SelectionValidatedEntity {
    /// Return validation warnings for every stored selection owned by this entity.
    fn selection_validation_warnings(
        &self,
        resolver: &dyn SpatialSelectionResolution,
    ) -> Vec<String>;
}

impl SelectionValidatedEntity for Group {
    /// Return validation warnings for the group's stored selection.
    fn selection_validation_warnings(
        &self,
        resolver: &dyn SpatialSelectionResolution,
    ) -> Vec<String> {
        selection_validation_warnings(&self.selection, resolver)
    }
}

/// Return resolver warnings for a stored spatial selection without discarding context.
pub fn selection_validation_warnings(
    selection: &SpatialSelection,
    resolver: &dyn SpatialSelectionResolution,
) -> Vec<String> {
    resolver.resolve(selection).issues
}

/// Return a copy of a resolved selection with stale fixture references removed.
pub fn filter_existing_selection(
    selection: &ResolvedSelection,
    data_source: &dyn SelectionDataSource,
) -> ResolvedSelection {
    let canonical = selection
        .canonical_fixtures()
        .iter()
        .filter(|fixture_ref| fixture_ref_exists(fixture_ref, data_source))
        .cloned()
        .collect();
    let indexes: Vec<SelectionIndex> = selection
        .indexes()
        .iter()
        .filter_map(|selection_index| {
            let members: Vec<_> = selection_index
                .members
                .iter()
                .filter(|member| fixture_ref_exists(&member.fixture, data_source))
                .cloned()
                .collect();

            (!members.is_empty()).then_some((selection_index.invert, members))
        })
        .enumerate()
        .map(|(index, (invert, members))| SelectionIndex {
            index: index as u32,
            invert,
            members: members
                .into_iter()
                .map(|mut member| {
                    member.projected_coord.x = index as i32;
                    member
                })
                .collect(),
        })
        .collect();

    let invert_attrs = selection.invert_attrs().map(Vec::from);
    if indexes.is_empty() {
        return ResolvedSelection::new(canonical, indexes, invert_attrs);
    }
    let max_x = indexes.len().saturating_sub(1) as i32;

    match selection.projection_bounds() {
        Some(bounds) => ResolvedSelection::with_projection_bounds(
            canonical,
            indexes,
            ProjectionBounds::new(
                0,
                max_x,
                bounds.min_y,
                bounds.max_y,
                bounds.min_z,
                bounds.max_z,
            ),
            invert_attrs,
        ),
        None => ResolvedSelection::new(canonical, indexes, invert_attrs),
    }
}

/// Return whether a fixture reference points at a live fixture and element.
fn fixture_ref_exists(fixture_ref: &FixtureRef, data_source: &dyn SelectionDataSource) -> bool {
    let Some(fixture) = data_source.fixture_by_ref(fixture_ref) else {
        return false;
    };

    match fixture_ref.index {
        Some(index) => index > 0 && index <= fixture.element_count,
        None => true,
    }
}

/// Append a compact warning for one or more missing fixture IDs.
pub(super) fn push_missing_fixture_warning(missing_ids: &[u32], warnings: &mut Vec<String>) {
    match missing_ids {
        [] => {}
        [fixture_id] => warnings.push(format!("Could not find fixture {}", fixture_id)),
        _ => warnings.push(format!(
            "Could not find fixtures {}",
            format_fixture_id_ranges(missing_ids)
        )),
    }
}

/// Append the aggregate warning for missing element indexes once per resolution.
pub(super) fn push_missing_fixture_elements_warning(warnings: &mut Vec<String>) {
    if !warnings
        .iter()
        .any(|warning| warning == MISSING_FIXTURE_ELEMENTS_WARNING)
    {
        warnings.push(MISSING_FIXTURE_ELEMENTS_WARNING.to_string());
    }
}

/// Format fixture IDs as ascending singleton and contiguous range segments.
fn format_fixture_id_ranges(fixture_ids: &[u32]) -> String {
    let mut sorted_ids = fixture_ids.to_vec();
    sorted_ids.sort_unstable();
    sorted_ids.dedup();

    let mut ranges = Vec::new();
    let mut range_start = sorted_ids[0];
    let mut previous = sorted_ids[0];

    for fixture_id in sorted_ids.into_iter().skip(1) {
        if previous.checked_add(1) == Some(fixture_id) {
            previous = fixture_id;
            continue;
        }

        ranges.push(format_fixture_id_range(range_start, previous));
        range_start = fixture_id;
        previous = fixture_id;
    }

    ranges.push(format_fixture_id_range(range_start, previous));
    ranges.join(", ")
}

/// Format one missing fixture ID segment as either a singleton or inclusive range.
fn format_fixture_id_range(start: u32, end: u32) -> String {
    if start == end {
        start.to_string()
    } else {
        format!("{}-{}", start, end)
    }
}
