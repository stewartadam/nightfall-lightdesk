// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Show-wide collection of per-object reference audits, updated one object at a time.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;

use uuid::Uuid;

use super::{
    LookupKey, OwnerReferences, ReferenceDomain, ReferenceIssue, ReferenceOwner, ReferenceSummary,
    compare_issues,
};

/// Identity of one audited object in a [`ReferenceBook`].
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct OwnerKey {
    /// Object family of the owner.
    pub domain: ReferenceDomain,
    /// Stable identity of the owner, as in [`ReferenceOwner::uid`].
    pub uid: Arc<str>,
}

impl OwnerKey {
    /// Builds the key of the object `uid` in `domain`.
    pub fn new(domain: ReferenceDomain, uid: &str) -> Self {
        Self {
            domain,
            uid: Arc::from(uid),
        }
    }

    /// Builds the key of the object an owner describes.
    pub fn of(owner: &ReferenceOwner) -> Self {
        Self::new(owner.domain, &owner.uid)
    }
}

/// Latest audit of every reference-bearing object, with running counts and an index of which
/// objects read which lookup entries.
///
/// Callers re-audit an object when it changes, or when a lookup entry it read changes (see
/// [`ReferenceBook::readers`]), and store the result with [`ReferenceBook::insert`].
#[derive(Debug, Default)]
pub struct ReferenceBook {
    /// Audit of each object.
    owners: BTreeMap<OwnerKey, OwnerReferences>,
    /// Objects whose audit read each lookup entry.
    readers: HashMap<LookupKey, HashSet<OwnerKey>>,
    /// Counts across every stored audit.
    summary: ReferenceSummary,
}

impl ReferenceBook {
    /// Stores the audit of one object, replacing and returning its previous audit.
    pub fn insert(&mut self, references: OwnerReferences) -> Option<OwnerReferences> {
        let key = OwnerKey::of(&references.owner);
        self.count(&references, true);
        let previous = self.owners.insert(key.clone(), references);
        let current = &self.owners[&key];
        let empty = HashSet::new();
        let previous_lookups = previous
            .as_ref()
            .map_or(&empty, |previous| &previous.lookups);
        for lookup in current.lookups.difference(previous_lookups) {
            self.readers
                .entry(lookup.clone())
                .or_default()
                .insert(key.clone());
        }
        if let Some(previous) = &previous {
            for lookup in previous.lookups.difference(&current.lookups) {
                remove_reader(&mut self.readers, lookup, &key);
            }
            self.count(previous, false);
        }
        previous
    }

    /// Removes and returns the audit of one object.
    pub fn remove(&mut self, key: &OwnerKey) -> Option<OwnerReferences> {
        let previous = self.owners.remove(key)?;
        for lookup in &previous.lookups {
            remove_reader(&mut self.readers, lookup, key);
        }
        self.count(&previous, false);
        Some(previous)
    }

    /// Removes every audit `keep` rejects, returning the removed audits.
    pub fn retain(&mut self, mut keep: impl FnMut(&OwnerKey) -> bool) -> Vec<OwnerReferences> {
        let stale = self
            .owners
            .keys()
            .filter(|key| !keep(key))
            .cloned()
            .collect::<Vec<_>>();
        stale.iter().filter_map(|key| self.remove(key)).collect()
    }

    /// Returns the audit of one object.
    pub fn get(&self, key: &OwnerKey) -> Option<&OwnerReferences> {
        self.owners.get(key)
    }

    /// Returns the keys of the stored audits in `domain`.
    pub fn keys_in(&self, domain: ReferenceDomain) -> impl Iterator<Item = &OwnerKey> {
        self.owners.keys().filter(move |key| key.domain == domain)
    }

    /// Returns every stored audit, ordered by owner domain and UID.
    pub fn owners(&self) -> impl Iterator<Item = &OwnerReferences> {
        self.owners.values()
    }

    /// Returns the objects whose audit read any of `lookups`.
    pub fn readers<'a>(
        &self,
        lookups: impl IntoIterator<Item = &'a LookupKey>,
    ) -> HashSet<OwnerKey> {
        lookups
            .into_iter()
            .filter_map(|lookup| self.readers.get(lookup))
            .flatten()
            .cloned()
            .collect()
    }

    /// Returns the counts across every stored audit.
    pub fn summary(&self) -> &ReferenceSummary {
        &self.summary
    }

    /// Returns every missing reference, ordered by owner domain, owner ID, path and target.
    pub fn issues(&self) -> Vec<ReferenceIssue> {
        let mut issues = self
            .owners
            .values()
            .flat_map(|owner| owner.issues.iter().cloned())
            .collect::<Vec<_>>();
        issues.sort_by(compare_issues);
        issues
    }

    /// Returns `(group UID, dependent description)` for every live group an object references.
    pub fn group_dependents(&self) -> Vec<(Uuid, String)> {
        self.dependents(|owner| &owner.group_dependencies)
    }

    /// Returns `(Blueprint UID, dependent description)` for every live Blueprint an object
    /// references.
    pub fn blueprint_dependents(&self) -> Vec<(Uuid, String)> {
        self.dependents(|owner| &owner.blueprint_dependencies)
    }

    /// Pairs each dependency `select` returns with the description of the object holding it.
    fn dependents(
        &self,
        select: impl Fn(&OwnerReferences) -> &std::collections::BTreeSet<Uuid>,
    ) -> Vec<(Uuid, String)> {
        self.owners
            .values()
            .flat_map(|owner| {
                let description = owner.owner.description();
                select(owner)
                    .iter()
                    .map(move |uid| (*uid, description.clone()))
            })
            .collect()
    }

    /// Adds one audit to the running counts, or subtracts it when `add` is false.
    fn count(&mut self, references: &OwnerReferences, add: bool) {
        let summary = &mut self.summary;
        let prunable = references
            .issues
            .iter()
            .filter(|issue| issue.prunable)
            .count() as u32;
        let affected = u32::from(!references.issues.is_empty());
        let deltas = [
            (&mut summary.object_count, 1),
            (
                &mut summary.reference_count,
                references.references.len() as u32,
            ),
            (&mut summary.issue_count, references.issues.len() as u32),
            (&mut summary.prunable_issue_count, prunable),
            (&mut summary.affected_object_count, affected),
        ];
        for (count, delta) in deltas {
            if add {
                *count += delta;
            } else {
                *count -= delta;
            }
        }
    }
}

/// Removes `key` from the readers of `lookup`, dropping the entry once nobody reads it.
fn remove_reader(
    readers: &mut HashMap<LookupKey, HashSet<OwnerKey>>,
    lookup: &LookupKey,
    key: &OwnerKey,
) {
    if let Some(owners) = readers.get_mut(lookup) {
        owners.remove(key);
        if owners.is_empty() {
            readers.remove(lookup);
        }
    }
}
