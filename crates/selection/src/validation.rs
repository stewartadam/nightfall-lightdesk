// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::ops::RangeInclusive;

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

/// Append one compact warning for the fixture IDs in `missing`, such as `Could not find
/// fixtures 2-4, 9`.
pub(super) fn push_missing_fixture_warning(
    missing: &[RangeInclusive<u32>],
    warnings: &mut Vec<String>,
) {
    push_missing_ids_warning("fixture", missing, warnings);
}

/// Append one compact warning for the group IDs in `missing`, such as `Could not find group 7`.
pub(super) fn push_missing_group_warning(
    missing: &[RangeInclusive<u32>],
    warnings: &mut Vec<String>,
) {
    push_missing_ids_warning("group", missing, warnings);
}

/// Append one warning naming the element indexes in `missing` that a fixture with
/// `element_count` elements does not have.
pub(super) fn push_missing_element_warning(
    fixture_id: u32,
    element_count: u32,
    missing: &[RangeInclusive<u32>],
    warnings: &mut Vec<String>,
) {
    match missing {
        [] => {}
        [run] if run.start() == run.end() => warnings.push(format!(
            "Fixture {fixture_id} element {} does not exist (fixture has {element_count} elements)",
            run.start()
        )),
        _ => warnings.push(format!(
            "Fixture {fixture_id} elements {} do not exist (fixture has {element_count} elements)",
            format_id_runs(missing)
        )),
    }
}

/// Return the indexes of `elements` that fall outside `1..=element_count`, as at most two runs.
pub(crate) fn missing_element_runs(
    elements: RangeInclusive<u32>,
    element_count: u32,
) -> Vec<RangeInclusive<u32>> {
    let (start, end) = (*elements.start(), *elements.end());
    if start > end {
        return Vec::new();
    }
    let mut runs = Vec::new();
    if start == 0 {
        runs.push(0..=0);
    }
    let first_missing_above = start.max(element_count.saturating_add(1)).max(1);
    if end >= first_missing_above && end > element_count {
        runs.push(first_missing_above..=end);
    }
    runs
}

/// Append one warning naming every ID in `missing`, using the singular `noun` for one ID.
fn push_missing_ids_warning(
    noun: &str,
    missing: &[RangeInclusive<u32>],
    warnings: &mut Vec<String>,
) {
    match missing {
        [] => {}
        [run] if run.start() == run.end() => {
            warnings.push(format!("Could not find {noun} {}", run.start()));
        }
        _ => warnings.push(format!(
            "Could not find {noun}s {}",
            format_id_runs(missing)
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

/// Return the runs of `range` that `present` does not cover, in ascending order.
///
/// `present` must be ascending and inside `range`, as [`SelectionDataSource::fixture_ids_in`]
/// returns it. The result has at most one more run than `present` has IDs, however wide the
/// range is.
pub(crate) fn missing_id_runs(
    range: RangeInclusive<u32>,
    present: &[u32],
) -> Vec<RangeInclusive<u32>> {
    let (start, end) = (*range.start(), *range.end());
    if start > end {
        return Vec::new();
    }
    let mut runs = Vec::new();
    let mut next = Some(start);
    for &id in present {
        if let Some(from) = next
            && from < id
        {
            runs.push(from..=id - 1);
        }
        next = id.checked_add(1);
    }
    if let Some(from) = next
        && from <= end
    {
        runs.push(from..=end);
    }
    runs
}

/// Format ID runs as comma-separated singletons and inclusive `start-end` ranges.
pub(crate) fn format_id_runs(runs: &[RangeInclusive<u32>]) -> String {
    runs.iter()
        .map(|run| {
            if run.start() == run.end() {
                run.start().to_string()
            } else {
                format!("{}-{}", run.start(), run.end())
            }
        })
        .collect::<Vec<_>>()
        .join(", ")
}
