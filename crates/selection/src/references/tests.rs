// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::collections::BTreeMap;

use super::*;

/// Reference source holding an arbitrary list of references, standing in for domain objects.
#[derive(Default)]
struct TestSource {
    selections: Vec<(String, SpatialSelection)>,
    groups: Vec<(String, Uuid)>,
    blueprints: Vec<(String, Uuid)>,
    output_targets: Vec<(String, String)>,
}

impl TestSource {
    /// Builds a source holding one selection at `selection`.
    fn selection(source: SelectionExpr) -> Self {
        Self {
            selections: vec![("selection".to_owned(), SpatialSelection::identity(source))],
            ..Default::default()
        }
    }
}

impl ReferenceSource for TestSource {
    fn visit_references(&self, visit: &mut dyn FnMut(&str, HeldReference<'_>)) {
        for (path, selection) in &self.selections {
            visit(path, HeldReference::Selection(selection));
        }
        for (path, uid) in &self.groups {
            visit(path, HeldReference::Group(*uid));
        }
        for (path, uid) in &self.blueprints {
            visit(path, HeldReference::Blueprint(*uid));
        }
        for (path, target) in &self.output_targets {
            visit(path, HeldReference::OutputTarget(target));
        }
    }

    fn visit_selections_mut(&mut self, visit: &mut dyn FnMut(&mut SpatialSelection)) {
        for (_, selection) in &mut self.selections {
            visit(selection);
        }
    }
}

/// Returns a deterministic UUID for test object `n`.
fn uid(n: u128) -> Uuid {
    Uuid::from_u128(n)
}

/// Builds owner metadata for a test object in `domain`.
fn owner(domain: ReferenceDomain, id: u32) -> ReferenceOwner {
    ReferenceOwner::object(
        domain,
        &Identifiers {
            id,
            uid: uid(0x1000 + id as u128),
            label: format!("Object {id}"),
        },
    )
}

/// Show-wide view of a [`ReferenceBook`], shaped for assertions.
struct Report {
    summary: ReferenceSummary,
    issues: Vec<ReferenceIssue>,
    group_dependents: BTreeMap<Uuid, BTreeSet<String>>,
    blueprint_dependents: BTreeMap<Uuid, BTreeSet<String>>,
}

impl Report {
    /// Reads the counts, sorted issues and dependents out of `book`.
    fn of(book: &ReferenceBook) -> Self {
        /// Groups `(target, description)` pairs by target.
        fn grouped(pairs: Vec<(Uuid, String)>) -> BTreeMap<Uuid, BTreeSet<String>> {
            let mut grouped = BTreeMap::<Uuid, BTreeSet<String>>::new();
            for (uid, description) in pairs {
                grouped.entry(uid).or_default().insert(description);
            }
            grouped
        }
        Self {
            summary: book.summary().clone(),
            issues: book.issues(),
            group_dependents: grouped(book.group_dependents()),
            blueprint_dependents: grouped(book.blueprint_dependents()),
        }
    }
}

/// Audits each `(owner, source)` pair against `lookup` into a fresh book.
fn audit_book(lookup: &ReferenceLookup, sources: &[(ReferenceOwner, TestSource)]) -> ReferenceBook {
    let mut book = ReferenceBook::default();
    for (owner, source) in sources {
        book.insert(audit_owner(lookup, owner.clone(), source));
    }
    book
}

/// Audits each `(owner, source)` pair against `lookup` and reports the show-wide result.
fn audit(lookup: &ReferenceLookup, sources: &[(ReferenceOwner, TestSource)]) -> Report {
    Report::of(&audit_book(lookup, sources))
}

/// Returns the issue reasons in report order.
fn reasons(report: &Report) -> Vec<ReferenceIssueReason> {
    report.issues.iter().map(|issue| issue.reason).collect()
}

/// Builds a fixture reference by user-facing ID.
fn fixture_id(fixture_id: u32, element_index: Option<u32>) -> UnresolvedFixtureRef {
    UnresolvedFixtureRef {
        fixture_id,
        element_index,
    }
}

/// Verifies missing resolved fixture UIDs and out-of-range elements are prunable issues.
#[test]
fn reports_missing_resolved_fixture_references() {
    let mut lookup = ReferenceLookup::default();
    lookup.add_fixture(uid(1), 1, 1);
    let source = TestSource::selection(SelectionExpr::Resolved(vec![
        FixtureRef {
            fixture_uid: uid(1),
            index: Some(2),
        },
        FixtureRef {
            fixture_uid: uid(99),
            index: None,
        },
    ]));

    let report = audit(&lookup, &[(owner(ReferenceDomain::Cue, 1), source)]);

    assert_eq!(report.summary.issue_count, 2);
    assert_eq!(report.summary.prunable_issue_count, 2);
    assert_eq!(
        reasons(&report),
        vec![
            ReferenceIssueReason::MissingFixtureElement,
            ReferenceIssueReason::MissingFixtureUid
        ]
    );
    assert_eq!(report.issues[0].path, "selection.source.Resolved[0]");
    assert_eq!(
        report.issues[1].target,
        ReferenceTarget::FixtureUid {
            fixture_uid: uid(99)
        }
    );
}

/// Verifies fixture IDs that do not resolve are reported but cannot be pruned.
#[test]
fn reports_non_prunable_unresolved_fixture_issues() {
    let mut lookup = ReferenceLookup::default();
    lookup.add_fixture(uid(1), 1, 1);

    let report = audit(
        &lookup,
        &[
            (
                owner(ReferenceDomain::Fx, 1),
                TestSource::selection(SelectionExpr::Fixture(fixture_id(99, None))),
            ),
            (
                owner(ReferenceDomain::Fx, 2),
                TestSource::selection(SelectionExpr::Fixture(fixture_id(1, Some(2)))),
            ),
        ],
    );

    assert_eq!(report.summary.issue_count, 2);
    assert_eq!(report.summary.prunable_issue_count, 0);
    assert_eq!(report.summary.affected_object_count, 2);
    assert_eq!(
        reasons(&report),
        vec![
            ReferenceIssueReason::MissingFixtureId,
            ReferenceIssueReason::MissingFixtureElement
        ]
    );
}

/// Verifies a fixture map gets a row per fixture element, one issue per missing fixture, and one
/// issue per missing element of a live fixture.
#[test]
fn reports_missing_fixture_map_targets() {
    let mut lookup = ReferenceLookup::default();
    lookup.add_fixture(uid(1), 1, 1);
    let source = TestSource::selection(SelectionExpr::FixtureMap {
        fixtures: FixtureRangeExpr { start: 1, end: 2 },
        elements: ElementSelectorExpr::Range { start: 1, end: 2 },
    });

    let report = audit(&lookup, &[(owner(ReferenceDomain::Fx, 1), source)]);

    assert_eq!(report.summary.reference_count, 4);
    assert_eq!(
        reasons(&report),
        vec![
            ReferenceIssueReason::MissingFixtureElement,
            ReferenceIssueReason::MissingFixtureId
        ]
    );
}

/// Verifies fixture ranges with element endpoints expand per element and report missing ones.
#[test]
fn reports_missing_fixture_range_element_endpoints() {
    let mut lookup = ReferenceLookup::default();
    lookup.add_fixture(uid(1), 1, 1);
    lookup.add_fixture(uid(2), 2, 2);
    let source = TestSource::selection(SelectionExpr::FixtureRange {
        start: fixture_id(1, Some(2)),
        end: fixture_id(2, Some(3)),
    });

    let report = audit(&lookup, &[(owner(ReferenceDomain::Fx, 1), source)]);

    assert_eq!(report.summary.reference_count, 4);
    assert_eq!(report.summary.prunable_issue_count, 0);
    assert_eq!(
        report
            .issues
            .iter()
            .map(|issue| issue.target.clone())
            .collect::<Vec<_>>(),
        vec![
            ReferenceTarget::Fixture {
                fixture_id: 1,
                element_index: Some(2)
            },
            ReferenceTarget::Fixture {
                fixture_id: 2,
                element_index: Some(3)
            },
        ]
    );
    assert_eq!(
        reasons(&report),
        vec![
            ReferenceIssueReason::MissingFixtureElement,
            ReferenceIssueReason::MissingFixtureElement
        ]
    );
}

/// Verifies whole-fixture ranges keep missing fixtures in the middle of the range as rows.
#[test]
fn reports_missing_fixtures_inside_a_range() {
    let mut lookup = ReferenceLookup::default();
    lookup.add_fixture(uid(1), 1, 1);
    lookup.add_fixture(uid(3), 3, 1);
    let source = TestSource::selection(SelectionExpr::FixtureRange {
        start: fixture_id(3, None),
        end: fixture_id(1, None),
    });

    let report = audit(&lookup, &[(owner(ReferenceDomain::Group, 1), source)]);

    assert_eq!(report.summary.reference_count, 3);
    assert_eq!(
        reasons(&report),
        vec![ReferenceIssueReason::MissingFixtureId]
    );
    assert_eq!(
        report.issues[0].target,
        ReferenceTarget::Fixture {
            fixture_id: 2,
            element_index: None
        }
    );
}

/// Verifies output bindings report output targets that resolve to no configured output.
#[test]
fn reports_missing_output_targets() {
    let mut lookup = ReferenceLookup::default();
    lookup.add_output_target("sacn");
    let binding = |target: &str| TestSource {
        output_targets: vec![("target.target".to_owned(), target.to_owned())],
        ..Default::default()
    };

    let report = audit(
        &lookup,
        &[
            (ReferenceOwner::output_binding(0), binding("sacn")),
            (ReferenceOwner::output_binding(1), binding("removed-node")),
        ],
    );

    assert_eq!(report.summary.object_count, 2);
    assert_eq!(report.summary.reference_count, 2);
    assert_eq!(report.summary.prunable_issue_count, 0);
    assert_eq!(
        report.issues,
        vec![ReferenceIssue {
            source: ReferenceOwner {
                domain: ReferenceDomain::PatchBinding,
                uid: "output-binding-1".to_owned(),
                id: 2,
                label: "Output binding 2".to_owned(),
            },
            path: "target.target".to_owned(),
            target: ReferenceTarget::OutputTarget {
                target: "removed-node".to_owned()
            },
            reason: ReferenceIssueReason::MissingOutputTarget,
            prunable: false,
        }]
    );
}

/// Verifies group references by UID, ID, label and range are checked, and live ones record the
/// owner as a dependent of the group.
#[test]
fn reports_group_references_and_dependents() {
    let mut lookup = ReferenceLookup::default();
    lookup.add_group(uid(10), 1, "Front");
    let selection = SelectionExpr::Add {
        lhs: Box::new(SelectionExpr::Group(GroupRefExpr::ByUid { uid: uid(10) })),
        rhs: Box::new(SelectionExpr::Add {
            lhs: Box::new(SelectionExpr::Group(GroupRefExpr::ByUid { uid: uid(11) })),
            rhs: Box::new(SelectionExpr::Group(GroupRefExpr::Add {
                lhs: Box::new(GroupRefExpr::ByLabel("Back".to_owned())),
                rhs: Box::new(GroupRefExpr::RangeById { start: 1, end: 2 }),
            })),
        }),
    };

    let report = audit(
        &lookup,
        &[(
            owner(ReferenceDomain::Cue, 4),
            TestSource::selection(selection),
        )],
    );

    assert_eq!(report.summary.reference_count, 5);
    assert_eq!(
        reasons(&report),
        vec![
            ReferenceIssueReason::MissingGroupUid,
            ReferenceIssueReason::MissingGroupId,
            ReferenceIssueReason::MissingGroupLabel,
        ]
    );
    assert_eq!(
        report.group_dependents.get(&uid(10)),
        Some(&BTreeSet::from(["cue 4 (Object 4)".to_owned()]))
    );
}

/// Verifies a group's own selection does not make it a dependent of itself.
#[test]
fn group_is_not_its_own_dependent() {
    let mut lookup = ReferenceLookup::default();
    lookup.add_group(uid(0x1001), 1, "Self");

    let report = audit(
        &lookup,
        &[(
            owner(ReferenceDomain::Group, 1),
            TestSource::selection(SelectionExpr::Group(GroupRefExpr::ById(1))),
        )],
    );

    assert_eq!(report.summary.reference_count, 1);
    assert!(report.group_dependents.is_empty());
}

/// Verifies stable group references held outside a selection are checked like selection refs.
#[test]
fn reports_group_references_outside_selections() {
    let mut lookup = ReferenceLookup::default();
    lookup.add_group(uid(10), 3, "Wash");
    let source = TestSource {
        groups: vec![
            ("target.group".to_owned(), uid(10)),
            ("target.group".to_owned(), uid(11)),
        ],
        ..Default::default()
    };

    let report = audit(&lookup, &[(owner(ReferenceDomain::Master, 2), source)]);

    assert_eq!(
        reasons(&report),
        vec![ReferenceIssueReason::MissingGroupUid]
    );
    assert_eq!(
        report.group_dependents.get(&uid(10)),
        Some(&BTreeSet::from(["master 2 (Object 2)".to_owned()]))
    );
}

/// Verifies Blueprint references are checked and live ones record the owner as a dependent.
#[test]
fn reports_blueprint_references_and_dependents() {
    let mut lookup = ReferenceLookup::default();
    lookup.add_blueprint(uid(20));
    let source = TestSource {
        blueprints: vec![
            (
                "lanes[0].absolute.steps[0].blueprint_uid".to_owned(),
                uid(20),
            ),
            (
                "lanes[0].absolute.steps[1].blueprint_uid".to_owned(),
                uid(21),
            ),
        ],
        ..Default::default()
    };

    let report = audit(&lookup, &[(owner(ReferenceDomain::StepFx, 5), source)]);

    assert_eq!(
        reasons(&report),
        vec![ReferenceIssueReason::MissingBlueprintUid]
    );
    assert_eq!(
        report.issues[0].path,
        "lanes[0].absolute.steps[1].blueprint_uid"
    );
    assert_eq!(
        report.blueprint_dependents.get(&uid(20)),
        Some(&BTreeSet::from(["step FX 5 (Object 5)".to_owned()]))
    );
}

/// Verifies nested and union selection paths name where each reference sits.
#[test]
fn reports_nested_selection_paths() {
    let lookup = ReferenceLookup::default();
    let mut selection = SpatialSelection::identity(SelectionExpr::Span(Box::new(
        SelectionExpr::Fixture(fixture_id(1, None)),
    )));
    selection
        .union
        .push(SpatialSelection::identity(SelectionExpr::Spatial(
            Box::new(SpatialSelection::identity(SelectionExpr::Fixture(
                fixture_id(2, None),
            ))),
        )));
    let source = TestSource {
        selections: vec![("instructions[0].selection".to_owned(), selection)],
        ..Default::default()
    };

    let report = audit(&lookup, &[(owner(ReferenceDomain::Cue, 1), source)]);

    assert_eq!(
        report
            .issues
            .iter()
            .map(|issue| issue.path.as_str())
            .collect::<Vec<_>>(),
        vec![
            "instructions[0].selection.source.Span",
            "instructions[0].selection.union[0].source.Spatial.source",
        ]
    );
}

/// Verifies pruning removes missing resolved refs from nested expressions and union branches
/// while keeping live refs and unresolved expressions.
#[test]
fn prunes_missing_resolved_refs_everywhere_in_a_selection() {
    let mut lookup = ReferenceLookup::default();
    lookup.add_fixture(uid(1), 1, 2);
    let live = FixtureRef {
        fixture_uid: uid(1),
        index: Some(1),
    };
    let missing = FixtureRef {
        fixture_uid: uid(99),
        index: None,
    };
    let bad_element = FixtureRef {
        fixture_uid: uid(1),
        index: Some(3),
    };
    let mut selection = SpatialSelection::identity(SelectionExpr::Add {
        lhs: Box::new(SelectionExpr::Resolved(vec![live.clone(), missing.clone()])),
        rhs: Box::new(SelectionExpr::Fixture(fixture_id(42, None))),
    });
    selection
        .union
        .push(SpatialSelection::identity(SelectionExpr::Resolved(vec![
            bad_element,
            live.clone(),
        ])));

    let pruned = prune_missing_fixture_refs(&mut selection, &lookup);

    assert_eq!(pruned, 2);
    assert_eq!(
        selection.source,
        SelectionExpr::Add {
            lhs: Box::new(SelectionExpr::Resolved(vec![live.clone()])),
            rhs: Box::new(SelectionExpr::Fixture(fixture_id(42, None))),
        }
    );
    assert_eq!(
        selection.union[0].source,
        SelectionExpr::Resolved(vec![live])
    );
}

/// Verifies lookup setters report exactly the entries whose answer changed, and nothing when a
/// target is re-registered unchanged.
#[test]
fn lookup_setters_report_changed_entries() {
    let mut lookup = ReferenceLookup::default();
    assert_eq!(
        lookup.set_fixture(uid(1), Some((1, 4))),
        vec![LookupKey::FixtureUid(uid(1)), LookupKey::FixtureId(1)]
    );
    assert!(lookup.set_fixture(uid(1), Some((1, 4))).is_empty());
    assert_eq!(
        lookup.set_fixture(uid(1), Some((2, 4))),
        vec![
            LookupKey::FixtureUid(uid(1)),
            LookupKey::FixtureId(1),
            LookupKey::FixtureId(2)
        ]
    );
    assert_eq!(
        lookup.set_fixture(uid(1), None),
        vec![LookupKey::FixtureUid(uid(1)), LookupKey::FixtureId(2)]
    );

    lookup.add_group(uid(10), 1, "Front");
    assert!(lookup.set_group(uid(10), Some((1, "Front"))).is_empty());
    let changed = lookup.set_group(uid(10), Some((1, "Back")));
    assert!(changed.contains(&LookupKey::GroupLabel("Front".to_owned())));
    assert!(changed.contains(&LookupKey::GroupLabel("Back".to_owned())));

    assert_eq!(
        lookup.set_blueprint(uid(20), true),
        vec![LookupKey::Blueprint(uid(20))]
    );
    assert!(lookup.set_blueprint(uid(20), true).is_empty());

    lookup.add_output_target("artnet:1");
    assert_eq!(
        lookup.set_output_targets(HashSet::from(["artnet:1".to_owned(), "sacn:2".to_owned()])),
        vec![LookupKey::OutputTarget("sacn:2".to_owned())]
    );
}

/// Verifies a lookup change finds only the objects that read it, and re-auditing them keeps the
/// running counts in step with a fresh audit.
#[test]
fn book_reaudits_only_readers_of_changed_lookups() {
    let mut lookup = ReferenceLookup::default();
    lookup.add_fixture(uid(1), 1, 1);
    lookup.add_fixture(uid(2), 2, 1);
    let fixture_source = |fixture: u128| {
        TestSource::selection(SelectionExpr::Resolved(vec![FixtureRef {
            fixture_uid: uid(fixture),
            index: None,
        }]))
    };
    let sources = [
        (owner(ReferenceDomain::Cue, 1), fixture_source(1)),
        (owner(ReferenceDomain::Cue, 2), fixture_source(2)),
    ];
    let mut book = audit_book(&lookup, &sources);
    assert_eq!(book.summary().issue_count, 0);

    let changed = lookup.set_fixture(uid(1), None);
    let readers = book.readers(&changed);
    assert_eq!(
        readers,
        HashSet::from([OwnerKey::of(&owner(ReferenceDomain::Cue, 1))])
    );
    let previous = book.insert(audit_owner(&lookup, sources[0].0.clone(), &sources[0].1));
    assert!(previous.is_some_and(|previous| previous.issues.is_empty()));

    assert_eq!(book.summary(), audit_book(&lookup, &sources).summary());
    assert_eq!(book.summary().affected_object_count, 1);
    assert_eq!(book.summary().prunable_issue_count, 1);

    book.remove(&OwnerKey::of(&sources[0].0));
    assert_eq!(book.summary().object_count, 1);
    assert_eq!(book.summary().issue_count, 0);
    assert!(book.readers(&[LookupKey::FixtureUid(uid(1))]).is_empty());
}

/// Verifies a label shared by several groups resolves to the lowest group ID, and removing that
/// group marks the label changed so its readers move to the next group.
#[test]
fn shared_group_labels_resolve_to_the_lowest_id() {
    let mut lookup = ReferenceLookup::default();
    lookup.add_group(uid(11), 2, "Wash");
    lookup.add_group(uid(10), 1, "Wash");
    let source = TestSource::selection(SelectionExpr::Group(GroupRefExpr::ByLabel(
        "Wash".to_owned(),
    )));
    let cue = owner(ReferenceDomain::Cue, 1);

    let before = audit_owner(&lookup, cue.clone(), &source);
    assert_eq!(before.group_dependencies, BTreeSet::from([uid(10)]));

    let changed = lookup.set_group(uid(10), None);
    assert!(before.lookups.iter().any(|lookup| changed.contains(lookup)));
    let after = audit_owner(&lookup, cue, &source);
    assert_eq!(after.group_dependencies, BTreeSet::from([uid(11)]));
}
