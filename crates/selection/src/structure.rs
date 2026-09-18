// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::collections::HashSet;

use nightfall::prelude::*;
use uuid::Uuid;

use crate::contracts::{SelectionDataSource, SelectionGroup};
use crate::linear::SelectionResolver;
use crate::validation::{
    MISSING_FIXTURE_REFERENCES_WARNING, push_missing_fixture_elements_warning,
};

/// A selection item before user-facing containers are lowered to fixture refs.
#[derive(Debug, Clone, PartialEq)]
pub(super) enum SelectionStructureItem {
    Fixture(FixtureRef),
    Group(SelectionGroup),
}

/// A top-level selection bucket before final fixture resolution.
pub(super) type SelectionStructureBucket = Vec<SelectionStructureItem>;

impl SelectionResolver<'_> {
    /// Resolve a selection expression into structural buckets before lowering containers.
    pub(super) fn resolve_structure_buckets(
        expr: &SelectionExpr,
        data_source: &dyn SelectionDataSource,
        visited_groups: &mut HashSet<Uuid>,
        warnings: &mut Vec<String>,
    ) -> Vec<SelectionStructureBucket> {
        match expr {
            SelectionExpr::Fixture(tgt) => Self::fixture_structure_buckets(
                Self::resolve_target(tgt, data_source, warnings)
                    .into_iter()
                    .map(SelectionStructureItem::Fixture)
                    .collect(),
            ),
            SelectionExpr::FixtureRange { start, end } => Self::fixture_structure_buckets(
                Self::resolve_range(start, end, data_source, warnings)
                    .into_iter()
                    .map(SelectionStructureItem::Fixture)
                    .collect(),
            ),
            SelectionExpr::FixtureMap { fixtures, elements } => Self::fixture_structure_buckets(
                Self::resolve_fixture_map(fixtures, elements, data_source, warnings)
                    .into_iter()
                    .map(SelectionStructureItem::Fixture)
                    .collect(),
            ),
            SelectionExpr::Group(group_ref_expr) => Self::single_structure_bucket(
                Self::resolve_group_items(group_ref_expr, data_source, warnings)
                    .into_iter()
                    .map(SelectionStructureItem::Group)
                    .collect(),
            ),
            SelectionExpr::Add { lhs, rhs } => {
                let mut buckets =
                    Self::resolve_structure_buckets(lhs, data_source, visited_groups, warnings);
                buckets.extend(Self::resolve_structure_buckets(
                    rhs,
                    data_source,
                    visited_groups,
                    warnings,
                ));
                buckets
            }
            SelectionExpr::Sub { lhs, rhs } => {
                let remove = Self::resolve(rhs, data_source, visited_groups, warnings);
                Self::resolve_structure_buckets(lhs, data_source, visited_groups, warnings)
                    .into_iter()
                    .filter_map(|bucket| {
                        let retained = bucket
                            .into_iter()
                            .flat_map(|item| match item {
                                SelectionStructureItem::Fixture(fixture) => {
                                    if remove.contains(&fixture) {
                                        Vec::new()
                                    } else {
                                        vec![SelectionStructureItem::Fixture(fixture)]
                                    }
                                }
                                SelectionStructureItem::Group(group) => {
                                    Self::resolve_group_structure_fixtures(
                                        &group,
                                        data_source,
                                        visited_groups,
                                        warnings,
                                    )
                                    .into_iter()
                                    .filter(|fixture| !remove.contains(fixture))
                                    .map(SelectionStructureItem::Fixture)
                                    .collect()
                                }
                            })
                            .collect::<Vec<_>>();
                        (!retained.is_empty()).then_some(retained)
                    })
                    .collect()
            }
            SelectionExpr::Span(inner) => {
                let merged =
                    Self::resolve_structure_buckets(inner, data_source, visited_groups, warnings)
                        .into_iter()
                        .flatten()
                        .collect::<Vec<_>>();
                Self::single_structure_bucket(merged)
            }
            SelectionExpr::Spatial(selection) => {
                let resolved = Self::resolve_spatial_to_resolved(
                    selection,
                    data_source,
                    visited_groups,
                    warnings,
                );
                resolved
                    .to_spanned_selection()
                    .spans()
                    .filter_map(|span| {
                        let bucket = span
                            .iter()
                            .cloned()
                            .map(SelectionStructureItem::Fixture)
                            .collect::<Vec<_>>();
                        (!bucket.is_empty()).then_some(bucket)
                    })
                    .collect()
            }
            SelectionExpr::Resolved(fixtures) => Self::fixture_structure_buckets(
                fixtures
                    .iter()
                    .cloned()
                    .map(SelectionStructureItem::Fixture)
                    .collect(),
            ),
        }
    }

    /// Return one structural bucket when it contains items.
    pub(super) fn single_structure_bucket(
        bucket: SelectionStructureBucket,
    ) -> Vec<SelectionStructureBucket> {
        if bucket.is_empty() {
            Vec::new()
        } else {
            vec![bucket]
        }
    }

    /// Return one structural bucket per fixture item for normal iterator-shaped selections.
    pub(super) fn fixture_structure_buckets(
        items: Vec<SelectionStructureItem>,
    ) -> Vec<SelectionStructureBucket> {
        items.into_iter().map(|item| vec![item]).collect()
    }

    /// Resolve group references to literal group items without expanding group selections.
    pub(super) fn resolve_group_items(
        group_ref_expr: &GroupRefExpr,
        data_source: &dyn SelectionDataSource,
        warnings: &mut Vec<String>,
    ) -> Vec<SelectionGroup> {
        if !data_source.groups_available() {
            warnings.push(
                "Group resolution attempted but group data provider not available".to_string(),
            );
            return Vec::new();
        }

        match group_ref_expr {
            GroupRefExpr::ByUid { uid } => match data_source.group_by_uid(*uid) {
                Some(group) => vec![group],
                None => {
                    warnings.push(format!("Could not find group {}", uid));
                    Vec::new()
                }
            },
            GroupRefExpr::ById(group_id) => match data_source.group_by_id(*group_id) {
                Some(group) => vec![group],
                None => {
                    warnings.push(format!("Could not find group {}", group_id));
                    Vec::new()
                }
            },
            GroupRefExpr::ByLabel(label) => match data_source.group_by_label(label) {
                Some(group) => vec![group],
                None => {
                    warnings.push(format!("Could not find group \"{}\"", label));
                    Vec::new()
                }
            },
            GroupRefExpr::RangeById { start, end } => {
                let (lower, upper) = if start <= end {
                    (*start, *end)
                } else {
                    (*end, *start)
                };
                let mut groups = (lower..=upper)
                    .filter_map(|group_id| match data_source.group_by_id(group_id) {
                        Some(group) => Some(group),
                        None => {
                            warnings.push(format!("Could not find group {}", group_id));
                            None
                        }
                    })
                    .collect::<Vec<_>>();
                if start > end {
                    groups.reverse();
                }
                groups
            }
            GroupRefExpr::MissingById(group_id) => {
                warnings.push(format!("Could not find group {}", group_id));
                Vec::new()
            }
            GroupRefExpr::MissingByLabel(label) => {
                warnings.push(format!("Could not find group \"{}\"", label));
                Vec::new()
            }
            GroupRefExpr::Add { lhs, rhs } => {
                let mut out = Self::resolve_group_items(lhs, data_source, warnings);
                out.extend(Self::resolve_group_items(rhs, data_source, warnings));
                out
            }
            GroupRefExpr::Sub { lhs, rhs } => {
                let mut out = Self::resolve_group_items(lhs, data_source, warnings);
                let remove = Self::resolve_group_items(rhs, data_source, warnings);
                out.retain(|group| !remove.iter().any(|remove| remove.uid == group.uid));
                out
            }
            GroupRefExpr::Span(inner) => Self::resolve_group_items(inner, data_source, warnings),
        }
    }

    /// Apply one leading structural transform to unresolved selection buckets.
    pub(super) fn apply_selection_structure_clause(
        buckets: Vec<SelectionStructureBucket>,
        clause: &SpatialClause,
        data_source: &dyn SelectionDataSource,
        visited_groups: &mut HashSet<Uuid>,
        warnings: &mut Vec<String>,
    ) -> Vec<SelectionStructureBucket> {
        match clause {
            SpatialClause::Split => buckets
                .into_iter()
                .flat_map(|bucket| bucket.into_iter().map(|item| vec![item]))
                .collect(),
            SpatialClause::Merge => {
                let merged = buckets.into_iter().flatten().collect::<Vec<_>>();
                if merged.is_empty() {
                    Vec::new()
                } else {
                    vec![merged]
                }
            }
            SpatialClause::Expand { depth } => Self::expand_structure_buckets(
                buckets,
                *depth,
                data_source,
                visited_groups,
                warnings,
            ),
            _ => buckets,
        }
    }

    /// Expand structural buckets by descending into groups and whole fixtures.
    pub(super) fn expand_structure_buckets(
        buckets: Vec<SelectionStructureBucket>,
        depth: Option<u32>,
        data_source: &dyn SelectionDataSource,
        visited_groups: &mut HashSet<Uuid>,
        warnings: &mut Vec<String>,
    ) -> Vec<SelectionStructureBucket> {
        if matches!(depth, Some(0)) {
            return buckets;
        }

        let mut expanded = Vec::with_capacity(buckets.len());
        for bucket in buckets {
            let mut expanded_bucket = Vec::new();
            for item in bucket {
                expanded_bucket.extend(Self::expand_structure_item(
                    item,
                    depth,
                    data_source,
                    visited_groups,
                    warnings,
                ));
            }
            if !expanded_bucket.is_empty() {
                expanded.push(expanded_bucket);
            }
        }
        expanded
    }

    /// Expand one structural item into child items for the current bucket.
    pub(super) fn expand_structure_item(
        item: SelectionStructureItem,
        depth: Option<u32>,
        data_source: &dyn SelectionDataSource,
        visited_groups: &mut HashSet<Uuid>,
        warnings: &mut Vec<String>,
    ) -> Vec<SelectionStructureItem> {
        match item {
            SelectionStructureItem::Fixture(fixture_ref) => {
                Self::expand_fixture_structure_item(fixture_ref, data_source, warnings)
            }
            SelectionStructureItem::Group(group) => {
                let child_buckets = Self::resolve_group_structure_buckets(
                    &group,
                    data_source,
                    visited_groups,
                    warnings,
                );
                match depth {
                    None => Self::expand_structure_buckets(
                        child_buckets,
                        None,
                        data_source,
                        visited_groups,
                        warnings,
                    )
                    .into_iter()
                    .flatten()
                    .collect(),
                    Some(remaining) if remaining > 1 => Self::expand_structure_buckets(
                        child_buckets,
                        Some(remaining - 1),
                        data_source,
                        visited_groups,
                        warnings,
                    )
                    .into_iter()
                    .flatten()
                    .collect(),
                    Some(_) => child_buckets.into_iter().flatten().collect(),
                }
            }
        }
    }

    /// Expand a whole fixture ref to its element refs, preserving explicit element refs.
    pub(super) fn expand_fixture_structure_item(
        fixture_ref: FixtureRef,
        data_source: &dyn SelectionDataSource,
        warnings: &mut Vec<String>,
    ) -> Vec<SelectionStructureItem> {
        let Some(fixture) = data_source.fixture_by_ref(&fixture_ref) else {
            if !warnings
                .iter()
                .any(|warning| warning == MISSING_FIXTURE_REFERENCES_WARNING)
            {
                warnings.push(MISSING_FIXTURE_REFERENCES_WARNING.to_string());
            }
            return vec![SelectionStructureItem::Fixture(fixture_ref)];
        };

        match fixture_ref.index {
            Some(index) if index > 0 && index <= fixture.element_count => {
                vec![SelectionStructureItem::Fixture(fixture_ref)]
            }
            Some(_) => {
                push_missing_fixture_elements_warning(warnings);
                Vec::new()
            }
            None => (1..=fixture.element_count)
                .map(|index| {
                    SelectionStructureItem::Fixture(FixtureRef {
                        fixture_uid: fixture_ref.fixture_uid,
                        index: Some(index),
                    })
                })
                .collect(),
        }
    }

    /// Resolve a stored group selection into structural buckets for expansion.
    pub(super) fn resolve_group_structure_buckets(
        group: &SelectionGroup,
        data_source: &dyn SelectionDataSource,
        visited_groups: &mut HashSet<Uuid>,
        warnings: &mut Vec<String>,
    ) -> Vec<SelectionStructureBucket> {
        if !data_source.groups_available() {
            warnings.push(
                "Group resolution attempted but group data provider not available".to_string(),
            );
            return Vec::new();
        }

        if visited_groups.contains(&group.uid) {
            warnings.push(format!("Circular reference detected in group {}", group.id));
            return Vec::new();
        }

        visited_groups.insert(group.uid);
        let resolved = Self::resolve_spatial_to_resolved(
            &group.selection,
            data_source,
            visited_groups,
            warnings,
        );
        visited_groups.remove(&group.uid);
        resolved
            .to_spanned_selection()
            .spans()
            .map(|span| {
                span.iter()
                    .cloned()
                    .map(SelectionStructureItem::Fixture)
                    .collect()
            })
            .collect()
    }

    /// Resolve a stored group selection into fixture refs while preserving its spatial pipeline.
    pub(super) fn resolve_group_structure_fixtures(
        group: &SelectionGroup,
        data_source: &dyn SelectionDataSource,
        visited_groups: &mut HashSet<Uuid>,
        warnings: &mut Vec<String>,
    ) -> Vec<FixtureRef> {
        Self::resolve_group_structure_buckets(group, data_source, visited_groups, warnings)
            .into_iter()
            .flatten()
            .filter_map(|item| match item {
                SelectionStructureItem::Fixture(fixture_ref) => Some(fixture_ref),
                SelectionStructureItem::Group(_) => None,
            })
            .collect()
    }

    /// Lower structural buckets to a fixture-only spanned selection for projection.
    pub(super) fn lower_structure_buckets(
        buckets: Vec<SelectionStructureBucket>,
        data_source: &dyn SelectionDataSource,
        visited_groups: &mut HashSet<Uuid>,
        warnings: &mut Vec<String>,
    ) -> SpannedSelection {
        let spans = buckets
            .into_iter()
            .filter_map(|bucket| {
                let fixtures = bucket
                    .into_iter()
                    .flat_map(|item| match item {
                        SelectionStructureItem::Fixture(fixture_ref) => vec![fixture_ref],
                        SelectionStructureItem::Group(group) => {
                            Self::resolve_group_structure_fixtures(
                                &group,
                                data_source,
                                visited_groups,
                                warnings,
                            )
                        }
                    })
                    .collect::<Vec<_>>();
                (!fixtures.is_empty()).then_some(fixtures)
            })
            .collect();
        SpannedSelection::from_spans(spans)
    }
    /// Resolve a group reference expression while preserving add, subtract, and range order.
    pub(super) fn resolve_group_ref_expr(
        group_ref_expr: &GroupRefExpr,
        data_source: &dyn SelectionDataSource,
        visited_groups: &mut HashSet<Uuid>,
        warnings: &mut Vec<String>,
    ) -> Vec<FixtureRef> {
        match group_ref_expr {
            GroupRefExpr::ByUid { uid } => match data_source.group_by_uid(*uid) {
                Some(group) => Self::resolve_group(&group, data_source, visited_groups, warnings),
                None => {
                    warnings.push(format!("Could not find group {}", uid));
                    Vec::new()
                }
            },
            GroupRefExpr::ById(group_id) => match data_source.group_by_id(*group_id) {
                Some(group) => Self::resolve_group(&group, data_source, visited_groups, warnings),
                None => {
                    warnings.push(format!("Could not find group {}", group_id));
                    Vec::new()
                }
            },
            GroupRefExpr::ByLabel(label) => {
                Self::resolve_group_label(label, data_source, visited_groups, warnings)
            }
            GroupRefExpr::RangeById { start, end } => {
                Self::resolve_group_range(*start, *end, data_source, visited_groups, warnings)
            }
            GroupRefExpr::MissingById(group_id) => {
                warnings.push(format!("Could not find group {}", group_id));
                Vec::new()
            }
            GroupRefExpr::MissingByLabel(label) => {
                warnings.push(format!("Could not find group \"{}\"", label));
                Vec::new()
            }
            GroupRefExpr::Add { lhs, rhs } => {
                let mut out =
                    Self::resolve_group_ref_expr(lhs, data_source, visited_groups, warnings);
                out.extend(Self::resolve_group_ref_expr(
                    rhs,
                    data_source,
                    visited_groups,
                    warnings,
                ));
                out
            }
            GroupRefExpr::Sub { lhs, rhs } => {
                let mut out =
                    Self::resolve_group_ref_expr(lhs, data_source, visited_groups, warnings);
                let remove =
                    Self::resolve_group_ref_expr(rhs, data_source, visited_groups, warnings);
                out.retain(|r| !remove.contains(r));
                out
            }
            GroupRefExpr::Span(inner) => {
                Self::resolve_group_ref_expr(inner, data_source, visited_groups, warnings)
            }
        }
    }

    /// Resolve a group by exact label match, warning when no matching group exists.
    pub(super) fn resolve_group_label(
        label: &str,
        data_source: &dyn SelectionDataSource,
        visited_groups: &mut HashSet<Uuid>,
        warnings: &mut Vec<String>,
    ) -> Vec<FixtureRef> {
        if !data_source.groups_available() {
            warnings.push(
                "Group label resolution attempted but group data provider not available"
                    .to_string(),
            );
            return vec![];
        }

        let Some(group) = data_source.group_by_label(label) else {
            warnings.push(format!("Could not find group \"{}\"", label));
            return vec![];
        };

        Self::resolve_group(&group, data_source, visited_groups, warnings)
    }

    /// Lower one stored group selection while detecting unavailable data and recursive references.
    pub(super) fn resolve_group(
        group: &SelectionGroup,
        data_source: &dyn SelectionDataSource,
        visited_groups: &mut HashSet<Uuid>,
        warnings: &mut Vec<String>,
    ) -> Vec<FixtureRef> {
        if !data_source.groups_available() {
            warnings.push(
                "Group resolution attempted but group data provider not available".to_string(),
            );
            return vec![];
        }

        if visited_groups.contains(&group.uid) {
            warnings.push(format!("Circular reference detected in group {}", group.id));
            return vec![];
        }

        visited_groups.insert(group.uid);
        let result = Self::resolve(
            &group.selection.source,
            data_source,
            visited_groups,
            warnings,
        );
        visited_groups.remove(&group.uid);
        result
    }

    /// Resolve an inclusive group range and retain the direction requested by the expression.
    pub(super) fn resolve_group_range(
        start: u32,
        end: u32,
        data_source: &dyn SelectionDataSource,
        visited_groups: &mut HashSet<Uuid>,
        warnings: &mut Vec<String>,
    ) -> Vec<FixtureRef> {
        let (lower, upper) = if start <= end {
            (start, end)
        } else {
            (end, start)
        };

        let mut result: Vec<FixtureRef> = (lower..=upper)
            .flat_map(|group_id| match data_source.group_by_id(group_id) {
                Some(group) => Self::resolve_group(&group, data_source, visited_groups, warnings),
                None => {
                    warnings.push(format!("Could not find group {}", group_id));
                    Vec::new()
                }
            })
            .collect();

        if start > end {
            result.reverse();
        }
        result
    }
}
