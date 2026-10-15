// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Outgoing references held by authored objects, and the audit that checks them.
//!
//! Each object type reports what it references through [`ReferenceSource`]. The
//! [`ReferenceAuditor`] checks every reported reference against a [`ReferenceLookup`] of live
//! fixtures, groups, Blueprints and output targets, and builds a [`ReferenceReport`] with one
//! entry per reference and one issue per missing target.

use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use nightfall::prelude::*;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[cfg(test)]
mod tests;

/// Object families whose references the audit checks.
#[typeshare::typeshare]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReferenceDomain {
    /// Stored groups.
    Group,
    /// Cues.
    Cue,
    /// Sequences, through their setup and release cues.
    Sequence,
    /// Procedural FX.
    Fx,
    /// Step FX.
    StepFx,
    /// Stored FX modules.
    FxModule,
    /// Flows, through selection port defaults.
    Flow,
    /// Masters scoped to a fixture selection.
    Master,
    /// Output patch bindings.
    PatchBinding,
}

impl ReferenceDomain {
    /// Returns the lowercase noun used in dependent descriptions, such as `cue 1 (Look)`.
    fn noun(self) -> &'static str {
        match self {
            ReferenceDomain::Group => "group",
            ReferenceDomain::Cue => "cue",
            ReferenceDomain::Sequence => "sequence",
            ReferenceDomain::Fx => "FX",
            ReferenceDomain::StepFx => "step FX",
            ReferenceDomain::FxModule => "FX module",
            ReferenceDomain::Flow => "flow",
            ReferenceDomain::Master => "master",
            ReferenceDomain::PatchBinding => "output binding",
        }
    }
}

/// Identity of the object that holds a reference.
#[typeshare::typeshare]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReferenceOwner {
    /// Object family of the owner.
    pub domain: ReferenceDomain,
    /// Stable identity of the owner: its UUID, or `output-binding-<index>` for patch bindings.
    pub uid: String,
    /// User-facing numeric ID of the owner.
    pub id: u32,
    /// User-facing label of the owner.
    pub label: String,
}

impl ReferenceOwner {
    /// Describes a showfile object in `domain` by its identifiers.
    pub fn object(domain: ReferenceDomain, identifiers: &Identifiers) -> Self {
        Self {
            domain,
            uid: identifiers.uid.simple().to_string(),
            id: identifiers.id,
            label: identifiers.label.clone(),
        }
    }

    /// Describes the output patch binding at `index` in the output binding list.
    pub fn output_binding(index: usize) -> Self {
        let display_index = index as u32 + 1;
        Self {
            domain: ReferenceDomain::PatchBinding,
            uid: format!("output-binding-{index}"),
            id: display_index,
            label: format!("Output binding {display_index}"),
        }
    }

    /// Returns the short description used in dependency lists and delete-guard errors.
    pub fn description(&self) -> String {
        if self.label.is_empty() || self.domain == ReferenceDomain::PatchBinding {
            format!("{} {}", self.domain.noun(), self.id)
        } else {
            format!("{} {} ({})", self.domain.noun(), self.id, self.label)
        }
    }
}

/// One reference an object holds, as reported by [`ReferenceSource::visit_references`].
#[derive(Clone, Copy, Debug)]
pub enum HeldReference<'a> {
    /// A stored selection; every fixture and group it names is checked.
    Selection(&'a SpatialSelection),
    /// A stable group reference held outside a selection.
    Group(Uuid),
    /// A live Blueprint application.
    Blueprint(Uuid),
    /// An output transport target identifier.
    OutputTarget(&'a str),
}

/// Reports the references an authored object holds.
///
/// Implemented next to each object type, so a new reference-bearing field is reported where it
/// is declared and the audit, prune and group-ref stabilizing pick it up without changes.
pub trait ReferenceSource {
    /// Calls `visit` with the path and value of every reference this object holds.
    ///
    /// Selection paths name the selection itself (for example `instructions[0].selection`); the
    /// audit appends the path inside it.
    fn visit_references(&self, visit: &mut dyn FnMut(&str, HeldReference<'_>));

    /// Calls `visit` with every stored selection, for edits such as pruning or stabilizing.
    fn visit_selections_mut(&mut self, visit: &mut dyn FnMut(&mut SpatialSelection));
}

/// Checked target of one reference, as shown in the References panel.
#[typeshare::typeshare]
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(tag = "type", content = "data")]
pub enum ReferenceTarget {
    /// A fixture or fixture element by user-facing ID.
    Fixture {
        /// Fixture ID.
        fixture_id: u32,
        /// 1-based element index, or none for the whole fixture.
        element_index: Option<u32>,
    },
    /// A fixture UID that matches no patched fixture.
    FixtureUid {
        /// Fixture UID.
        #[serde(with = "nightfall::serde_uuid_simple")]
        #[typeshare(serialized_as = "String")]
        fixture_uid: Uuid,
    },
    /// A group by user-facing ID.
    Group {
        /// Group ID.
        group_id: u32,
    },
    /// A group UID that matches no stored group.
    GroupUid {
        /// Group UID.
        #[serde(with = "nightfall::serde_uuid_simple")]
        #[typeshare(serialized_as = "String")]
        group_uid: Uuid,
    },
    /// A group by label.
    GroupLabel {
        /// Group label.
        label: String,
    },
    /// A Blueprint by UID.
    Blueprint {
        /// Blueprint UID.
        #[serde(with = "nightfall::serde_uuid_simple")]
        #[typeshare(serialized_as = "String")]
        blueprint_uid: Uuid,
    },
    /// An output transport target by identifier.
    OutputTarget {
        /// Output transport target identifier.
        target: String,
    },
}

/// Whether a reference's target exists.
#[typeshare::typeshare]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReferenceStatus {
    /// The target exists.
    Ok,
    /// The target does not exist.
    Missing,
}

/// Why a reference was reported as a health issue.
#[typeshare::typeshare]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReferenceIssueReason {
    /// A resolved fixture UID matches no patched fixture.
    MissingFixtureUid,
    /// A fixture ID matches no patched fixture.
    MissingFixtureId,
    /// A fixture exists but has no element at the referenced index.
    MissingFixtureElement,
    /// A group UID matches no stored group.
    MissingGroupUid,
    /// A group ID matches no stored group.
    MissingGroupId,
    /// A group label matches no stored group.
    MissingGroupLabel,
    /// A Blueprint UID matches no stored Blueprint.
    MissingBlueprintUid,
    /// An output transport target identifier matches no configured output.
    MissingOutputTarget,
}

/// One reference held by an object, with whether its target exists.
#[typeshare::typeshare]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReferenceEntry {
    /// Object holding the reference.
    pub source: ReferenceOwner,
    /// Location of the reference inside the owner, such as `selection.source.Resolved[0]`.
    pub path: String,
    /// Target the reference names.
    pub target: ReferenceTarget,
    /// Whether the target exists.
    pub status: ReferenceStatus,
}

/// One reference whose target is missing.
#[typeshare::typeshare]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReferenceIssue {
    /// Object holding the reference.
    pub source: ReferenceOwner,
    /// Location of the reference inside the owner.
    pub path: String,
    /// Missing target.
    pub target: ReferenceTarget,
    /// Why the reference is an issue.
    pub reason: ReferenceIssueReason,
    /// Whether pruning missing fixture references removes this reference.
    pub prunable: bool,
}

/// Counts across one reference audit.
#[typeshare::typeshare]
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReferenceSummary {
    /// Objects audited.
    pub object_count: u32,
    /// References found.
    pub reference_count: u32,
    /// References whose target is missing.
    pub issue_count: u32,
    /// Issues that pruning missing fixture references repairs.
    pub prunable_issue_count: u32,
    /// Objects with at least one issue.
    pub affected_object_count: u32,
}

/// Result of auditing every reference-bearing object.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ReferenceReport {
    /// Counts across the audit.
    pub summary: ReferenceSummary,
    /// Every reference, ordered by target, owner and path.
    pub references: Vec<ReferenceEntry>,
    /// Every missing reference, ordered by owner, path and target.
    pub issues: Vec<ReferenceIssue>,
    /// Descriptions of the objects that reference each live group, by group UID.
    pub group_dependents: BTreeMap<Uuid, BTreeSet<String>>,
    /// Descriptions of the objects that reference each Blueprint, by Blueprint UID.
    pub blueprint_dependents: BTreeMap<Uuid, BTreeSet<String>>,
}

/// Fixture identity and size as the audit sees it.
#[derive(Clone, Copy, Debug)]
struct LookupFixture {
    id: u32,
    element_count: u32,
}

/// Live targets references are checked against.
#[derive(Clone, Debug, Default)]
pub struct ReferenceLookup {
    fixtures_by_uid: HashMap<Uuid, LookupFixture>,
    fixture_elements_by_id: HashMap<u32, u32>,
    group_ids_by_uid: HashMap<Uuid, u32>,
    group_uids_by_id: HashMap<u32, Uuid>,
    group_uids_by_label: HashMap<String, Uuid>,
    blueprints: HashSet<Uuid>,
    output_targets: HashSet<String>,
}

impl ReferenceLookup {
    /// Registers a patched fixture.
    pub fn add_fixture(&mut self, uid: Uuid, id: u32, element_count: u32) {
        self.fixtures_by_uid
            .insert(uid, LookupFixture { id, element_count });
        self.fixture_elements_by_id.insert(id, element_count);
    }

    /// Registers a stored group. When two groups share a label, the first registered wins.
    pub fn add_group(&mut self, uid: Uuid, id: u32, label: &str) {
        self.group_ids_by_uid.insert(uid, id);
        self.group_uids_by_id.insert(id, uid);
        self.group_uids_by_label
            .entry(label.to_owned())
            .or_insert(uid);
    }

    /// Registers a stored Blueprint.
    pub fn add_blueprint(&mut self, uid: Uuid) {
        self.blueprints.insert(uid);
    }

    /// Registers an output transport target identifier that resolves to a configured output.
    pub fn add_output_target(&mut self, target: impl Into<String>) {
        self.output_targets.insert(target.into());
    }

    /// Returns the element count of the fixture with user-facing `fixture_id`.
    fn fixture_elements(&self, fixture_id: u32) -> Option<u32> {
        self.fixture_elements_by_id.get(&fixture_id).copied()
    }

    /// Returns whether a resolved fixture reference names a live fixture and element.
    pub fn fixture_ref_exists(&self, fixture_ref: &FixtureRef) -> bool {
        self.fixtures_by_uid
            .get(&fixture_ref.fixture_uid)
            .is_some_and(|fixture| {
                fixture_ref
                    .index
                    .is_none_or(|index| element_exists(index, fixture.element_count))
            })
    }
}

/// Returns whether 1-based `index` names an element of a fixture with `element_count` elements.
fn element_exists(index: u32, element_count: u32) -> bool {
    index >= 1 && index <= element_count
}

/// Builds a [`ReferenceReport`] from the objects passed to [`ReferenceAuditor::audit`].
pub struct ReferenceAuditor<'a> {
    lookup: &'a ReferenceLookup,
    report: ReferenceReport,
}

impl<'a> ReferenceAuditor<'a> {
    /// Starts an audit against `lookup`.
    pub fn new(lookup: &'a ReferenceLookup) -> Self {
        Self {
            lookup,
            report: ReferenceReport::default(),
        }
    }

    /// Audits every reference `source` holds, attributing them to `owner`.
    pub fn audit(&mut self, owner: ReferenceOwner, source: &dyn ReferenceSource) {
        self.report.summary.object_count += 1;
        let mut audit = OwnerAudit {
            lookup: self.lookup,
            owner: &owner,
            report: &mut self.report,
        };
        source.visit_references(&mut |path, reference| audit.reference(path, reference));
    }

    /// Sorts the report and fills in its summary.
    pub fn finish(mut self) -> ReferenceReport {
        let report = &mut self.report;
        report.references.sort_by(compare_entries);
        report.issues.sort_by(compare_issues);
        report.summary.reference_count = report.references.len() as u32;
        report.summary.issue_count = report.issues.len() as u32;
        report.summary.prunable_issue_count =
            report.issues.iter().filter(|issue| issue.prunable).count() as u32;
        report.summary.affected_object_count = report
            .issues
            .iter()
            .map(|issue| (issue.source.domain, issue.source.uid.as_str()))
            .collect::<HashSet<_>>()
            .len() as u32;
        self.report
    }
}

/// Audit state for the references of one owner.
struct OwnerAudit<'r> {
    lookup: &'r ReferenceLookup,
    owner: &'r ReferenceOwner,
    report: &'r mut ReferenceReport,
}

impl OwnerAudit<'_> {
    /// Checks one reported reference.
    fn reference(&mut self, path: &str, reference: HeldReference<'_>) {
        match reference {
            HeldReference::Selection(selection) => self.selection(selection, path),
            HeldReference::Group(uid) => self.group(&GroupRefExpr::ByUid { uid }, path),
            HeldReference::Blueprint(blueprint_uid) => {
                let exists = self.lookup.blueprints.contains(&blueprint_uid);
                let target = ReferenceTarget::Blueprint { blueprint_uid };
                self.record(
                    path,
                    target,
                    exists,
                    ReferenceIssueReason::MissingBlueprintUid,
                );
                if exists {
                    self.report
                        .blueprint_dependents
                        .entry(blueprint_uid)
                        .or_default()
                        .insert(self.owner.description());
                }
            }
            HeldReference::OutputTarget(target) => {
                let exists = self.lookup.output_targets.contains(target);
                let target = ReferenceTarget::OutputTarget {
                    target: target.to_owned(),
                };
                self.record(
                    path,
                    target,
                    exists,
                    ReferenceIssueReason::MissingOutputTarget,
                );
            }
        }
    }

    /// Records one reference, and an issue that pruning cannot repair when its target is missing.
    fn record(
        &mut self,
        path: &str,
        target: ReferenceTarget,
        exists: bool,
        reason: ReferenceIssueReason,
    ) {
        self.entry(path, target.clone(), exists);
        if !exists {
            self.issue(path, target, reason, false);
        }
    }

    /// Records one reference row.
    fn entry(&mut self, path: &str, target: ReferenceTarget, exists: bool) {
        self.report.references.push(ReferenceEntry {
            source: self.owner.clone(),
            path: path.to_owned(),
            target,
            status: if exists {
                ReferenceStatus::Ok
            } else {
                ReferenceStatus::Missing
            },
        });
    }

    /// Records one health issue row.
    fn issue(
        &mut self,
        path: &str,
        target: ReferenceTarget,
        reason: ReferenceIssueReason,
        prunable: bool,
    ) {
        self.report.issues.push(ReferenceIssue {
            source: self.owner.clone(),
            path: path.to_owned(),
            target,
            reason,
            prunable,
        });
    }

    /// Audits a spatial selection and every union branch it composes; `path` names the selection.
    fn selection(&mut self, selection: &SpatialSelection, path: &str) {
        self.expr(&selection.source, &format!("{path}.source"));
        for (index, branch) in selection.union.iter().enumerate() {
            self.selection(branch, &format!("{path}.union[{index}]"));
        }
    }

    /// Audits one selection expression and every expression nested in it.
    fn expr(&mut self, expr: &SelectionExpr, path: &str) {
        match expr {
            SelectionExpr::Resolved(fixture_refs) => {
                for (index, fixture_ref) in fixture_refs.iter().enumerate() {
                    self.resolved_fixture(fixture_ref, &format!("{path}.Resolved[{index}]"));
                }
            }
            SelectionExpr::Fixture(fixture_ref) => {
                self.fixture_target(fixture_ref.fixture_id, fixture_ref.element_index, path);
            }
            SelectionExpr::FixtureRange { start, end } => {
                for target in self.expand_fixture_range(start, end) {
                    self.fixture_target(target.fixture_id, target.element_index, path);
                }
            }
            SelectionExpr::FixtureMap { fixtures, elements } => {
                let element_indexes = match elements {
                    ElementSelectorExpr::Single(index) => vec![*index],
                    ElementSelectorExpr::Range { start, end } => inclusive_range(*start, *end),
                };
                for fixture_id in inclusive_range(fixtures.start, fixtures.end) {
                    self.fixture_map_targets(fixture_id, &element_indexes, path);
                }
            }
            SelectionExpr::Group(group_ref) => self.group(group_ref, path),
            SelectionExpr::Add { lhs, rhs } => {
                self.expr(lhs, &format!("{path}.Add.lhs"));
                self.expr(rhs, &format!("{path}.Add.rhs"));
            }
            SelectionExpr::Sub { lhs, rhs } => {
                self.expr(lhs, &format!("{path}.Sub.lhs"));
                self.expr(rhs, &format!("{path}.Sub.rhs"));
            }
            SelectionExpr::Span(inner) => self.expr(inner, &format!("{path}.Span")),
            SelectionExpr::Spatial(selection) => {
                self.selection(selection, &format!("{path}.Spatial"));
            }
        }
    }

    /// Audits one resolved fixture reference, which pruning removes when its target is missing.
    fn resolved_fixture(&mut self, fixture_ref: &FixtureRef, path: &str) {
        let Some(fixture) = self.lookup.fixtures_by_uid.get(&fixture_ref.fixture_uid) else {
            let target = ReferenceTarget::FixtureUid {
                fixture_uid: fixture_ref.fixture_uid,
            };
            self.entry(path, target.clone(), false);
            self.issue(path, target, ReferenceIssueReason::MissingFixtureUid, true);
            return;
        };
        let target = ReferenceTarget::Fixture {
            fixture_id: fixture.id,
            element_index: fixture_ref.index,
        };
        let element_missing = fixture_ref
            .index
            .is_some_and(|index| !element_exists(index, fixture.element_count));
        self.entry(path, target.clone(), !element_missing);
        if element_missing {
            self.issue(
                path,
                target,
                ReferenceIssueReason::MissingFixtureElement,
                true,
            );
        }
    }

    /// Audits one fixture or fixture element named by user-facing ID.
    fn fixture_target(&mut self, fixture_id: u32, element_index: Option<u32>, path: &str) {
        let target = ReferenceTarget::Fixture {
            fixture_id,
            element_index,
        };
        let Some(element_count) = self.lookup.fixture_elements(fixture_id) else {
            self.entry(path, target, false);
            let fixture = ReferenceTarget::Fixture {
                fixture_id,
                element_index: None,
            };
            self.issue(path, fixture, ReferenceIssueReason::MissingFixtureId, false);
            return;
        };
        let element_missing =
            element_index.is_some_and(|index| !element_exists(index, element_count));
        self.entry(path, target.clone(), !element_missing);
        if element_missing {
            self.issue(
                path,
                target,
                ReferenceIssueReason::MissingFixtureElement,
                false,
            );
        }
    }

    /// Audits the elements a fixture map selects on one fixture.
    ///
    /// Every element gets a reference row; a missing fixture gets one issue rather than one per
    /// element.
    fn fixture_map_targets(&mut self, fixture_id: u32, element_indexes: &[u32], path: &str) {
        let element_count = self.lookup.fixture_elements(fixture_id);
        for &element_index in element_indexes {
            let exists = element_count.is_some_and(|count| element_exists(element_index, count));
            self.entry(
                path,
                ReferenceTarget::Fixture {
                    fixture_id,
                    element_index: Some(element_index),
                },
                exists,
            );
            if !exists && element_count.is_some() {
                self.issue(
                    path,
                    ReferenceTarget::Fixture {
                        fixture_id,
                        element_index: Some(element_index),
                    },
                    ReferenceIssueReason::MissingFixtureElement,
                    false,
                );
            }
        }
        if element_count.is_none() {
            self.issue(
                path,
                ReferenceTarget::Fixture {
                    fixture_id,
                    element_index: None,
                },
                ReferenceIssueReason::MissingFixtureId,
                false,
            );
        }
    }

    /// Expands a fixture range into whole-fixture or element targets in traversal order.
    ///
    /// Follows the same rules as selection resolution, except that missing fixtures inside the
    /// range are kept as whole-fixture targets so the audit can report them.
    fn expand_fixture_range(
        &self,
        start: &UnresolvedFixtureRef,
        end: &UnresolvedFixtureRef,
    ) -> Vec<UnresolvedFixtureRef> {
        let reverse = start > end;
        let (lower, upper) = if reverse { (end, start) } else { (start, end) };
        let whole_fixtures = lower.element_index.is_none() && upper.element_index.is_none();
        let mut targets = Vec::new();
        for fixture_id in lower.fixture_id..=upper.fixture_id {
            let element_count = match self.lookup.fixture_elements(fixture_id) {
                Some(element_count) if !whole_fixtures => element_count,
                _ => {
                    targets.push(UnresolvedFixtureRef {
                        fixture_id,
                        element_index: None,
                    });
                    continue;
                }
            };
            let element_start = if fixture_id == lower.fixture_id {
                lower.element_index.unwrap_or(1)
            } else {
                1
            };
            let element_end = if fixture_id == upper.fixture_id {
                upper.element_index.unwrap_or(element_count)
            } else {
                element_count
            };
            if element_start <= element_end {
                targets.extend((element_start..=element_end).map(|element_index| {
                    UnresolvedFixtureRef {
                        fixture_id,
                        element_index: Some(element_index),
                    }
                }));
                continue;
            }
            if fixture_id == lower.fixture_id && lower.element_index.is_some() {
                targets.push(UnresolvedFixtureRef {
                    fixture_id,
                    element_index: lower.element_index,
                });
            }
            if fixture_id == upper.fixture_id
                && upper.element_index.is_some()
                && upper.element_index != lower.element_index
            {
                targets.push(UnresolvedFixtureRef {
                    fixture_id,
                    element_index: upper.element_index,
                });
            }
        }
        if reverse {
            targets.reverse();
        }
        targets
    }

    /// Audits one group reference expression and every expression nested in it.
    fn group(&mut self, group_ref: &GroupRefExpr, path: &str) {
        match group_ref {
            GroupRefExpr::ByUid { uid } => match self.lookup.group_ids_by_uid.get(uid) {
                Some(&group_id) => self.live_group(*uid, group_id, path),
                None => {
                    let target = ReferenceTarget::GroupUid { group_uid: *uid };
                    self.record(path, target, false, ReferenceIssueReason::MissingGroupUid);
                }
            },
            GroupRefExpr::ById(group_id) => self.group_by_id(*group_id, path),
            GroupRefExpr::RangeById { start, end } => {
                for group_id in inclusive_range(*start, *end) {
                    self.group_by_id(group_id, path);
                }
            }
            GroupRefExpr::ByLabel(label) => match self.lookup.group_uids_by_label.get(label) {
                Some(&uid) => {
                    let target = ReferenceTarget::GroupLabel {
                        label: label.clone(),
                    };
                    self.entry(path, target, true);
                    self.add_group_dependent(uid);
                }
                None => {
                    let target = ReferenceTarget::GroupLabel {
                        label: label.clone(),
                    };
                    self.record(path, target, false, ReferenceIssueReason::MissingGroupLabel);
                }
            },
            GroupRefExpr::MissingById(group_id) => {
                let target = ReferenceTarget::Group {
                    group_id: *group_id,
                };
                self.record(path, target, false, ReferenceIssueReason::MissingGroupId);
            }
            GroupRefExpr::MissingByLabel(label) => {
                let target = ReferenceTarget::GroupLabel {
                    label: label.clone(),
                };
                self.record(path, target, false, ReferenceIssueReason::MissingGroupLabel);
            }
            GroupRefExpr::Add { lhs, rhs } | GroupRefExpr::Sub { lhs, rhs } => {
                self.group(lhs, path);
                self.group(rhs, path);
            }
            GroupRefExpr::Span(inner) => self.group(inner, path),
        }
    }

    /// Audits one group named by user-facing ID.
    fn group_by_id(&mut self, group_id: u32, path: &str) {
        match self.lookup.group_uids_by_id.get(&group_id) {
            Some(&uid) => self.live_group(uid, group_id, path),
            None => {
                let target = ReferenceTarget::Group { group_id };
                self.record(path, target, false, ReferenceIssueReason::MissingGroupId);
            }
        }
    }

    /// Records a reference to a live group and the owner as one of its dependents.
    fn live_group(&mut self, uid: Uuid, group_id: u32, path: &str) {
        self.entry(path, ReferenceTarget::Group { group_id }, true);
        self.add_group_dependent(uid);
    }

    /// Records the owner as a dependent of the group, unless the owner is that group.
    fn add_group_dependent(&mut self, uid: Uuid) {
        if self.owner.domain == ReferenceDomain::Group && self.owner.uid == uid.simple().to_string()
        {
            return;
        }
        self.report
            .group_dependents
            .entry(uid)
            .or_default()
            .insert(self.owner.description());
    }
}

/// Returns every integer from `start` to `end` inclusive, counting down when `start > end`.
fn inclusive_range(start: u32, end: u32) -> Vec<u32> {
    if start <= end {
        (start..=end).collect()
    } else {
        (end..=start).rev().collect()
    }
}

/// Orders references by target, owner domain, owner ID and path.
fn compare_entries(left: &ReferenceEntry, right: &ReferenceEntry) -> Ordering {
    left.target
        .cmp(&right.target)
        .then_with(|| left.source.domain.cmp(&right.source.domain))
        .then_with(|| left.source.id.cmp(&right.source.id))
        .then_with(|| left.path.cmp(&right.path))
}

/// Orders issues by owner domain, owner ID, path and target.
fn compare_issues(left: &ReferenceIssue, right: &ReferenceIssue) -> Ordering {
    left.source
        .domain
        .cmp(&right.source.domain)
        .then_with(|| left.source.id.cmp(&right.source.id))
        .then_with(|| left.path.cmp(&right.path))
        .then_with(|| left.target.cmp(&right.target))
}

/// Removes resolved fixture references whose fixture or element is missing from `selection`,
/// including nested expressions and union branches. Returns how many references were removed.
pub fn prune_missing_fixture_refs(
    selection: &mut SpatialSelection,
    lookup: &ReferenceLookup,
) -> usize {
    let mut pruned = prune_expr(&mut selection.source, lookup);
    for branch in &mut selection.union {
        pruned += prune_missing_fixture_refs(branch, lookup);
    }
    pruned
}

/// Removes missing resolved fixture references from one expression and its children.
fn prune_expr(expr: &mut SelectionExpr, lookup: &ReferenceLookup) -> usize {
    match expr {
        SelectionExpr::Resolved(fixture_refs) => {
            let before = fixture_refs.len();
            fixture_refs.retain(|fixture_ref| lookup.fixture_ref_exists(fixture_ref));
            before - fixture_refs.len()
        }
        SelectionExpr::Add { lhs, rhs } | SelectionExpr::Sub { lhs, rhs } => {
            prune_expr(lhs, lookup) + prune_expr(rhs, lookup)
        }
        SelectionExpr::Span(inner) => prune_expr(inner, lookup),
        SelectionExpr::Spatial(selection) => prune_missing_fixture_refs(selection, lookup),
        SelectionExpr::Fixture(_)
        | SelectionExpr::FixtureRange { .. }
        | SelectionExpr::FixtureMap { .. }
        | SelectionExpr::Group(_) => 0,
    }
}

/// Reports the stored selection of a group.
impl ReferenceSource for Group {
    fn visit_references(&self, visit: &mut dyn FnMut(&str, HeldReference<'_>)) {
        visit("selection", HeldReference::Selection(&self.selection));
    }

    fn visit_selections_mut(&mut self, visit: &mut dyn FnMut(&mut SpatialSelection)) {
        visit(&mut self.selection);
    }
}
