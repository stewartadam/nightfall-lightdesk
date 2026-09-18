// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::collections::HashSet;

use nightfall::prelude::*;
use uuid::Uuid;

use crate::contracts::SelectionDataSource;
use crate::validation::{
    MISSING_FIXTURE_REFERENCES_WARNING, push_missing_fixture_elements_warning,
    push_missing_fixture_warning,
};

/// Resolves fixture and group selection expressions from a pure data source.
pub struct SelectionResolver<'a> {
    pub(super) data_source: &'a dyn SelectionDataSource,
}

impl<'a> SelectionResolver<'a> {
    /// Builds a resolver over the supplied fixture/group read model.
    pub fn new(data_source: &'a dyn SelectionDataSource) -> Self {
        Self { data_source }
    }

    /// Resolve a `SelectionExpr` into a flat list of resolved `FixtureRef`s.
    ///
    /// Returns a `PartialResult` that always contains a value (possibly empty),
    /// with any resolution issues recorded. Callers should check `is_partial()`
    /// to determine if warnings should be surfaced to the user.
    pub fn resolve_expr(&self, expr: &SelectionExpr) -> PartialResult<Vec<FixtureRef>> {
        let mut visited_groups: HashSet<Uuid> = HashSet::new();
        let mut warnings = Vec::new();
        let fixtures = Self::resolve(expr, self.data_source, &mut visited_groups, &mut warnings);
        PartialResult::partial_many(fixtures, warnings)
    }

    /// Resolve a `SelectionExpr` into a `SpannedSelection` that preserves span grouping.
    ///
    /// Explicit selection sets create span boundaries. Each span receives the same
    /// fanning/phase distribution values when used with effects.
    ///
    /// Returns a `PartialResult` with any resolution issues recorded.
    pub fn resolve_expr_spanned(&self, expr: &SelectionExpr) -> PartialResult<SpannedSelection> {
        let mut visited_groups: HashSet<Uuid> = HashSet::new();
        let mut warnings = Vec::new();
        let spans =
            Self::resolve_to_spans(expr, self.data_source, &mut visited_groups, &mut warnings);
        PartialResult::partial_many(SpannedSelection::from_spans(spans), warnings)
    }

    /// Return a selection expression with dynamic group refs resolved to stable UID refs.
    pub fn stabilize_group_refs_expr(&self, expr: &SelectionExpr) -> PartialResult<SelectionExpr> {
        let mut warnings = Vec::new();
        let stabilized =
            Self::stabilize_group_refs_expr_inner(expr, self.data_source, &mut warnings);
        PartialResult::partial_many(stabilized, warnings)
    }

    /// Return a spatial selection with dynamic group refs resolved to stable UID refs.
    pub fn stabilize_group_refs_selection(
        &self,
        selection: &SpatialSelection,
    ) -> PartialResult<SpatialSelection> {
        let mut warnings = Vec::new();
        let stabilized =
            Self::stabilize_group_refs_selection_inner(selection, self.data_source, &mut warnings);
        PartialResult::partial_many(stabilized, warnings)
    }

    /// Recursively stabilize group references inside one spatial selection.
    fn stabilize_group_refs_selection_inner(
        selection: &SpatialSelection,
        data_source: &dyn SelectionDataSource,
        warnings: &mut Vec<String>,
    ) -> SpatialSelection {
        SpatialSelection {
            source: Self::stabilize_group_refs_expr_inner(&selection.source, data_source, warnings),
            clauses: selection.clauses.clone(),
            union: selection
                .union
                .iter()
                .map(|branch| {
                    Self::stabilize_group_refs_selection_inner(branch, data_source, warnings)
                })
                .collect(),
        }
    }

    /// Recursively stabilize group references inside one selection expression.
    fn stabilize_group_refs_expr_inner(
        expr: &SelectionExpr,
        data_source: &dyn SelectionDataSource,
        warnings: &mut Vec<String>,
    ) -> SelectionExpr {
        match expr {
            SelectionExpr::Group(group_ref_expr) => SelectionExpr::Group(
                Self::stabilize_group_ref_expr(group_ref_expr, data_source, warnings),
            ),
            SelectionExpr::Add { lhs, rhs } => SelectionExpr::Add {
                lhs: Box::new(Self::stabilize_group_refs_expr_inner(
                    lhs,
                    data_source,
                    warnings,
                )),
                rhs: Box::new(Self::stabilize_group_refs_expr_inner(
                    rhs,
                    data_source,
                    warnings,
                )),
            },
            SelectionExpr::Sub { lhs, rhs } => SelectionExpr::Sub {
                lhs: Box::new(Self::stabilize_group_refs_expr_inner(
                    lhs,
                    data_source,
                    warnings,
                )),
                rhs: Box::new(Self::stabilize_group_refs_expr_inner(
                    rhs,
                    data_source,
                    warnings,
                )),
            },
            SelectionExpr::Span(inner) => SelectionExpr::Span(Box::new(
                Self::stabilize_group_refs_expr_inner(inner, data_source, warnings),
            )),
            SelectionExpr::Spatial(selection) => SelectionExpr::Spatial(Box::new(
                Self::stabilize_group_refs_selection_inner(selection, data_source, warnings),
            )),
            SelectionExpr::Fixture(_)
            | SelectionExpr::FixtureRange { .. }
            | SelectionExpr::FixtureMap { .. }
            | SelectionExpr::Resolved(_) => expr.clone(),
        }
    }

    /// Stabilize one group reference expression while preserving set semantics.
    fn stabilize_group_ref_expr(
        expr: &GroupRefExpr,
        data_source: &dyn SelectionDataSource,
        warnings: &mut Vec<String>,
    ) -> GroupRefExpr {
        if !data_source.groups_available() {
            warnings
                .push("Group stabilization attempted but group data provider not available".into());
        }

        match expr {
            GroupRefExpr::ByUid { uid } => GroupRefExpr::ByUid { uid: *uid },
            GroupRefExpr::ById(group_id) => data_source
                .group_by_id(*group_id)
                .map(|group| GroupRefExpr::ByUid { uid: group.uid })
                .unwrap_or_else(|| {
                    warnings.push(format!("Could not find group {}", group_id));
                    GroupRefExpr::MissingById(*group_id)
                }),
            GroupRefExpr::ByLabel(label) => data_source
                .group_by_label(label)
                .map(|group| GroupRefExpr::ByUid { uid: group.uid })
                .unwrap_or_else(|| {
                    warnings.push(format!("Could not find group \"{}\"", label));
                    GroupRefExpr::MissingByLabel(label.clone())
                }),
            GroupRefExpr::RangeById { start, end } => {
                Self::stabilize_group_range_by_id(*start, *end, data_source, warnings)
            }
            GroupRefExpr::Add { lhs, rhs } => GroupRefExpr::Add {
                lhs: Box::new(Self::stabilize_group_ref_expr(lhs, data_source, warnings)),
                rhs: Box::new(Self::stabilize_group_ref_expr(rhs, data_source, warnings)),
            },
            GroupRefExpr::Sub { lhs, rhs } => GroupRefExpr::Sub {
                lhs: Box::new(Self::stabilize_group_ref_expr(lhs, data_source, warnings)),
                rhs: Box::new(Self::stabilize_group_ref_expr(rhs, data_source, warnings)),
            },
            GroupRefExpr::Span(inner) => GroupRefExpr::Span(Box::new(
                Self::stabilize_group_ref_expr(inner, data_source, warnings),
            )),
            GroupRefExpr::MissingById(group_id) => GroupRefExpr::MissingById(*group_id),
            GroupRefExpr::MissingByLabel(label) => GroupRefExpr::MissingByLabel(label.clone()),
        }
    }

    /// Stabilize a numeric group range into an ordered set of stable group refs.
    fn stabilize_group_range_by_id(
        start: u32,
        end: u32,
        data_source: &dyn SelectionDataSource,
        warnings: &mut Vec<String>,
    ) -> GroupRefExpr {
        let (lower, upper) = if start <= end {
            (start, end)
        } else {
            (end, start)
        };
        let mut refs = (lower..=upper)
            .map(|group_id| {
                data_source
                    .group_by_id(group_id)
                    .map(|group| GroupRefExpr::ByUid { uid: group.uid })
                    .unwrap_or_else(|| {
                        warnings.push(format!("Could not find group {}", group_id));
                        GroupRefExpr::MissingById(group_id)
                    })
            })
            .collect::<Vec<_>>();
        if start > end {
            refs.reverse();
        }

        refs.into_iter()
            .reduce(|lhs, rhs| GroupRefExpr::Add {
                lhs: Box::new(lhs),
                rhs: Box::new(rhs),
            })
            .unwrap_or(GroupRefExpr::RangeById { start, end })
    }

    /// Resolve a `SelectionExpr` into a list of spans (each span is a list of fixtures).
    ///
    /// Only `SelectionExpr::Span` explicit sets create span boundaries.
    /// When no explicit spans exist, each fixture becomes its own span for per-fixture iteration.
    /// When explicit spans exist, implicit fixtures are grouped together.
    pub(super) fn resolve_to_spans(
        expr: &SelectionExpr,
        data_source: &dyn SelectionDataSource,
        visited_groups: &mut HashSet<Uuid>,
        warnings: &mut Vec<String>,
    ) -> Vec<Vec<FixtureRef>> {
        Self::resolve_to_iterator_spans(expr, data_source, visited_groups, warnings)
    }

    /// Resolve a `SelectionExpr` into top-level iterator buckets.
    fn resolve_to_iterator_spans(
        expr: &SelectionExpr,
        data_source: &dyn SelectionDataSource,
        visited_groups: &mut HashSet<Uuid>,
        warnings: &mut Vec<String>,
    ) -> Vec<Vec<FixtureRef>> {
        match expr {
            SelectionExpr::Fixture(tgt) => Self::resolve_target(tgt, data_source, warnings)
                .into_iter()
                .map(|fixture| vec![fixture])
                .collect(),
            SelectionExpr::FixtureRange { start, end } => {
                Self::resolve_range(start, end, data_source, warnings)
                    .into_iter()
                    .map(|fixture| vec![fixture])
                    .collect()
            }
            SelectionExpr::FixtureMap { fixtures, elements } => {
                Self::resolve_fixture_map(fixtures, elements, data_source, warnings)
                    .into_iter()
                    .map(|fixture| vec![fixture])
                    .collect()
            }
            SelectionExpr::Group(group_ref_expr) => {
                Self::resolve_group_ref_expr(group_ref_expr, data_source, visited_groups, warnings)
                    .into_iter()
                    .map(|fixture| vec![fixture])
                    .collect()
            }
            SelectionExpr::Add { lhs, rhs } => {
                let mut out =
                    Self::resolve_to_iterator_spans(lhs, data_source, visited_groups, warnings);
                out.extend(Self::resolve_to_iterator_spans(
                    rhs,
                    data_source,
                    visited_groups,
                    warnings,
                ));
                out
            }
            SelectionExpr::Sub { lhs, rhs } => {
                let remove = Self::resolve(rhs, data_source, visited_groups, warnings);
                Self::resolve_to_iterator_spans(lhs, data_source, visited_groups, warnings)
                    .into_iter()
                    .filter_map(|span| {
                        let retained = span
                            .into_iter()
                            .filter(|fixture| !remove.contains(fixture))
                            .collect::<Vec<_>>();
                        (!retained.is_empty()).then_some(retained)
                    })
                    .collect()
            }
            SelectionExpr::Span(inner) => {
                let merged =
                    Self::resolve_to_iterator_spans(inner, data_source, visited_groups, warnings)
                        .into_iter()
                        .flatten()
                        .collect::<Vec<_>>();
                if merged.is_empty() {
                    Vec::new()
                } else {
                    vec![merged]
                }
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
                    .map(|span| span.to_vec())
                    .collect()
            }
            SelectionExpr::Resolved(_) => {
                Self::resolve(expr, data_source, visited_groups, warnings)
                    .into_iter()
                    .map(|fixture| vec![fixture])
                    .collect()
            }
        }
    }
    /// Lower an expression to fixture references while preserving source order and warnings.
    pub(super) fn resolve(
        expr: &SelectionExpr,
        data_source: &dyn SelectionDataSource,
        visited_groups: &mut HashSet<Uuid>,
        warnings: &mut Vec<String>,
    ) -> Vec<FixtureRef> {
        match expr {
            SelectionExpr::Fixture(tgt) => Self::resolve_target(tgt, data_source, warnings),
            SelectionExpr::FixtureRange { start, end } => {
                Self::resolve_range(start, end, data_source, warnings)
            }
            SelectionExpr::FixtureMap { fixtures, elements } => {
                Self::resolve_fixture_map(fixtures, elements, data_source, warnings)
            }
            SelectionExpr::Group(group_ref_expr) => {
                Self::resolve_group_ref_expr(group_ref_expr, data_source, visited_groups, warnings)
            }
            SelectionExpr::Add { lhs, rhs } => {
                let mut out = Self::resolve(lhs, data_source, visited_groups, warnings);
                out.extend(Self::resolve(rhs, data_source, visited_groups, warnings));
                out
            }
            SelectionExpr::Sub { lhs, rhs } => {
                let mut out = Self::resolve(lhs, data_source, visited_groups, warnings);
                let remove = Self::resolve(rhs, data_source, visited_groups, warnings);
                out.retain(|r| !remove.contains(r));
                out
            }
            SelectionExpr::Span(inner) => {
                Self::resolve(inner, data_source, visited_groups, warnings)
            }
            SelectionExpr::Spatial(selection) => {
                let resolved = Self::resolve_spatial_to_resolved(
                    selection,
                    data_source,
                    visited_groups,
                    warnings,
                );
                resolved.to_spanned_selection().flatten()
            }
            SelectionExpr::Resolved(fixtures) => {
                // Expand FixtureRefs with index: None to all their elements
                fixtures
                    .iter()
                    .flat_map(|fixture_ref| {
                        if let Some(fixture) = data_source.fixture_by_ref(fixture_ref) {
                            if let Some(idx) = fixture_ref.index {
                                if idx == 0 || idx > fixture.element_count {
                                    warnings.push(format!(
                                        "Fixture with UID {} element {} does not exist (fixture has {} elements)",
                                        fixture_ref.fixture_uid,
                                        idx,
                                        fixture.element_count
                                    ));
                                }

                                vec![fixture_ref.clone()]
                            } else {
                                (1..=fixture.element_count)
                                    .map(|idx| FixtureRef {
                                        fixture_uid: fixture_ref.fixture_uid,
                                        index: Some(idx),
                                    })
                                    .collect::<Vec<_>>()
                            }
                        } else {
                            if !warnings
                                .iter()
                                .any(|warning| warning == MISSING_FIXTURE_REFERENCES_WARNING)
                            {
                                warnings.push(MISSING_FIXTURE_REFERENCES_WARNING.to_string());
                            }
                            vec![fixture_ref.clone()]
                        }
                    })
                    .collect()
            }
        }
    }

    /// Resolve one numeric fixture and optional element target against live fixture metadata.
    pub(super) fn resolve_target(
        tgt: &UnresolvedFixtureRef,
        data_source: &dyn SelectionDataSource,
        warnings: &mut Vec<String>,
    ) -> Vec<FixtureRef> {
        match data_source.fixture_by_id(tgt.fixture_id) {
            Some(fixture) => match tgt.element_index {
                Some(idx) if idx > 0 && idx <= fixture.element_count => {
                    vec![FixtureRef {
                        fixture_uid: fixture.fixture_ref.fixture_uid,
                        index: Some(idx),
                    }]
                }
                // No element specified - return single ref with index: None (all elements)
                None => vec![FixtureRef {
                    fixture_uid: fixture.fixture_ref.fixture_uid,
                    index: None,
                }],
                Some(idx) => {
                    warnings.push(format!(
                        "Fixture {} element {} does not exist (fixture has {} elements)",
                        tgt.fixture_id, idx, fixture.element_count
                    ));
                    vec![]
                }
            },
            None => {
                warnings.push(format!("Could not find fixture {}", tgt.fixture_id));
                vec![]
            }
        }
    }

    /// Expand an inclusive fixture range, retaining traversal direction and valid elements.
    pub(super) fn resolve_range(
        start: &UnresolvedFixtureRef,
        end: &UnresolvedFixtureRef,
        data_source: &dyn SelectionDataSource,
        warnings: &mut Vec<String>,
    ) -> Vec<FixtureRef> {
        let mut fixture_list = Vec::new();
        let mut missing_fixture_ids = Vec::new();

        let (lower, upper) = if start <= end {
            (start, end)
        } else {
            (end, start)
        };

        // If both endpoints have no element index, use index: None for whole fixtures
        let use_whole_fixtures = lower.element_index.is_none() && upper.element_index.is_none();

        for fixture_id in lower.fixture_id..=upper.fixture_id {
            if let Some(fixture) = data_source.fixture_by_id(fixture_id) {
                if use_whole_fixtures {
                    // No elements specified - use index: None for all elements
                    fixture_list.push(FixtureRef {
                        fixture_uid: fixture.fixture_ref.fixture_uid,
                        index: None,
                    });
                } else {
                    // Elements specified - expand to individual element refs
                    let mut element_idx_start = 1;
                    if fixture_id == lower.fixture_id {
                        element_idx_start = lower.element_index.unwrap_or(element_idx_start);
                    }

                    let mut element_idx_end = fixture.element_count;
                    if fixture_id == upper.fixture_id {
                        element_idx_end = upper.element_index.unwrap_or(element_idx_end);
                    }

                    let element_count = fixture.element_count;
                    let valid_element_start = element_idx_start.max(1);
                    let valid_element_end = element_idx_end.min(element_count);
                    if element_idx_start == 0
                        || element_idx_end > element_count
                        || valid_element_start > valid_element_end
                    {
                        push_missing_fixture_elements_warning(warnings);
                    }

                    let elements: Vec<FixtureRef> = (valid_element_start..=valid_element_end)
                        .map(|elem_idx| FixtureRef {
                            fixture_uid: fixture.fixture_ref.fixture_uid,
                            index: Some(elem_idx),
                        })
                        .collect();

                    fixture_list.extend(elements);
                }
            } else {
                missing_fixture_ids.push(fixture_id);
            }
        }

        push_missing_fixture_warning(&missing_fixture_ids, warnings);

        if start > end {
            fixture_list.reverse();
        }

        fixture_list
    }

    /// Apply an element selector across a fixture range in the requested traversal order.
    pub(super) fn resolve_fixture_map(
        fixtures: &FixtureRangeExpr,
        elements: &ElementSelectorExpr,
        data_source: &dyn SelectionDataSource,
        warnings: &mut Vec<String>,
    ) -> Vec<FixtureRef> {
        let mut fixture_list = Vec::new();
        let mut missing_fixture_ids = Vec::new();

        let (fixture_start, fixture_end) = if fixtures.start <= fixtures.end {
            (fixtures.start, fixtures.end)
        } else {
            (fixtures.end, fixtures.start)
        };

        let mut fixture_ids: Vec<u32> = (fixture_start..=fixture_end).collect();
        if fixtures.start > fixtures.end {
            fixture_ids.reverse();
        }

        let (element_start, element_end, reverse_elements) = match elements {
            ElementSelectorExpr::Single(index) => (*index, *index, false),
            ElementSelectorExpr::Range { start, end } => {
                if start <= end {
                    (*start, *end, false)
                } else {
                    (*end, *start, true)
                }
            }
        };

        for fixture_id in fixture_ids {
            if let Some(fixture) = data_source.fixture_by_id(fixture_id) {
                let mut element_indices: Vec<u32> = (element_start..=element_end).collect();
                if reverse_elements {
                    element_indices.reverse();
                }

                for idx in element_indices {
                    if idx == 0 || idx > fixture.element_count {
                        warnings.push(format!(
                            "Fixture {} element {} does not exist (fixture has {} elements)",
                            fixture_id, idx, fixture.element_count
                        ));
                        continue;
                    }
                    fixture_list.push(FixtureRef {
                        fixture_uid: fixture.fixture_ref.fixture_uid,
                        index: Some(idx),
                    });
                }
            } else {
                missing_fixture_ids.push(fixture_id);
            }
        }

        push_missing_fixture_warning(&missing_fixture_ids, warnings);

        fixture_list
    }
}
