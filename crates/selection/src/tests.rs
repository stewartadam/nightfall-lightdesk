// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::collections::{BTreeMap, HashSet};

use nightfall::prelude::*;
use nightfall_dmx::prelude::Attribute;
use uuid::Uuid;

use super::*;
use crate::validation::{MISSING_FIXTURE_ELEMENTS_WARNING, MISSING_FIXTURE_REFERENCES_WARNING};

/// In-memory group provider used by pure selection tests.
#[derive(Clone, Default)]
struct TestGroupProvider(BTreeMap<u32, Group>);

impl TestGroupProvider {
    /// Store a group definition by numeric ID.
    fn add(&mut self, group: Group) -> Result<(), String> {
        self.0.insert(group.identifiers.id, group);
        Ok(())
    }

    /// Convert one stored group into the selection resolver read model.
    fn selection_group(group: &Group) -> SelectionGroup {
        SelectionGroup {
            uid: group.identifiers.uid,
            id: group.identifiers.id,
            label: group.identifiers.label.clone(),
            selection: group.selection.clone(),
        }
    }
}

/// In-memory fixture/group lookup used by pure selection tests.
#[derive(Clone, Default)]
struct TestSelectionDataSource {
    fixtures: BTreeMap<u32, SelectionFixture>,
    groups: TestGroupProvider,
    groups_available: bool,
}

impl TestSelectionDataSource {
    /// Add a test fixture with a predictable UID and element count.
    fn add_fixture(&mut self, id: u32, element_count: usize) {
        self.fixtures.insert(
            id,
            SelectionFixture {
                fixture_ref: FixtureRef {
                    fixture_uid: Uuid::from_u128(id as u128),
                    index: None,
                },
                element_count: element_count as u32,
            },
        );
    }

    /// Return a copy that resolves groups from the supplied test provider.
    fn with_groups(&self, groups: &TestGroupProvider) -> Self {
        Self {
            fixtures: self.fixtures.clone(),
            groups: groups.clone(),
            groups_available: true,
        }
    }
}

impl SelectionDataSource for TestSelectionDataSource {
    fn fixture_by_id(&self, fixture_id: u32) -> Option<SelectionFixture> {
        self.fixtures.get(&fixture_id).cloned()
    }

    fn fixture_by_ref(&self, fixture_ref: &FixtureRef) -> Option<SelectionFixture> {
        self.fixtures
            .values()
            .find(|fixture| fixture.fixture_ref.fixture_uid == fixture_ref.fixture_uid)
            .cloned()
    }

    fn groups_available(&self) -> bool {
        self.groups_available
    }

    fn group_by_uid(&self, uid: Uuid) -> Option<SelectionGroup> {
        self.groups.0.values().find_map(|group| {
            (group.identifiers.uid == uid).then(|| TestGroupProvider::selection_group(group))
        })
    }

    fn group_by_id(&self, group_id: u32) -> Option<SelectionGroup> {
        self.groups
            .0
            .get(&group_id)
            .map(TestGroupProvider::selection_group)
    }

    fn group_by_label(&self, label: &str) -> Option<SelectionGroup> {
        self.groups.0.values().find_map(|group| {
            (group.identifiers.label == label).then(|| TestGroupProvider::selection_group(group))
        })
    }
}

/// Creates a test data source with fixtures having IDs in the given range.
/// Each fixture has 1 element.
fn make_data_source(fixture_ids: std::ops::RangeInclusive<u32>) -> TestSelectionDataSource {
    make_data_source_with_elements(fixture_ids, 1)
}

/// Creates a test data source with fixtures having IDs in the given range.
fn make_data_source_with_elements(
    fixture_ids: std::ops::RangeInclusive<u32>,
    element_count: usize,
) -> TestSelectionDataSource {
    let mut provider = TestSelectionDataSource::default();
    for id in fixture_ids {
        provider.add_fixture(id, element_count);
    }
    provider
}

/// Helper to resolve a SelectionExpr to spans using the static method.
fn resolve_spans(expr: &SelectionExpr, provider: &dyn SelectionDataSource) -> Vec<Vec<FixtureRef>> {
    let mut visited = HashSet::new();
    let mut warnings = Vec::new();
    SelectionResolver::resolve_to_spans(expr, provider, &mut visited, &mut warnings)
}

/// Helper to create a fixture ref for a given ID (no element index = all elements).
fn fref(id: u32) -> FixtureRef {
    FixtureRef {
        fixture_uid: Uuid::from_u128(id as u128),
        index: None,
    }
}

fn resolve_spatial(
    selection: SpatialSelection,
    provider: &dyn SelectionDataSource,
) -> PartialResult<ResolvedSelection> {
    let mut visited = HashSet::new();
    let mut warnings = Vec::new();
    let spanned = SelectionResolver::resolve_pipeline_source_spans(
        &selection.source,
        &selection.clauses,
        provider,
        &mut visited,
        &mut warnings,
    );
    let canonical = spanned.flatten();
    let mut projected = SelectionResolver::project_spanned_selection(
        &spanned,
        canonical,
        SelectionResolver::projection_clauses_after_source_shaping(&selection.clauses),
        provider,
    );
    projected.issues.splice(0..0, warnings);

    let (mut resolved, mut issues) = projected.into_parts();
    for branch in selection.union {
        let (branch_resolved, branch_issues) = resolve_spatial(branch, provider).into_parts();
        resolved.append_spatial_branch(branch_resolved);
        issues.extend(branch_issues);
    }

    PartialResult::partial_many(resolved, issues)
}

/// Helper to resolve a spatial selection with group provider context.
fn resolve_spatial_with_groups(
    selection: SpatialSelection,
    provider: &TestSelectionDataSource,
    groups: &TestGroupProvider,
) -> PartialResult<ResolvedSelection> {
    let provider = provider.with_groups(groups);
    let mut visited = HashSet::new();
    let mut warnings = Vec::new();
    let spanned = SelectionResolver::resolve_pipeline_source_spans(
        &selection.source,
        &selection.clauses,
        &provider,
        &mut visited,
        &mut warnings,
    );
    let canonical = spanned.flatten();
    let mut projected = SelectionResolver::project_spanned_selection(
        &spanned,
        canonical,
        SelectionResolver::projection_clauses_after_source_shaping(&selection.clauses),
        &provider,
    );
    projected.issues.splice(0..0, warnings);
    projected
}

/// Build a test group whose stored source is a fixture range.
fn make_group(id: u32, start: u32, end: u32) -> Group {
    make_group_with_clauses(id, start, end, Vec::new())
}

/// Build a test group whose stored source is a fixture range with spatial clauses.
fn make_group_with_clauses(id: u32, start: u32, end: u32, clauses: Vec<SpatialClause>) -> Group {
    Group {
        identifiers: Identifiers {
            id,
            uid: Uuid::from_u128(10_000 + id as u128),
            label: format!("Group {id}"),
        },
        selection: SpatialSelection::pipeline(
            SelectionExpr::FixtureRange {
                start: UnresolvedFixtureRef {
                    fixture_id: start,
                    element_index: None,
                },
                end: UnresolvedFixtureRef {
                    fixture_id: end,
                    element_index: None,
                },
            },
            clauses,
        ),
        description: String::new(),
    }
}

/// Build an unresolved whole-fixture selection expression.
fn fixture_expr(fixture_id: u32) -> SelectionExpr {
    SelectionExpr::Fixture(UnresolvedFixtureRef {
        fixture_id,
        element_index: None,
    })
}

/// Build an unresolved fixture range selection expression.
fn fixture_range_expr(start: u32, end: u32) -> SelectionExpr {
    SelectionExpr::FixtureRange {
        start: UnresolvedFixtureRef {
            fixture_id: start,
            element_index: None,
        },
        end: UnresolvedFixtureRef {
            fixture_id: end,
            element_index: None,
        },
    }
}

/// Build an explicit selection bucket span.
fn span_expr(expr: SelectionExpr) -> SelectionExpr {
    SelectionExpr::Span(Box::new(expr))
}

fn linear_spatial_selection(clauses: Vec<SpatialClause>) -> SpatialSelection {
    SpatialSelection::pipeline(
        SelectionExpr::FixtureRange {
            start: UnresolvedFixtureRef {
                fixture_id: 1,
                element_index: None,
            },
            end: UnresolvedFixtureRef {
                fixture_id: 8,
                element_index: None,
            },
        },
        clauses,
    )
}

fn index_fixture_ids(resolved: &ResolvedSelection) -> Vec<(bool, Vec<u32>)> {
    resolved
        .indexes
        .iter()
        .map(|index| {
            (
                index.invert,
                index
                    .members
                    .iter()
                    .map(|member| member.fixture.fixture_uid.as_u128() as u32)
                    .collect(),
            )
        })
        .collect()
}

/// Return resolved index members with fixture IDs and element indexes preserved.
fn index_fixture_refs(resolved: &ResolvedSelection) -> Vec<(bool, Vec<(u32, Option<u32>)>)> {
    resolved
        .indexes
        .iter()
        .map(|index| {
            (
                index.invert,
                index
                    .members
                    .iter()
                    .map(|member| {
                        (
                            member.fixture.fixture_uid.as_u128() as u32,
                            member.fixture.index,
                        )
                    })
                    .collect(),
            )
        })
        .collect()
}

#[test]
fn test_flat_selection_per_fixture_spans() {
    // 211>214+215+216+221+222+223>226 should produce 12 spans, one per fixture
    // (no parentheses = per-fixture iteration)
    let provider = make_data_source(211..=226);

    // Build: 211>214 + 215 + 216 + 221 + 222 + 223>226
    let range_211_214 = SelectionExpr::FixtureRange {
        start: UnresolvedFixtureRef {
            fixture_id: 211,
            element_index: None,
        },
        end: UnresolvedFixtureRef {
            fixture_id: 214,
            element_index: None,
        },
    };
    let single_215 = SelectionExpr::Fixture(UnresolvedFixtureRef {
        fixture_id: 215,
        element_index: None,
    });
    let single_216 = SelectionExpr::Fixture(UnresolvedFixtureRef {
        fixture_id: 216,
        element_index: None,
    });
    let single_221 = SelectionExpr::Fixture(UnresolvedFixtureRef {
        fixture_id: 221,
        element_index: None,
    });
    let single_222 = SelectionExpr::Fixture(UnresolvedFixtureRef {
        fixture_id: 222,
        element_index: None,
    });
    let range_223_226 = SelectionExpr::FixtureRange {
        start: UnresolvedFixtureRef {
            fixture_id: 223,
            element_index: None,
        },
        end: UnresolvedFixtureRef {
            fixture_id: 226,
            element_index: None,
        },
    };

    // Chain them with Add: ((((range_211_214 + 215) + 216) + 221) + 222) + 223>226
    let expr = SelectionExpr::Add {
        lhs: Box::new(SelectionExpr::Add {
            lhs: Box::new(SelectionExpr::Add {
                lhs: Box::new(SelectionExpr::Add {
                    lhs: Box::new(SelectionExpr::Add {
                        lhs: Box::new(range_211_214),
                        rhs: Box::new(single_215),
                    }),
                    rhs: Box::new(single_216),
                }),
                rhs: Box::new(single_221),
            }),
            rhs: Box::new(single_222),
        }),
        rhs: Box::new(range_223_226),
    };

    let spans = resolve_spans(&expr, &provider);

    // Should be 12 spans, one per fixture (no parentheses = per-fixture iteration)
    assert_eq!(spans.len(), 12, "Expected 12 spans, got {}", spans.len());

    // Verify each span contains exactly one fixture in order
    let expected_ids: Vec<u32> = vec![211, 212, 213, 214, 215, 216, 221, 222, 223, 224, 225, 226];
    for (i, expected_id) in expected_ids.iter().enumerate() {
        assert_eq!(spans[i].len(), 1, "Span {} should have 1 fixture", i);
        assert_eq!(
            spans[i][0],
            fref(*expected_id),
            "Span {} should contain fixture {}, got {:?}",
            i,
            expected_id,
            spans[i][0]
        );
    }
}

/// Group ranges keep the existing normalized fixture-level timing indexes by default.
#[test]
fn group_range_defaults_to_flat_fixture_indexes() {
    let provider = make_data_source(1..=6);
    let mut groups = TestGroupProvider::default();
    let _ = groups.add(make_group(1, 1, 2));
    let _ = groups.add(make_group(2, 3, 4));
    let _ = groups.add(make_group(3, 5, 6));

    let resolved = resolve_spatial_with_groups(
        SpatialSelection::identity(SelectionExpr::Group(GroupRefExpr::RangeById {
            start: 1,
            end: 3,
        })),
        &provider,
        &groups,
    )
    .value;

    assert_eq!(
        index_fixture_ids(&resolved),
        vec![
            (false, vec![1]),
            (false, vec![2]),
            (false, vec![3]),
            (false, vec![4]),
            (false, vec![5]),
            (false, vec![6]),
        ]
    );
}

/// An initial split treats each top-level group in a range as its own iterator element.
#[test]
fn initial_split_groups_group_range_by_top_level_groups() {
    let provider = make_data_source(1..=6);
    let mut groups = TestGroupProvider::default();
    let _ = groups.add(make_group(1, 1, 2));
    let _ = groups.add(make_group(2, 3, 4));
    let _ = groups.add(make_group(3, 5, 6));

    let resolved = resolve_spatial_with_groups(
        SpatialSelection::pipeline(
            SelectionExpr::Group(GroupRefExpr::RangeById { start: 1, end: 3 }),
            vec![SpatialClause::Split],
        ),
        &provider,
        &groups,
    )
    .value;

    assert_eq!(
        index_fixture_ids(&resolved),
        vec![
            (false, vec![1, 2]),
            (false, vec![3, 4]),
            (false, vec![5, 6]),
        ]
    );
}

/// Subtracting from a group before split filters its resolved group contents.
#[test]
fn initial_split_subtracts_from_group_contents() {
    let provider = make_data_source(1..=3);
    let mut groups = TestGroupProvider::default();
    let _ = groups.add(make_group(1, 1, 3));
    let source = SelectionExpr::Sub {
        lhs: Box::new(SelectionExpr::Group(GroupRefExpr::ById(1))),
        rhs: Box::new(fixture_expr(2)),
    };

    let resolved = resolve_spatial_with_groups(
        SpatialSelection::pipeline(source, vec![SpatialClause::Split]),
        &provider,
        &groups,
    )
    .value;

    assert_eq!(
        index_fixture_ids(&resolved),
        vec![(false, vec![1]), (false, vec![3])]
    );
}

/// Splitting a stored group preserves spatial clauses already defined inside the group.
#[test]
fn initial_split_preserves_group_spatial_clauses() {
    let provider = make_data_source(1..=3);
    let mut groups = TestGroupProvider::default();
    let _ = groups.add(make_group_with_clauses(
        1,
        1,
        3,
        vec![SpatialClause::Mirror(Axis::X)],
    ));

    let resolved = resolve_spatial_with_groups(
        SpatialSelection::pipeline(
            SelectionExpr::Group(GroupRefExpr::ById(1)),
            vec![SpatialClause::Split],
        ),
        &provider,
        &groups,
    )
    .value;

    assert_eq!(index_fixture_ids(&resolved), vec![(false, vec![3, 2, 1])]);
}

/// Subtracting from a stored group preserves its spatial clauses before filtering.
#[test]
fn initial_split_subtracts_from_transformed_group_contents() {
    let provider = make_data_source(1..=3);
    let mut groups = TestGroupProvider::default();
    let _ = groups.add(make_group_with_clauses(
        1,
        1,
        3,
        vec![SpatialClause::Mirror(Axis::X)],
    ));
    let source = SelectionExpr::Sub {
        lhs: Box::new(SelectionExpr::Group(GroupRefExpr::ById(1))),
        rhs: Box::new(fixture_expr(3)),
    };

    let resolved = resolve_spatial_with_groups(
        SpatialSelection::pipeline(source, vec![SpatialClause::Split]),
        &provider,
        &groups,
    )
    .value;

    assert_eq!(
        index_fixture_ids(&resolved),
        vec![(false, vec![2]), (false, vec![1])]
    );
}

/// Expand after an initial group split resolves contents inside the group buckets.
#[test]
fn initial_split_then_expand_descends_group_buckets() {
    let provider = make_data_source(1..=6);
    let mut groups = TestGroupProvider::default();
    let _ = groups.add(make_group(1, 1, 2));
    let _ = groups.add(make_group(2, 3, 4));
    let _ = groups.add(make_group(3, 5, 6));

    let resolved = resolve_spatial_with_groups(
        SpatialSelection::pipeline(
            SelectionExpr::Group(GroupRefExpr::RangeById { start: 1, end: 3 }),
            vec![
                SpatialClause::Split,
                SpatialClause::Expand { depth: Some(1) },
            ],
        ),
        &provider,
        &groups,
    )
    .value;

    assert_eq!(
        index_fixture_ids(&resolved),
        vec![
            (false, vec![1, 2]),
            (false, vec![3, 4]),
            (false, vec![5, 6]),
        ]
    );
}

/// Unbounded expand descends through split group containers and whole fixtures to elements.
#[test]
fn split_then_expand_all_descends_groups_and_fixtures_to_elements() {
    let provider = make_data_source_with_elements(1..=3, 2);
    let mut groups = TestGroupProvider::default();
    let _ = groups.add(make_group(1, 1, 2));
    let _ = groups.add(make_group(2, 3, 3));

    let resolved = resolve_spatial_with_groups(
        SpatialSelection::pipeline(
            SelectionExpr::Group(GroupRefExpr::RangeById { start: 1, end: 2 }),
            vec![SpatialClause::Split, SpatialClause::Expand { depth: None }],
        ),
        &provider,
        &groups,
    )
    .value;

    assert_eq!(
        index_fixture_refs(&resolved),
        vec![
            (
                false,
                vec![(1, Some(1)), (1, Some(2)), (2, Some(1)), (2, Some(2)),],
            ),
            (false, vec![(3, Some(1)), (3, Some(2))]),
        ]
    );
}

/// Expanding a fixture range preserves fixture containers while exposing their element refs.
#[test]
fn expand_descends_whole_fixture_refs_to_elements() {
    let provider = make_data_source_with_elements(1..=2, 3);

    let resolved = resolve_spatial(
        SpatialSelection::pipeline(
            fixture_range_expr(1, 2),
            vec![SpatialClause::Expand { depth: Some(1) }],
        ),
        &provider,
    )
    .value;

    assert_eq!(
        index_fixture_refs(&resolved),
        vec![
            (false, vec![(1, Some(1)), (1, Some(2)), (1, Some(3))],),
            (false, vec![(2, Some(1)), (2, Some(2)), (2, Some(3))],),
        ]
    );
}

/// Expanding resolved whole-fixture refs preserves their existing iterator positions.
#[test]
fn expand_preserves_resolved_fixture_buckets() {
    let provider = make_data_source_with_elements(1..=2, 3);
    let resolved_fixtures = vec![
        FixtureRef {
            fixture_uid: Uuid::from_u128(1),
            index: None,
        },
        FixtureRef {
            fixture_uid: Uuid::from_u128(2),
            index: None,
        },
    ];

    let resolved = resolve_spatial(
        SpatialSelection::pipeline(
            SelectionExpr::Resolved(resolved_fixtures),
            vec![SpatialClause::Expand { depth: Some(1) }],
        ),
        &provider,
    )
    .value;

    assert_eq!(
        index_fixture_refs(&resolved),
        vec![
            (false, vec![(1, Some(1)), (1, Some(2)), (1, Some(3))],),
            (false, vec![(2, Some(1)), (2, Some(2)), (2, Some(3))],),
        ]
    );
}

/// Expand after a projection transform still descends whole fixtures to elements.
#[test]
fn projected_expand_descends_block_members_to_elements() {
    let provider = make_data_source_with_elements(1..=2, 2);

    let resolved = resolve_spatial(
        SpatialSelection::pipeline(
            fixture_range_expr(1, 2),
            vec![
                SpatialClause::Blocks {
                    axis: Axis::X,
                    amount: 2,
                },
                SpatialClause::Expand { depth: Some(1) },
            ],
        ),
        &provider,
    )
    .value;

    assert_eq!(
        index_fixture_refs(&resolved),
        vec![(
            false,
            vec![(1, Some(1)), (1, Some(2)), (2, Some(1)), (2, Some(2))]
        )]
    );
}

/// Split after expand turns expanded set members into singleton timing entries.
#[test]
fn split_after_expand_segments_expanded_elements() {
    let provider = make_data_source_with_elements(1..=2, 2);

    let resolved = resolve_spatial(
        SpatialSelection::pipeline(
            fixture_range_expr(1, 2),
            vec![
                SpatialClause::Expand { depth: Some(1) },
                SpatialClause::Split,
            ],
        ),
        &provider,
    )
    .value;

    assert_eq!(
        index_fixture_refs(&resolved),
        vec![
            (false, vec![(1, Some(1))]),
            (false, vec![(1, Some(2))]),
            (false, vec![(2, Some(1))]),
            (false, vec![(2, Some(2))]),
        ]
    );
}

/// Split, expand, then merge produces one bucket with all expanded group fixtures.
#[test]
fn split_expand_merge_combines_group_range_to_one_bucket() {
    let provider = make_data_source(1..=6);
    let mut groups = TestGroupProvider::default();
    let _ = groups.add(make_group(1, 1, 2));
    let _ = groups.add(make_group(2, 3, 4));
    let _ = groups.add(make_group(3, 5, 6));

    let resolved = resolve_spatial_with_groups(
        SpatialSelection::pipeline(
            SelectionExpr::Group(GroupRefExpr::RangeById { start: 1, end: 3 }),
            vec![
                SpatialClause::Split,
                SpatialClause::Expand { depth: Some(1) },
                SpatialClause::Merge,
            ],
        ),
        &provider,
        &groups,
    )
    .value;

    assert_eq!(
        index_fixture_ids(&resolved),
        vec![(false, vec![1, 2, 3, 4, 5, 6])]
    );
}

/// Explicit selection set branches produce buckets without redundant merge clauses.
#[test]
fn explicit_selection_set_branches_resolve_to_explicit_buckets() {
    let provider = make_data_source(1..=6);
    let mut groups = TestGroupProvider::default();
    let _ = groups.add(make_group(2, 5, 6));
    let source = SelectionExpr::Add {
        lhs: Box::new(SelectionExpr::Add {
            lhs: Box::new(span_expr(fixture_range_expr(1, 3))),
            rhs: Box::new(span_expr(SelectionExpr::Add {
                lhs: Box::new(fixture_expr(4)),
                rhs: Box::new(fixture_expr(6)),
            })),
        }),
        rhs: Box::new(span_expr(SelectionExpr::Group(GroupRefExpr::ById(2)))),
    };

    let resolved =
        resolve_spatial_with_groups(SpatialSelection::identity(source), &provider, &groups).value;

    assert_eq!(
        index_fixture_ids(&resolved),
        vec![
            (false, vec![1, 2, 3]),
            (false, vec![4, 6]),
            (false, vec![5, 6]),
        ]
    );
}

/// Adding a plain selection after an explicit set concatenates iterator entries.
#[test]
fn explicit_set_plus_plain_selection_concatenates_iterators() {
    let provider = make_data_source(1..=6);
    let mut groups = TestGroupProvider::default();
    let _ = groups.add(make_group(2, 5, 6));
    let source = SelectionExpr::Add {
        lhs: Box::new(span_expr(fixture_range_expr(1, 3))),
        rhs: Box::new(SelectionExpr::Group(GroupRefExpr::ById(2))),
    };

    let resolved =
        resolve_spatial_with_groups(SpatialSelection::identity(source), &provider, &groups).value;

    assert_eq!(
        index_fixture_ids(&resolved),
        vec![(false, vec![1, 2, 3]), (false, vec![5]), (false, vec![6]),]
    );
}

/// Parenthesized transformed selections contribute their iterator to the outer addition.
#[test]
fn parenthesized_spatial_branch_plus_fixture_concatenates_iterators() {
    let provider = make_data_source(1..=5);
    let inner = SpatialSelection::pipeline(
        fixture_range_expr(1, 3),
        vec![SpatialClause::Mirror(Axis::X)],
    );
    let source = SelectionExpr::Add {
        lhs: Box::new(SelectionExpr::Spatial(Box::new(inner))),
        rhs: Box::new(fixture_expr(5)),
    };

    let resolved = resolve_spatial(SpatialSelection::identity(source), &provider).value;

    assert_eq!(
        index_fixture_ids(&resolved),
        vec![
            (false, vec![3]),
            (false, vec![2]),
            (false, vec![1]),
            (false, vec![5]),
        ]
    );
}

/// Outer merge collapses explicit selection set buckets into one timing bucket.
#[test]
fn merge_collapses_explicit_selection_set_branches_to_one_bucket() {
    let provider = make_data_source(1..=6);
    let mut groups = TestGroupProvider::default();
    let _ = groups.add(make_group(2, 5, 6));
    let source = SelectionExpr::Add {
        lhs: Box::new(SelectionExpr::Add {
            lhs: Box::new(span_expr(fixture_range_expr(1, 3))),
            rhs: Box::new(span_expr(SelectionExpr::Add {
                lhs: Box::new(fixture_expr(4)),
                rhs: Box::new(fixture_expr(6)),
            })),
        }),
        rhs: Box::new(span_expr(SelectionExpr::Group(GroupRefExpr::ById(2)))),
    };

    let resolved = resolve_spatial_with_groups(
        SpatialSelection::pipeline(source, vec![SpatialClause::Merge]),
        &provider,
        &groups,
    )
    .value;

    assert_eq!(
        index_fixture_ids(&resolved),
        vec![(false, vec![1, 2, 3, 4, 6, 5, 6])]
    );
}

/// Blocks followed by split returns fixture-level buckets from grouped block buckets.
#[test]
fn blocks_then_split_returns_fixture_level_buckets() {
    let provider = make_data_source(1..=10);

    let resolved = resolve_spatial(
        SpatialSelection::pipeline(
            fixture_range_expr(1, 10),
            vec![
                SpatialClause::Blocks {
                    axis: Axis::X,
                    amount: 2,
                },
                SpatialClause::Split,
            ],
        ),
        &provider,
    )
    .value;

    assert_eq!(
        index_fixture_ids(&resolved),
        vec![
            (false, vec![1]),
            (false, vec![2]),
            (false, vec![3]),
            (false, vec![4]),
            (false, vec![5]),
            (false, vec![6]),
            (false, vec![7]),
            (false, vec![8]),
            (false, vec![9]),
            (false, vec![10]),
        ]
    );
}

#[test]
fn test_parenthesized_spans() {
    // (211>214)+(215+216+221+222)+(223>226) should produce 3 spans
    let provider = make_data_source(211..=226);

    // Span 1: (211>214) - 4 fixtures
    let span1 = SelectionExpr::Span(Box::new(SelectionExpr::FixtureRange {
        start: UnresolvedFixtureRef {
            fixture_id: 211,
            element_index: None,
        },
        end: UnresolvedFixtureRef {
            fixture_id: 214,
            element_index: None,
        },
    }));

    // Span 2: (215+216+221+222) - 4 fixtures
    let inner_span2 = SelectionExpr::Add {
        lhs: Box::new(SelectionExpr::Add {
            lhs: Box::new(SelectionExpr::Add {
                lhs: Box::new(SelectionExpr::Fixture(UnresolvedFixtureRef {
                    fixture_id: 215,
                    element_index: None,
                })),
                rhs: Box::new(SelectionExpr::Fixture(UnresolvedFixtureRef {
                    fixture_id: 216,
                    element_index: None,
                })),
            }),
            rhs: Box::new(SelectionExpr::Fixture(UnresolvedFixtureRef {
                fixture_id: 221,
                element_index: None,
            })),
        }),
        rhs: Box::new(SelectionExpr::Fixture(UnresolvedFixtureRef {
            fixture_id: 222,
            element_index: None,
        })),
    };
    let span2 = SelectionExpr::Span(Box::new(inner_span2));

    // Span 3: (223>226) - 4 fixtures
    let span3 = SelectionExpr::Span(Box::new(SelectionExpr::FixtureRange {
        start: UnresolvedFixtureRef {
            fixture_id: 223,
            element_index: None,
        },
        end: UnresolvedFixtureRef {
            fixture_id: 226,
            element_index: None,
        },
    }));

    // Combine: span1 + span2 + span3
    let expr = SelectionExpr::Add {
        lhs: Box::new(SelectionExpr::Add {
            lhs: Box::new(span1),
            rhs: Box::new(span2),
        }),
        rhs: Box::new(span3),
    };

    let spans = resolve_spans(&expr, &provider);

    // Should be 3 spans
    assert_eq!(spans.len(), 3, "Expected 3 spans, got {}", spans.len());

    // Span 1: 211, 212, 213, 214
    assert_eq!(spans[0].len(), 4, "Span 1 should have 4 fixtures");
    assert_eq!(spans[0], vec![fref(211), fref(212), fref(213), fref(214)]);

    // Span 2: 215, 216, 221, 222
    assert_eq!(spans[1].len(), 4, "Span 2 should have 4 fixtures");
    assert_eq!(spans[1], vec![fref(215), fref(216), fref(221), fref(222)]);

    // Span 3: 223, 224, 225, 226
    assert_eq!(spans[2].len(), 4, "Span 3 should have 4 fixtures");
    assert_eq!(spans[2], vec![fref(223), fref(224), fref(225), fref(226)]);
}

#[test]
fn test_mixed_spans_and_implicit() {
    // 211>214+{215+216+221+222}+223>226 should concatenate iterator entries:
    // - 4 implicit singleton fixture entries (211-214)
    // - 1 explicit set with 4 fixtures (215, 216, 221, 222)
    // - 4 implicit singleton fixture entries (223-226)
    let provider = make_data_source(211..=226);

    // Range 211>214 (implicit)
    let range_211_214 = SelectionExpr::FixtureRange {
        start: UnresolvedFixtureRef {
            fixture_id: 211,
            element_index: None,
        },
        end: UnresolvedFixtureRef {
            fixture_id: 214,
            element_index: None,
        },
    };

    // Span (215+216+221+222) (explicit)
    let inner_span = SelectionExpr::Add {
        lhs: Box::new(SelectionExpr::Add {
            lhs: Box::new(SelectionExpr::Add {
                lhs: Box::new(SelectionExpr::Fixture(UnresolvedFixtureRef {
                    fixture_id: 215,
                    element_index: None,
                })),
                rhs: Box::new(SelectionExpr::Fixture(UnresolvedFixtureRef {
                    fixture_id: 216,
                    element_index: None,
                })),
            }),
            rhs: Box::new(SelectionExpr::Fixture(UnresolvedFixtureRef {
                fixture_id: 221,
                element_index: None,
            })),
        }),
        rhs: Box::new(SelectionExpr::Fixture(UnresolvedFixtureRef {
            fixture_id: 222,
            element_index: None,
        })),
    };
    let explicit_span = SelectionExpr::Span(Box::new(inner_span));

    // Range 223>226 (implicit)
    let range_223_226 = SelectionExpr::FixtureRange {
        start: UnresolvedFixtureRef {
            fixture_id: 223,
            element_index: None,
        },
        end: UnresolvedFixtureRef {
            fixture_id: 226,
            element_index: None,
        },
    };

    // Combine: 211>214 + (215+216+221+222) + 223>226
    let expr = SelectionExpr::Add {
        lhs: Box::new(SelectionExpr::Add {
            lhs: Box::new(range_211_214),
            rhs: Box::new(explicit_span),
        }),
        rhs: Box::new(range_223_226),
    };

    let spans = resolve_spans(&expr, &provider);

    // Should be 9 spans: four singleton fixtures, one explicit set, then four singleton fixtures.
    assert_eq!(
        spans.len(),
        9,
        "Expected 9 spans, got {}: {:?}",
        spans.len(),
        spans
    );

    assert_eq!(spans[0], vec![fref(211)]);
    assert_eq!(spans[1], vec![fref(212)]);
    assert_eq!(spans[2], vec![fref(213)]);
    assert_eq!(spans[3], vec![fref(214)]);
    assert_eq!(spans[4], vec![fref(215), fref(216), fref(221), fref(222)]);
    assert_eq!(spans[5], vec![fref(223)]);
    assert_eq!(spans[6], vec![fref(224)]);
    assert_eq!(spans[7], vec![fref(225)]);
    assert_eq!(spans[8], vec![fref(226)]);
}

#[test]
fn test_simple_range_per_fixture_spans() {
    // A simple range 1>4 should produce 4 spans, one per fixture
    let provider = make_data_source(1..=4);

    let expr = SelectionExpr::FixtureRange {
        start: UnresolvedFixtureRef {
            fixture_id: 1,
            element_index: None,
        },
        end: UnresolvedFixtureRef {
            fixture_id: 4,
            element_index: None,
        },
    };

    let spans = resolve_spans(&expr, &provider);

    assert_eq!(spans.len(), 4, "Expected 4 spans, got {}", spans.len());
    assert_eq!(spans[0], vec![fref(1)]);
    assert_eq!(spans[1], vec![fref(2)]);
    assert_eq!(spans[2], vec![fref(3)]);
    assert_eq!(spans[3], vec![fref(4)]);
}

/// Direct fixture ranges with all missing fixtures emit a single compact warning.
#[test]
fn direct_fixture_range_batches_missing_fixture_warnings() {
    let provider = make_data_source(1..=10);

    let expr = SelectionExpr::FixtureRange {
        start: UnresolvedFixtureRef {
            fixture_id: 311,
            element_index: None,
        },
        end: UnresolvedFixtureRef {
            fixture_id: 383,
            element_index: None,
        },
    };

    let mut visited = HashSet::new();
    let mut warnings = Vec::new();
    let resolved = SelectionResolver::resolve(&expr, &provider, &mut visited, &mut warnings);

    assert!(resolved.is_empty());
    assert_eq!(
        warnings,
        vec!["Could not find fixtures 311-383".to_string()]
    );
}

/// Missing fixture range warnings compact contiguous runs and singleton gaps.
#[test]
fn direct_fixture_range_batches_missing_fixture_warning_segments() {
    let mut provider = TestSelectionDataSource::default();
    provider.add_fixture(1, 1);
    provider.add_fixture(5, 1);
    provider.add_fixture(9, 1);

    let expr = SelectionExpr::FixtureRange {
        start: UnresolvedFixtureRef {
            fixture_id: 1,
            element_index: None,
        },
        end: UnresolvedFixtureRef {
            fixture_id: 9,
            element_index: None,
        },
    };

    let mut visited = HashSet::new();
    let mut warnings = Vec::new();
    let resolved = SelectionResolver::resolve(&expr, &provider, &mut visited, &mut warnings);

    assert_eq!(resolved, vec![fref(1), fref(5), fref(9)]);
    assert_eq!(
        warnings,
        vec!["Could not find fixtures 2-4, 6-8".to_string()]
    );
}

#[test]
fn test_single_fixture() {
    // A single fixture should produce 1 span with 1 fixture
    let provider = make_data_source(1..=1);

    let expr = SelectionExpr::Fixture(UnresolvedFixtureRef {
        fixture_id: 1,
        element_index: None,
    });

    let spans = resolve_spans(&expr, &provider);

    assert_eq!(spans.len(), 1, "Expected 1 span");
    assert_eq!(spans[0].len(), 1, "Expected 1 fixture");
    assert_eq!(spans[0][0], fref(1));
}

#[test]
fn test_add_without_parentheses_per_fixture() {
    // 1+2+3 should produce 3 spans, one per fixture
    let provider = make_data_source(1..=3);

    let expr = SelectionExpr::Add {
        lhs: Box::new(SelectionExpr::Add {
            lhs: Box::new(SelectionExpr::Fixture(UnresolvedFixtureRef {
                fixture_id: 1,
                element_index: None,
            })),
            rhs: Box::new(SelectionExpr::Fixture(UnresolvedFixtureRef {
                fixture_id: 2,
                element_index: None,
            })),
        }),
        rhs: Box::new(SelectionExpr::Fixture(UnresolvedFixtureRef {
            fixture_id: 3,
            element_index: None,
        })),
    };

    let spans = resolve_spans(&expr, &provider);

    assert_eq!(spans.len(), 3, "Expected 3 spans, got {}", spans.len());
    assert_eq!(spans[0], vec![fref(1)]);
    assert_eq!(spans[1], vec![fref(2)]);
    assert_eq!(spans[2], vec![fref(3)]);
}

#[test]
fn test_fixture_map_resolves_cartesian() {
    let provider = make_data_source_with_elements(1..=3, 4);

    let expr = SelectionExpr::FixtureMap {
        fixtures: FixtureRangeExpr { start: 1, end: 3 },
        elements: ElementSelectorExpr::Single(2),
    };

    let mut visited = HashSet::new();
    let mut warnings = Vec::new();
    let resolved = SelectionResolver::resolve(&expr, &provider, &mut visited, &mut warnings);

    assert!(warnings.is_empty(), "Unexpected warnings: {:?}", warnings);
    assert_eq!(resolved.len(), 3, "Expected 3 element refs");
    assert_eq!(
        resolved,
        vec![
            FixtureRef {
                fixture_uid: Uuid::from_u128(1),
                index: Some(2)
            },
            FixtureRef {
                fixture_uid: Uuid::from_u128(2),
                index: Some(2)
            },
            FixtureRef {
                fixture_uid: Uuid::from_u128(3),
                index: Some(2)
            },
        ]
    );
}

#[test]
fn test_fixture_map_range_elements() {
    let provider = make_data_source_with_elements(1..=2, 3);

    let expr = SelectionExpr::FixtureMap {
        fixtures: FixtureRangeExpr { start: 1, end: 2 },
        elements: ElementSelectorExpr::Range { start: 2, end: 3 },
    };

    let mut visited = HashSet::new();
    let mut warnings = Vec::new();
    let resolved = SelectionResolver::resolve(&expr, &provider, &mut visited, &mut warnings);

    assert!(warnings.is_empty(), "Unexpected warnings: {:?}", warnings);
    assert_eq!(resolved.len(), 4, "Expected 4 element refs");
    assert_eq!(
        resolved,
        vec![
            FixtureRef {
                fixture_uid: Uuid::from_u128(1),
                index: Some(2)
            },
            FixtureRef {
                fixture_uid: Uuid::from_u128(1),
                index: Some(3)
            },
            FixtureRef {
                fixture_uid: Uuid::from_u128(2),
                index: Some(2)
            },
            FixtureRef {
                fixture_uid: Uuid::from_u128(2),
                index: Some(3)
            },
        ]
    );
}

#[test]
fn test_linear_range_includes_intermediate_elements() {
    let provider = make_data_source_with_elements(1..=2, 3);

    let expr = SelectionExpr::FixtureRange {
        start: UnresolvedFixtureRef {
            fixture_id: 1,
            element_index: Some(2),
        },
        end: UnresolvedFixtureRef {
            fixture_id: 2,
            element_index: Some(1),
        },
    };

    let mut visited = HashSet::new();
    let mut warnings = Vec::new();
    let resolved = SelectionResolver::resolve(&expr, &provider, &mut visited, &mut warnings);

    assert!(warnings.is_empty(), "Unexpected warnings: {:?}", warnings);
    assert_eq!(resolved.len(), 3, "Expected 3 element refs");
    assert_eq!(
        resolved,
        vec![
            FixtureRef {
                fixture_uid: Uuid::from_u128(1),
                index: Some(2)
            },
            FixtureRef {
                fixture_uid: Uuid::from_u128(1),
                index: Some(3)
            },
            FixtureRef {
                fixture_uid: Uuid::from_u128(2),
                index: Some(1)
            },
        ]
    );
}

/// Element ranges skip indexes beyond the fixture element count and warn once.
#[test]
fn direct_fixture_range_drops_missing_element_indexes_and_warns_once() {
    let provider = make_data_source_with_elements(1..=2, 2);

    let expr = SelectionExpr::Add {
        lhs: Box::new(SelectionExpr::FixtureRange {
            start: UnresolvedFixtureRef {
                fixture_id: 1,
                element_index: Some(4),
            },
            end: UnresolvedFixtureRef {
                fixture_id: 1,
                element_index: Some(1),
            },
        }),
        rhs: Box::new(SelectionExpr::FixtureRange {
            start: UnresolvedFixtureRef {
                fixture_id: 2,
                element_index: Some(3),
            },
            end: UnresolvedFixtureRef {
                fixture_id: 2,
                element_index: Some(1),
            },
        }),
    };

    let mut visited = HashSet::new();
    let mut warnings = Vec::new();
    let resolved = SelectionResolver::resolve(&expr, &provider, &mut visited, &mut warnings);

    assert_eq!(warnings, vec![MISSING_FIXTURE_ELEMENTS_WARNING.to_string()]);
    assert_eq!(
        resolved,
        vec![
            FixtureRef {
                fixture_uid: Uuid::from_u128(1),
                index: Some(2)
            },
            FixtureRef {
                fixture_uid: Uuid::from_u128(1),
                index: Some(1)
            },
            FixtureRef {
                fixture_uid: Uuid::from_u128(2),
                index: Some(2)
            },
            FixtureRef {
                fixture_uid: Uuid::from_u128(2),
                index: Some(1)
            },
        ]
    );
}

/// Cross-fixture element ranges clamp only the endpoint fixture that exceeds its elements.
#[test]
fn direct_cross_fixture_range_drops_missing_endpoint_elements() {
    let provider = make_data_source_with_elements(1..=2, 2);

    let expr = SelectionExpr::FixtureRange {
        start: UnresolvedFixtureRef {
            fixture_id: 1,
            element_index: Some(1),
        },
        end: UnresolvedFixtureRef {
            fixture_id: 2,
            element_index: Some(4),
        },
    };

    let mut visited = HashSet::new();
    let mut warnings = Vec::new();
    let resolved = SelectionResolver::resolve(&expr, &provider, &mut visited, &mut warnings);

    assert_eq!(warnings, vec![MISSING_FIXTURE_ELEMENTS_WARNING.to_string()]);
    assert_eq!(
        resolved,
        vec![
            FixtureRef {
                fixture_uid: Uuid::from_u128(1),
                index: Some(1)
            },
            FixtureRef {
                fixture_uid: Uuid::from_u128(1),
                index: Some(2)
            },
            FixtureRef {
                fixture_uid: Uuid::from_u128(2),
                index: Some(1)
            },
            FixtureRef {
                fixture_uid: Uuid::from_u128(2),
                index: Some(2)
            },
        ]
    );
}

#[test]
fn test_each_parenthesis_creates_span() {
    // (1)+(2)+(3) should produce 3 spans, each with 1 fixture
    let provider = make_data_source(1..=3);

    let span1 = SelectionExpr::Span(Box::new(SelectionExpr::Fixture(UnresolvedFixtureRef {
        fixture_id: 1,
        element_index: None,
    })));
    let span2 = SelectionExpr::Span(Box::new(SelectionExpr::Fixture(UnresolvedFixtureRef {
        fixture_id: 2,
        element_index: None,
    })));
    let span3 = SelectionExpr::Span(Box::new(SelectionExpr::Fixture(UnresolvedFixtureRef {
        fixture_id: 3,
        element_index: None,
    })));

    let expr = SelectionExpr::Add {
        lhs: Box::new(SelectionExpr::Add {
            lhs: Box::new(span1),
            rhs: Box::new(span2),
        }),
        rhs: Box::new(span3),
    };

    let spans = resolve_spans(&expr, &provider);

    assert_eq!(spans.len(), 3, "Expected 3 spans, got {}", spans.len());
    assert_eq!(spans[0], vec![fref(1)]);
    assert_eq!(spans[1], vec![fref(2)]);
    assert_eq!(spans[2], vec![fref(3)]);
}

#[test]
fn spatial_blocks_group_wings_match_linear_validation() {
    let provider = make_data_source(1..=8);

    let blocks = resolve_spatial(
        linear_spatial_selection(vec![SpatialClause::Blocks {
            axis: Axis::X,
            amount: 2,
        }]),
        &provider,
    )
    .value;
    assert_eq!(
        index_fixture_ids(&blocks),
        vec![
            (false, vec![1, 2]),
            (false, vec![3, 4]),
            (false, vec![5, 6]),
            (false, vec![7, 8]),
        ]
    );

    let group = resolve_spatial(
        linear_spatial_selection(vec![SpatialClause::Group {
            axis: Axis::X,
            amount: 2,
        }]),
        &provider,
    )
    .value;
    assert_eq!(
        index_fixture_ids(&group),
        vec![(false, vec![1, 2, 3, 4]), (false, vec![5, 6, 7, 8])]
    );

    let wings = resolve_spatial(
        linear_spatial_selection(vec![SpatialClause::Wings {
            axis: Axis::X,
            amount: 2,
        }]),
        &provider,
    )
    .value;
    assert_eq!(
        index_fixture_ids(&wings),
        vec![
            (false, vec![1, 8]),
            (false, vec![2, 7]),
            (false, vec![3, 6]),
            (false, vec![4, 5]),
        ]
    );
}

/// Verifies that skip followed by take keeps the requested linear subset in canonical and index views.
#[test]
fn spatial_skip_then_take_selects_subset() {
    let provider = make_data_source(1..=8);
    let resolved = resolve_spatial(
        linear_spatial_selection(vec![SpatialClause::Skip(2), SpatialClause::Take(3)]),
        &provider,
    )
    .value;

    assert_eq!(
        resolved
            .canonical
            .iter()
            .map(|fixture| fixture.fixture_uid.as_u128() as u32)
            .collect::<Vec<_>>(),
        vec![3, 4, 5]
    );
    assert_eq!(
        index_fixture_ids(&resolved),
        vec![(false, vec![3]), (false, vec![4]), (false, vec![5]),]
    );
}

/// Verifies that taking zero fixtures produces an empty resolved selection.
#[test]
fn spatial_take_zero_clears_selection() {
    let provider = make_data_source(1..=8);
    let resolved = resolve_spatial(
        linear_spatial_selection(vec![SpatialClause::Take(0)]),
        &provider,
    )
    .value;

    assert!(resolved.canonical.is_empty());
    assert!(resolved.indexes.is_empty());
}

#[test]
fn spatial_shift_then_wings_preserves_leading_empty_index() {
    let provider = make_data_source(1..=8);
    let resolved = resolve_spatial(
        linear_spatial_selection(vec![
            SpatialClause::Shift {
                axis: Axis::X,
                amount: 1,
            },
            SpatialClause::Wings {
                axis: Axis::X,
                amount: 2,
            },
        ]),
        &provider,
    )
    .value;

    assert_eq!(
        index_fixture_ids(&resolved),
        vec![
            (false, vec![]),
            (false, vec![1, 8]),
            (false, vec![2, 7]),
            (false, vec![3, 6]),
            (false, vec![4, 5]),
        ]
    );

    let spans = resolved.to_spanned_selection();
    assert_eq!(spans.span_count(), 4);
    assert_eq!(
        spans.flatten(),
        vec![
            fref(1),
            fref(8),
            fref(2),
            fref(7),
            fref(3),
            fref(6),
            fref(4),
            fref(5)
        ]
    );
}

/// Verifies Y and Z shifts keep projection bounds for empty lanes.
#[test]
fn spatial_shift_preserves_empty_y_and_z_projection_bounds() {
    let provider = make_data_source(1..=8);
    let resolved = resolve_spatial(
        linear_spatial_selection(vec![
            SpatialClause::Shift {
                axis: Axis::Y,
                amount: 1,
            },
            SpatialClause::Shift {
                axis: Axis::Z,
                amount: 1,
            },
        ]),
        &provider,
    )
    .value;

    assert_eq!(
        resolved.projection_bounds(),
        Some(ProjectionBounds::new(0, 7, 0, 1, 0, 1))
    );
    assert!(resolved.indexes.iter().all(|index| {
        index
            .members
            .iter()
            .all(|member| member.projected_coord.y == 1 && member.projected_coord.z == 1)
    }));
}

#[test]
fn spatial_invert_block_alternates_block_indexes() {
    let provider = make_data_source(1..=8);

    let resolved = resolve_spatial(
        linear_spatial_selection(vec![
            SpatialClause::Blocks {
                axis: Axis::X,
                amount: 2,
            },
            SpatialClause::Invert {
                mode: InvertMode::Block,
                attrs: None,
            },
        ]),
        &provider,
    )
    .value;

    assert_eq!(
        index_fixture_ids(&resolved),
        vec![
            (false, vec![1, 2]),
            (true, vec![3, 4]),
            (false, vec![5, 6]),
            (true, vec![7, 8]),
        ]
    );
}

#[test]
fn spatial_invert_modes_remain_distinct_after_later_x_transforms() {
    let provider = make_data_source(1..=8);

    let invert_block = resolve_spatial(
        linear_spatial_selection(vec![
            SpatialClause::Blocks {
                axis: Axis::X,
                amount: 2,
            },
            SpatialClause::Group {
                axis: Axis::X,
                amount: 2,
            },
            SpatialClause::Invert {
                mode: InvertMode::Block,
                attrs: None,
            },
        ]),
        &provider,
    )
    .value;
    assert_eq!(
        index_fixture_ids(&invert_block),
        vec![(true, vec![1, 2, 3, 4]), (true, vec![5, 6, 7, 8]),]
    );

    let invert_group = resolve_spatial(
        linear_spatial_selection(vec![
            SpatialClause::Blocks {
                axis: Axis::X,
                amount: 2,
            },
            SpatialClause::Group {
                axis: Axis::X,
                amount: 2,
            },
            SpatialClause::Invert {
                mode: InvertMode::Group,
                attrs: None,
            },
        ]),
        &provider,
    )
    .value;
    assert_eq!(
        index_fixture_ids(&invert_group),
        vec![(false, vec![1, 2, 3, 4]), (true, vec![5, 6, 7, 8]),]
    );
}

#[test]
fn spatial_group_one_collapses_to_single_index() {
    let provider = make_data_source(1..=8);
    let resolved = resolve_spatial(
        linear_spatial_selection(vec![SpatialClause::Group {
            axis: Axis::X,
            amount: 1,
        }]),
        &provider,
    )
    .value;

    assert_eq!(
        index_fixture_ids(&resolved),
        vec![(false, vec![1, 2, 3, 4, 5, 6, 7, 8]),]
    );
}

#[test]
fn spatial_invert_carries_targeted_attrs() {
    let provider = make_data_source(1..=8);
    let resolved = resolve_spatial(
        linear_spatial_selection(vec![SpatialClause::Invert {
            mode: InvertMode::Wing,
            attrs: Some(vec![Attribute::Pan, Attribute::Tilt]),
        }]),
        &provider,
    )
    .value;

    assert_eq!(
        resolved.invert_attrs(),
        Some(&[Attribute::Pan, Attribute::Tilt][..])
    );
    assert!(resolved.should_invert_attribute(&Attribute::Pan));
    assert!(resolved.should_invert_attribute(&Attribute::Tilt));
    assert!(!resolved.should_invert_attribute(&Attribute::Intensity));
}

#[test]
fn grid_reclusters_current_resolved_indexes() {
    let provider = make_data_source(1..=8);
    let resolved = resolve_spatial(
        linear_spatial_selection(vec![
            SpatialClause::Grid(GridSize::Width(4)),
            SpatialClause::Grid(GridSize::Width(2)),
        ]),
        &provider,
    )
    .value;

    assert_eq!(
        index_fixture_ids(&resolved),
        vec![(false, vec![1, 5, 3, 7]), (false, vec![2, 6, 4, 8]),]
    );
}

#[test]
fn y_axis_transforms_remap_members_before_final_x_readout() {
    let provider = make_data_source(1..=8);
    let resolved = resolve_spatial(
        linear_spatial_selection(vec![
            SpatialClause::Grid(GridSize::WidthHeight { x: 2, y: 4 }),
            SpatialClause::Wings {
                axis: Axis::Y,
                amount: 2,
            },
        ]),
        &provider,
    )
    .value;

    assert_eq!(
        index_fixture_ids(&resolved),
        vec![(false, vec![1, 7, 3, 5]), (false, vec![2, 8, 4, 6]),]
    );
}

#[test]
fn source_spans_become_initial_spatial_units() {
    let provider = make_data_source(1..=4);
    let selection = SpatialSelection {
        source: SelectionExpr::Add {
            lhs: Box::new(SelectionExpr::Span(Box::new(SelectionExpr::FixtureRange {
                start: UnresolvedFixtureRef {
                    fixture_id: 1,
                    element_index: None,
                },
                end: UnresolvedFixtureRef {
                    fixture_id: 2,
                    element_index: None,
                },
            }))),
            rhs: Box::new(SelectionExpr::Span(Box::new(SelectionExpr::FixtureRange {
                start: UnresolvedFixtureRef {
                    fixture_id: 3,
                    element_index: None,
                },
                end: UnresolvedFixtureRef {
                    fixture_id: 4,
                    element_index: None,
                },
            }))),
        },
        clauses: vec![SpatialClause::Grid(GridSize::Width(2))],
        union: Vec::new(),
    };

    let resolved = resolve_spatial(selection, &provider).value;
    assert_eq!(
        index_fixture_ids(&resolved),
        vec![(false, vec![1, 2]), (false, vec![3, 4])]
    );
}

/// Verifies outer spatial transforms operate on indexes produced by an inner pipeline.
#[test]
fn parenthesized_spatial_selection_composes_with_outer_grouping() {
    let provider = make_data_source(301..=320);
    let source = SelectionExpr::FixtureRange {
        start: UnresolvedFixtureRef {
            fixture_id: 301,
            element_index: None,
        },
        end: UnresolvedFixtureRef {
            fixture_id: 320,
            element_index: None,
        },
    };
    let inner = SpatialSelection::pipeline(
        source.clone(),
        vec![SpatialClause::Group {
            axis: Axis::X,
            amount: 4,
        }],
    );
    let selection = SpatialSelection::pipeline(
        SelectionExpr::Spatial(Box::new(inner)),
        vec![SpatialClause::Group {
            axis: Axis::X,
            amount: 2,
        }],
    );

    let resolved = resolve_spatial(selection, &provider).value;
    assert_eq!(
        index_fixture_ids(&resolved),
        vec![
            (
                false,
                vec![301, 302, 303, 304, 305, 306, 307, 308, 309, 310]
            ),
            (
                false,
                vec![311, 312, 313, 314, 315, 316, 317, 318, 319, 320]
            ),
        ]
    );
}

/// Verifies taking one outer group equals taking the corresponding inner groups directly.
#[test]
fn parenthesized_spatial_selection_take_matches_inner_take() {
    let provider = make_data_source(301..=320);
    let source = SelectionExpr::FixtureRange {
        start: UnresolvedFixtureRef {
            fixture_id: 301,
            element_index: None,
        },
        end: UnresolvedFixtureRef {
            fixture_id: 320,
            element_index: None,
        },
    };
    let nested = SpatialSelection::pipeline(
        SelectionExpr::Spatial(Box::new(SpatialSelection::pipeline(
            source.clone(),
            vec![SpatialClause::Group {
                axis: Axis::X,
                amount: 4,
            }],
        ))),
        vec![
            SpatialClause::Group {
                axis: Axis::X,
                amount: 2,
            },
            SpatialClause::Take(1),
        ],
    );
    let direct = SpatialSelection::pipeline(
        source,
        vec![
            SpatialClause::Group {
                axis: Axis::X,
                amount: 4,
            },
            SpatialClause::Take(2),
        ],
    );

    let nested = resolve_spatial(nested, &provider).value;
    let direct = resolve_spatial(direct, &provider).value;
    assert_eq!(nested.canonical_fixtures(), direct.canonical_fixtures());
}

#[test]
fn spatial_union_resolves_each_branch_pipeline_in_order() {
    let provider = make_data_source(1..=8);
    let source = SelectionExpr::FixtureRange {
        start: UnresolvedFixtureRef {
            fixture_id: 1,
            element_index: None,
        },
        end: UnresolvedFixtureRef {
            fixture_id: 8,
            element_index: None,
        },
    };
    let selection = SpatialSelection {
        source: source.clone(),
        clauses: vec![SpatialClause::Take(2)],
        union: vec![SpatialSelection::pipeline(
            source,
            vec![SpatialClause::Skip(2), SpatialClause::Take(2)],
        )],
    };

    let resolved = resolve_spatial(selection, &provider).value;
    assert_eq!(
        index_fixture_ids(&resolved),
        vec![
            (false, vec![1]),
            (false, vec![2]),
            (false, vec![3]),
            (false, vec![4])
        ]
    );
    assert_eq!(
        resolved
            .indexes()
            .iter()
            .map(|index| index.index)
            .collect::<Vec<_>>(),
        vec![0, 1, 2, 3]
    );
    assert_eq!(
        resolved.projection_bounds(),
        Some(ProjectionBounds::new(0, 3, 0, 0, 0, 0))
    );
}

#[test]
/// Missing resolved fixture refs emit a single aggregate warning while preserving refs.
fn resolved_selection_warns_for_missing_fixture_uid() {
    let provider = make_data_source(1..=1);
    let missing_uids = [Uuid::from_u128(99), Uuid::from_u128(100)];
    let selection = SpatialSelection::identity(SelectionExpr::Resolved(
        missing_uids
            .iter()
            .map(|fixture_uid| FixtureRef {
                fixture_uid: *fixture_uid,
                index: Some(1),
            })
            .collect(),
    ));

    let result = resolve_spatial(selection, &provider);

    assert_eq!(
        result.value.canonical_fixtures(),
        &[
            FixtureRef {
                fixture_uid: missing_uids[0],
                index: Some(1)
            },
            FixtureRef {
                fixture_uid: missing_uids[1],
                index: Some(1)
            }
        ]
    );
    assert_eq!(
        result.issues,
        vec![MISSING_FIXTURE_REFERENCES_WARNING.to_string()]
    );
}

#[test]
/// Resolved fixture refs warn and drop entries when their element index is stale.
fn resolved_selection_warns_for_missing_element() {
    let provider = make_data_source_with_elements(1..=1, 1);
    let selection = SpatialSelection::identity(SelectionExpr::Resolved(vec![FixtureRef {
        fixture_uid: Uuid::from_u128(1),
        index: Some(2),
    }]));

    let result = resolve_spatial(selection, &provider);

    assert_eq!(
        result.value.canonical_fixtures(),
        &[FixtureRef {
            fixture_uid: Uuid::from_u128(1),
            index: Some(2)
        }]
    );
    assert_eq!(
        result.issues,
        vec![
            "Fixture with UID 00000000-0000-0000-0000-000000000001 element 2 does not exist (fixture has 1 elements)"
        ]
    );
}

#[test]
/// Group label selection resolves the group whose label exactly matches the quoted source.
fn group_label_selection_resolves_matching_group() {
    let fixture = FixtureRef {
        fixture_uid: Uuid::from_u128(1),
        index: Some(1),
    };
    let group = Group {
        identifiers: Identifiers {
            id: 1,
            uid: Uuid::from_u128(101),
            label: "No Fixtures".to_string(),
        },
        selection: SpatialSelection::identity(SelectionExpr::Resolved(vec![fixture.clone()])),
        description: String::new(),
    };
    let mut groups = TestGroupProvider::default();
    groups.add(group).expect("group should add");
    let provider = make_data_source_with_elements(1..=1, 1).with_groups(&groups);
    let resolver = SpatialSelectionResolver::new(&provider);

    let resolved = resolver
        .resolve(&SpatialSelection::identity(SelectionExpr::Group(
            GroupRefExpr::ByLabel("No Fixtures".to_string()),
        )))
        .into_value();

    assert_eq!(resolved.canonical_fixtures(), &[fixture]);
}

#[test]
/// Stable group UID refs resolve the same group after its numeric alias changes.
fn group_uid_selection_survives_numeric_id_change() {
    let fixture = FixtureRef {
        fixture_uid: Uuid::from_u128(1),
        index: Some(1),
    };
    let group_uid = Uuid::from_u128(101);
    let group = Group {
        identifiers: Identifiers {
            id: 2,
            uid: group_uid,
            label: "Moved Group".to_string(),
        },
        selection: SpatialSelection::identity(SelectionExpr::Resolved(vec![FixtureRef {
            fixture_uid: fixture.fixture_uid,
            index: None,
        }])),
        description: String::new(),
    };
    let mut groups = TestGroupProvider::default();
    groups.add(group).expect("group should add");
    let provider = make_data_source_with_elements(1..=1, 1).with_groups(&groups);
    let resolver = SpatialSelectionResolver::new(&provider);

    let resolved = resolver
        .resolve(&SpatialSelection::identity(SelectionExpr::Group(
            GroupRefExpr::ByUid { uid: group_uid },
        )))
        .into_value();

    assert_eq!(resolved.canonical_fixtures(), &[fixture]);
}

#[test]
/// Dynamic group ID refs follow whichever group currently owns that numeric ID.
fn group_id_selection_follows_current_numeric_alias() {
    let fixture = FixtureRef {
        fixture_uid: Uuid::from_u128(2),
        index: Some(1),
    };
    let group = Group {
        identifiers: Identifiers {
            id: 1,
            uid: Uuid::from_u128(202),
            label: "Current Group 1".to_string(),
        },
        selection: SpatialSelection::identity(SelectionExpr::Resolved(vec![FixtureRef {
            fixture_uid: fixture.fixture_uid,
            index: None,
        }])),
        description: String::new(),
    };
    let mut groups = TestGroupProvider::default();
    groups.add(group).expect("group should add");
    let provider = make_data_source_with_elements(1..=2, 1).with_groups(&groups);
    let resolver = SpatialSelectionResolver::new(&provider);

    let resolved = resolver
        .resolve(&SpatialSelection::identity(SelectionExpr::Group(
            GroupRefExpr::ById(1),
        )))
        .into_value();

    assert_eq!(resolved.canonical_fixtures(), &[fixture]);
}

#[test]
/// Nested stable group refs resolve through group objects instead of numeric aliases.
fn nested_group_uid_selection_resolves_nested_group() {
    let fixture = FixtureRef {
        fixture_uid: Uuid::from_u128(1),
        index: Some(1),
    };
    let nested_uid = Uuid::from_u128(301);
    let parent_uid = Uuid::from_u128(302);
    let mut groups = TestGroupProvider::default();
    groups
        .add(Group {
            identifiers: Identifiers {
                id: 9,
                uid: nested_uid,
                label: "Nested".to_owned(),
            },
            selection: SpatialSelection::identity(SelectionExpr::Resolved(vec![FixtureRef {
                fixture_uid: fixture.fixture_uid,
                index: None,
            }])),
            description: String::new(),
        })
        .expect("nested group should add");
    groups
        .add(Group {
            identifiers: Identifiers {
                id: 10,
                uid: parent_uid,
                label: "Parent".to_owned(),
            },
            selection: SpatialSelection::identity(SelectionExpr::Group(GroupRefExpr::ByUid {
                uid: nested_uid,
            })),
            description: String::new(),
        })
        .expect("parent group should add");
    let provider = make_data_source_with_elements(1..=1, 1).with_groups(&groups);
    let resolver = SpatialSelectionResolver::new(&provider);

    let resolved = resolver
        .resolve(&SpatialSelection::identity(SelectionExpr::Group(
            GroupRefExpr::ByUid { uid: parent_uid },
        )))
        .into_value();

    assert_eq!(resolved.canonical_fixtures(), &[fixture]);
}

#[test]
/// Circular group detection keys recursion by stable UID rather than numeric alias.
fn circular_group_uid_selection_reports_warning() {
    let first_uid = Uuid::from_u128(401);
    let second_uid = Uuid::from_u128(402);
    let mut groups = TestGroupProvider::default();
    groups
        .add(Group {
            identifiers: Identifiers {
                id: 11,
                uid: first_uid,
                label: "First".to_owned(),
            },
            selection: SpatialSelection::identity(SelectionExpr::Group(GroupRefExpr::ByUid {
                uid: second_uid,
            })),
            description: String::new(),
        })
        .expect("first group should add");
    groups
        .add(Group {
            identifiers: Identifiers {
                id: 12,
                uid: second_uid,
                label: "Second".to_owned(),
            },
            selection: SpatialSelection::identity(SelectionExpr::Group(GroupRefExpr::ByUid {
                uid: first_uid,
            })),
            description: String::new(),
        })
        .expect("second group should add");
    let provider = make_data_source_with_elements(1..=1, 1).with_groups(&groups);
    let resolver = SpatialSelectionResolver::new(&provider);

    let resolved = resolver.resolve(&SpatialSelection::identity(SelectionExpr::Group(
        GroupRefExpr::ByUid { uid: first_uid },
    )));

    assert!(resolved.value.canonical_fixtures().is_empty());
    assert!(
        resolved
            .issues
            .iter()
            .any(|warning| warning == "Circular reference detected in group 11")
    );
}

#[test]
/// Storage normalization expands authored group ranges into stable UID refs.
fn stabilize_group_range_by_id_expands_to_uid_refs() {
    let mut groups = TestGroupProvider::default();
    groups
        .add(Group {
            identifiers: Identifiers {
                id: 1,
                uid: Uuid::from_u128(101),
                label: "Group 1".to_string(),
            },
            selection: SpatialSelection::default(),
            description: String::new(),
        })
        .expect("group should add");
    groups
        .add(Group {
            identifiers: Identifiers {
                id: 2,
                uid: Uuid::from_u128(102),
                label: "Group 2".to_string(),
            },
            selection: SpatialSelection::default(),
            description: String::new(),
        })
        .expect("group should add");
    let provider = make_data_source_with_elements(1..=2, 1).with_groups(&groups);
    let resolver = SelectionResolver::new(&provider);

    let stabilized = resolver
        .stabilize_group_refs_expr(&SelectionExpr::Group(GroupRefExpr::RangeById {
            start: 1,
            end: 2,
        }))
        .into_value();

    assert_eq!(
        stabilized,
        SelectionExpr::Group(GroupRefExpr::Add {
            lhs: Box::new(GroupRefExpr::ByUid {
                uid: Uuid::from_u128(101),
            }),
            rhs: Box::new(GroupRefExpr::ByUid {
                uid: Uuid::from_u128(102),
            }),
        })
    );
}

/// Storage normalization freezes missing aliases so later groups cannot capture them.
#[test]
fn stabilize_missing_group_alias_does_not_bind_later() {
    let empty_groups = TestGroupProvider::default();
    let provider = make_data_source_with_elements(1..=1, 1).with_groups(&empty_groups);
    let stabilized = SelectionResolver::new(&provider)
        .stabilize_group_refs_expr(&SelectionExpr::Group(GroupRefExpr::ById(7)));

    assert_eq!(
        stabilized.value,
        SelectionExpr::Group(GroupRefExpr::MissingById(7))
    );
    assert_eq!(stabilized.issues, vec!["Could not find group 7"]);

    let mut later_groups = TestGroupProvider::default();
    later_groups
        .add(Group {
            identifiers: Identifiers {
                id: 7,
                uid: Uuid::from_u128(107),
                label: "Later group".to_owned(),
            },
            selection: SpatialSelection::identity(fixture_expr(1)),
            description: String::new(),
        })
        .expect("later group should add");
    let later_provider = make_data_source_with_elements(1..=1, 1).with_groups(&later_groups);
    let resolved = SelectionResolver::new(&later_provider).resolve_expr(&stabilized.value);

    assert!(resolved.value.is_empty());
    assert_eq!(resolved.issues, vec!["Could not find group 7"]);
}

#[test]
/// Group validation hooks surface warnings from their stored spatial selection.
fn group_validation_hook_returns_selection_warnings() {
    let group = Group {
        identifiers: Identifiers {
            id: 1,
            uid: Uuid::from_u128(101),
            label: "Group 1".to_string(),
        },
        selection: SpatialSelection::identity(SelectionExpr::Resolved(vec![FixtureRef {
            fixture_uid: Uuid::from_u128(1),
            index: Some(2),
        }])),
        description: String::new(),
    };
    let mut groups = TestGroupProvider::default();
    groups.add(group.clone()).expect("group should add");
    let provider = make_data_source_with_elements(1..=1, 1).with_groups(&groups);
    let resolver = SpatialSelectionResolver::new(&provider);

    let warnings = group.selection_validation_warnings(&resolver);

    assert_eq!(
        warnings,
        vec![
            "Fixture with UID 00000000-0000-0000-0000-000000000001 element 2 does not exist (fixture has 1 elements)"
        ]
    );
}

#[test]
/// Filtering resolved selections removes stale canonical refs and compacts indexes.
fn filter_existing_selection_removes_missing_fixtures_and_compacts_indexes() {
    let provider = make_data_source_with_elements(1..=2, 2);
    let stale_fixture = FixtureRef {
        fixture_uid: Uuid::from_u128(99),
        index: Some(1),
    };
    let stale_element = FixtureRef {
        fixture_uid: Uuid::from_u128(1),
        index: Some(3),
    };
    let valid_fixture_one = FixtureRef {
        fixture_uid: Uuid::from_u128(1),
        index: Some(1),
    };
    let valid_fixture_two = FixtureRef {
        fixture_uid: Uuid::from_u128(2),
        index: None,
    };
    let resolved = ResolvedSelection::new(
        vec![
            valid_fixture_one.clone(),
            stale_fixture.clone(),
            stale_element.clone(),
            valid_fixture_two.clone(),
        ],
        vec![
            SelectionIndex {
                index: 0,
                invert: false,
                members: vec![IndexedFixture {
                    fixture: stale_fixture,
                    projected_coord: ProjectedCoord { x: 0, y: 0, z: 0 },
                }],
            },
            SelectionIndex {
                index: 1,
                invert: true,
                members: vec![
                    IndexedFixture {
                        fixture: stale_element,
                        projected_coord: ProjectedCoord { x: 1, y: 0, z: 0 },
                    },
                    IndexedFixture {
                        fixture: valid_fixture_two.clone(),
                        projected_coord: ProjectedCoord { x: 1, y: 1, z: 0 },
                    },
                ],
            },
            SelectionIndex {
                index: 2,
                invert: false,
                members: vec![IndexedFixture {
                    fixture: valid_fixture_one.clone(),
                    projected_coord: ProjectedCoord { x: 2, y: 0, z: 0 },
                }],
            },
        ],
        Some(vec![Attribute::Pan]),
    );

    let filtered = filter_existing_selection(&resolved, &provider);

    assert_eq!(
        filtered.canonical_fixtures(),
        &[valid_fixture_one.clone(), valid_fixture_two.clone()]
    );
    assert_eq!(filtered.indexes().len(), 2);
    assert_eq!(filtered.indexes()[0].index, 0);
    assert!(filtered.indexes()[0].invert);
    assert_eq!(filtered.indexes()[0].members[0].fixture, valid_fixture_two);
    assert_eq!(filtered.indexes()[0].members[0].projected_coord.x, 0);
    assert_eq!(filtered.indexes()[0].members[0].projected_coord.y, 1);
    assert_eq!(filtered.indexes()[1].index, 1);
    assert_eq!(filtered.indexes()[1].members[0].fixture, valid_fixture_one);
    assert_eq!(filtered.indexes()[1].members[0].projected_coord.x, 1);
    assert_eq!(filtered.invert_attrs(), Some(&[Attribute::Pan][..]));
    assert_eq!(
        filtered.projection_bounds(),
        Some(ProjectionBounds::new(0, 1, 0, 1, 0, 0))
    );
}
