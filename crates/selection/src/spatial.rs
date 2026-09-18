// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::collections::{BTreeMap, BTreeSet, HashSet};

use nightfall::prelude::*;
use uuid::Uuid;

use crate::contracts::{SelectionDataSource, SpatialSelectionResolution};
use crate::linear::SelectionResolver;
use crate::validation::{
    MISSING_FIXTURE_REFERENCES_WARNING, push_missing_fixture_elements_warning,
};

impl SelectionResolver<'_> {
    /// Resolve a nested spatial selection, preserving its resolved indexes for composition.
    pub(super) fn resolve_spatial_to_resolved(
        selection: &SpatialSelection,
        data_source: &dyn SelectionDataSource,
        visited_groups: &mut HashSet<Uuid>,
        warnings: &mut Vec<String>,
    ) -> ResolvedSelection {
        let spanned = Self::resolve_pipeline_source_spans(
            &selection.source,
            &selection.clauses,
            data_source,
            visited_groups,
            warnings,
        );
        let canonical = spanned.flatten();
        let (mut resolved, projection_issues) = Self::project_spanned_selection(
            &spanned,
            canonical,
            Self::projection_clauses_after_source_shaping(&selection.clauses),
            data_source,
        )
        .into_parts();
        warnings.extend(projection_issues);

        for branch in &selection.union {
            let branch_resolved =
                Self::resolve_spatial_to_resolved(branch, data_source, visited_groups, warnings);
            resolved.append_spatial_branch(branch_resolved);
        }

        resolved
    }

    /// Project spanned fixtures through spatial clauses with fixture-aware expansion.
    pub(super) fn project_spanned_selection(
        source: &SpannedSelection,
        canonical: Vec<FixtureRef>,
        clauses: &[SpatialClause],
        data_source: &dyn SelectionDataSource,
    ) -> PartialResult<ResolvedSelection> {
        let mut expansion_issues = Vec::new();
        let mut projected =
            project_spanned_selection_with_expander(source, canonical, clauses, |fixture_ref| {
                Self::expand_fixture_ref_for_projection(
                    fixture_ref,
                    data_source,
                    &mut expansion_issues,
                )
            });
        projected.issues.splice(0..0, expansion_issues);
        projected
    }

    /// Expand a projected fixture ref to element refs when it references a whole fixture.
    pub(super) fn expand_fixture_ref_for_projection(
        fixture_ref: &FixtureRef,
        data_source: &dyn SelectionDataSource,
        warnings: &mut Vec<String>,
    ) -> Vec<FixtureRef> {
        let Some(fixture) = data_source.fixture_by_ref(fixture_ref) else {
            if !warnings
                .iter()
                .any(|warning| warning == MISSING_FIXTURE_REFERENCES_WARNING)
            {
                warnings.push(MISSING_FIXTURE_REFERENCES_WARNING.to_string());
            }
            return vec![fixture_ref.clone()];
        };

        match fixture_ref.index {
            Some(index) if index > 0 && index <= fixture.element_count => {
                vec![fixture_ref.clone()]
            }
            Some(_) => {
                push_missing_fixture_elements_warning(warnings);
                Vec::new()
            }
            None => (1..=fixture.element_count)
                .map(|index| FixtureRef {
                    fixture_uid: fixture_ref.fixture_uid,
                    index: Some(index),
                })
                .collect(),
        }
    }

    /// Resolve source spans for a spatial pipeline, honoring an initial split as top-level grouping.
    pub(super) fn resolve_pipeline_source_spans(
        expr: &SelectionExpr,
        clauses: &[SpatialClause],
        data_source: &dyn SelectionDataSource,
        visited_groups: &mut HashSet<Uuid>,
        warnings: &mut Vec<String>,
    ) -> SpannedSelection {
        let leading_structure_clause_count =
            Self::leading_selection_structure_clause_count(clauses);
        if leading_structure_clause_count == 0 {
            let spans = Self::resolve_to_spans(expr, data_source, visited_groups, warnings);
            return SpannedSelection::from_spans(spans);
        }

        let mut buckets =
            Self::resolve_structure_buckets(expr, data_source, visited_groups, warnings);
        for clause in &clauses[..leading_structure_clause_count] {
            buckets = Self::apply_selection_structure_clause(
                buckets,
                clause,
                data_source,
                visited_groups,
                warnings,
            );
        }

        Self::lower_structure_buckets(buckets, data_source, visited_groups, warnings)
    }

    /// Return the number of leading clauses that shape unresolved selection containers.
    pub(super) fn leading_selection_structure_clause_count(clauses: &[SpatialClause]) -> usize {
        clauses
            .iter()
            .take_while(|clause| {
                matches!(
                    clause,
                    SpatialClause::Split | SpatialClause::Merge | SpatialClause::Expand { .. }
                )
            })
            .count()
    }

    /// Return projection clauses after consuming source-shaping-only clauses.
    pub(super) fn projection_clauses_after_source_shaping(
        clauses: &[SpatialClause],
    ) -> &[SpatialClause] {
        &clauses[Self::leading_selection_structure_clause_count(clauses)..]
    }
}

/// Resolves spatial selections by shaping the source iterator, then replaying clauses.
pub struct SpatialSelectionResolver<'a> {
    selection_resolver: SelectionResolver<'a>,
}

impl<'a> SpatialSelectionResolver<'a> {
    /// Builds a spatial resolver over the supplied fixture/group read model.
    pub fn new(data_source: &'a dyn SelectionDataSource) -> Self {
        Self {
            selection_resolver: SelectionResolver::new(data_source),
        }
    }

    /// Collapse element refs that cover every element in a fixture into one whole-fixture ref.
    pub fn collapse_complete_fixture_element_sets(
        &self,
        fixtures: Vec<FixtureRef>,
    ) -> Vec<FixtureRef> {
        let mut indexes_by_fixture = BTreeMap::new();
        for fixture_ref in &fixtures {
            let Some(index) = fixture_ref.index else {
                continue;
            };
            indexes_by_fixture
                .entry(fixture_ref.fixture_uid)
                .or_insert_with(BTreeSet::new)
                .insert(index);
        }

        let collapsible_fixture_uids = indexes_by_fixture
            .into_iter()
            .filter_map(|(fixture_uid, indexes)| {
                let fixture_ref = FixtureRef {
                    fixture_uid,
                    index: None,
                };
                let fixture = self
                    .selection_resolver
                    .data_source
                    .fixture_by_ref(&fixture_ref)?;
                let element_count = fixture.element_count;
                if element_count > 0
                    && indexes.len() == element_count as usize
                    && (1..=element_count).all(|index| indexes.contains(&index))
                {
                    Some(fixture_uid)
                } else {
                    None
                }
            })
            .collect::<HashSet<_>>();

        let mut collapsed = Vec::with_capacity(fixtures.len());
        let mut emitted_whole_fixture_uids = HashSet::new();
        for fixture_ref in fixtures {
            if fixture_ref.index.is_none()
                || collapsible_fixture_uids.contains(&fixture_ref.fixture_uid)
            {
                if emitted_whole_fixture_uids.insert(fixture_ref.fixture_uid) {
                    collapsed.push(FixtureRef {
                        fixture_uid: fixture_ref.fixture_uid,
                        index: None,
                    });
                }
            } else {
                collapsed.push(fixture_ref);
            }
        }

        collapsed
    }

    /// Resolve a spatial selection into canonical fixture refs and projection metadata.
    pub fn resolve(&self, selection: &SpatialSelection) -> PartialResult<ResolvedSelection> {
        let (mut resolved, mut issues) = self.resolve_pipeline(selection).into_parts();
        for branch in &selection.union {
            let (branch_resolved, branch_issues) = self.resolve(branch).into_parts();
            resolved.append_spatial_branch(branch_resolved);
            issues.extend(branch_issues);
        }

        PartialResult::partial_many(resolved, issues)
    }

    /// Resolve only this selection's source and clauses, excluding union branches.
    fn resolve_pipeline(&self, selection: &SpatialSelection) -> PartialResult<ResolvedSelection> {
        let mut visited_groups = HashSet::new();
        let mut issues = Vec::new();
        let source = SelectionResolver::resolve_pipeline_source_spans(
            &selection.source,
            &selection.clauses,
            self.selection_resolver.data_source,
            &mut visited_groups,
            &mut issues,
        );
        let canonical = source.flatten();
        let mut projected = SelectionResolver::project_spanned_selection(
            &source,
            canonical,
            SelectionResolver::projection_clauses_after_source_shaping(&selection.clauses),
            self.selection_resolver.data_source,
        );
        projected.issues.splice(0..0, issues);
        projected
    }
}

impl SpatialSelectionResolution for SpatialSelectionResolver<'_> {
    /// Delegate complete element-set collapsing to the concrete spatial resolver.
    fn collapse_complete_fixture_element_sets(&self, fixtures: Vec<FixtureRef>) -> Vec<FixtureRef> {
        self.collapse_complete_fixture_element_sets(fixtures)
    }

    /// Delegate spatial resolution to the concrete resolver implementation.
    fn resolve(&self, selection: &SpatialSelection) -> PartialResult<ResolvedSelection> {
        self.resolve(selection)
    }
}
