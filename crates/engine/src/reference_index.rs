// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Reverse dependency indexes that delete guards and dependency lists read.

use std::collections::{HashMap, HashSet};
use std::marker::PhantomData;

use bevy_ecs::prelude::*;
use nightfall::prelude::{Blueprint, Group};
use uuid::Uuid;

/// Tracks which authored objects currently reference each object of type `T`, by its UID.
///
/// Several subsystems feed one index, each replacing only the dependents it reported, so a
/// live programmer and stored showfile objects can protect the same target.
#[derive(Debug, Resource)]
pub struct ReferenceIndex<T: Send + Sync + 'static> {
    references: HashMap<Uuid, HashSet<String>>,
    target: PhantomData<fn() -> T>,
}

/// Objects that reference each Blueprint.
pub type BlueprintReferenceIndex = ReferenceIndex<Blueprint>;

/// Objects that reference each group.
pub type GroupReferenceIndex = ReferenceIndex<Group>;

impl<T: Send + Sync + 'static> Default for ReferenceIndex<T> {
    /// Builds an index with no dependents.
    fn default() -> Self {
        Self {
            references: HashMap::new(),
            target: PhantomData,
        }
    }
}

impl<T: Send + Sync + 'static> ReferenceIndex<T> {
    /// Replaces every dependency reported by one indexing subsystem.
    pub fn replace_source(
        &mut self,
        source: &str,
        references: impl IntoIterator<Item = (Uuid, String)>,
    ) {
        let prefix = format!("{source}:");
        self.references.retain(|_, dependents| {
            dependents.retain(|dependent| !dependent.starts_with(&prefix));
            !dependents.is_empty()
        });
        for (uid, dependent) in references {
            self.references
                .entry(uid)
                .or_default()
                .insert(format!("{prefix}{dependent}"));
        }
    }

    /// Returns sorted descriptions of objects that reference one target.
    pub fn dependents(&self, uid: Uuid) -> Vec<String> {
        let mut dependents = self
            .references
            .get(&uid)
            .into_iter()
            .flatten()
            .cloned()
            .collect::<Vec<_>>();
        dependents.sort();
        dependents
    }

    /// Returns every indexed dependency in stable UUID and description order.
    pub fn snapshot(&self) -> Vec<(Uuid, Vec<String>)> {
        let mut entries = self
            .references
            .keys()
            .copied()
            .map(|uid| (uid, self.dependents(uid)))
            .collect::<Vec<_>>();
        entries.sort_by_key(|(uid, _)| *uid);
        entries
    }
}
