// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Generic ECS data provider for managing items with identifiers.

use std::collections::HashMap;
use std::sync::RwLock;
use std::sync::atomic::{AtomicU64, Ordering};

use bevy_ecs::prelude::*;
use bimap::BiMap;
use dashmap::{DashMap, iter::Iter};
use nightfall::prelude::*;
use thiserror::Error;
use uuid::Uuid;

/// Lookup and uniqueness failures reported by an identifier-backed data store.
#[derive(Debug, Error)]
pub enum DataStoreError<T> {
    #[error("{type_name} with UUID {id} is not in the data store")]
    NoSuchItem {
        id: Uuid,
        type_name: &'static str,
        #[source]
        _marker: std::marker::PhantomData<T>,
    },

    #[error("{type_name} with ID {id} is not in the data store")]
    NoSuchId {
        id: u32,
        type_name: &'static str,
        #[source]
        _marker: std::marker::PhantomData<T>,
    },

    #[error("{type_name} with ID {id} already exists")]
    DuplicateId {
        id: u32,
        type_name: &'static str,
        #[source]
        _marker: std::marker::PhantomData<T>,
    },
}

impl<T> DataStoreError<T> {
    pub fn no_such_item(id: Uuid) -> Self {
        Self::NoSuchItem {
            id,
            type_name: std::any::type_name::<T>(),
            _marker: std::marker::PhantomData,
        }
    }

    pub fn no_such_id(id: u32) -> Self {
        Self::NoSuchId {
            id,
            type_name: std::any::type_name::<T>(),
            _marker: std::marker::PhantomData,
        }
    }

    pub fn duplicate_id(id: u32) -> Self {
        Self::DuplicateId {
            id,
            type_name: std::any::type_name::<T>(),
            _marker: std::marker::PhantomData,
        }
    }
}

/// Thread-safe storage for items keyed by UUID with an optional numeric ID index.
#[derive(Default)]
struct DataStore<T> {
    data: DashMap<Uuid, T>,
    id_index: RwLock<BiMap<Uuid, u32>>,
}

impl<T> DataStore<T> {
    /// Look up an item by UUID and return a reference to it.
    fn lookup(
        &self,
        id: &Uuid,
    ) -> Result<dashmap::mapref::one::Ref<'_, Uuid, T>, DataStoreError<T>> {
        self.data
            .get(id)
            .ok_or_else(|| DataStoreError::no_such_item(*id))
    }
}

impl<T: HasIdentifiers> DataStore<T> {
    /// Checks whether an item can be added without mutating either index.
    fn validate_add(&self, item: &T) -> Result<(), DataStoreError<T>> {
        let id = item.identifiers().id;
        let uid = item.identifiers().uid;

        if T::requires_unique_id() {
            let id_index = self.id_index.read().unwrap();
            if let Some(existing_uid) = id_index.get_by_right(&id)
                && *existing_uid != uid
            {
                return Err(DataStoreError::duplicate_id(id));
            }
        }

        Ok(())
    }

    /// Adds an item after enforcing identifier uniqueness.
    fn add(&mut self, item: T) -> Result<(), DataStoreError<T>> {
        let id = item.identifiers().id;
        let uid = item.identifiers().uid;

        self.validate_add(&item)?;

        tracing::trace!("Aliasing {} {} as {}", std::any::type_name::<T>(), uid, id);

        self.id_index.write().unwrap().insert(uid, id);
        self.data.insert(uid, item);
        Ok(())
    }

    fn remove(&mut self, id: &Uuid) -> Result<T, DataStoreError<T>> {
        tracing::trace!("Deleting {} {}", std::any::type_name::<T>(), id);

        let (_, item) = self
            .data
            .remove(id)
            .ok_or_else(|| DataStoreError::no_such_item(*id))?;
        self.id_index.write().unwrap().remove_by_left(id);
        Ok(item)
    }

    fn item_by_id(
        &self,
        id: &u32,
    ) -> Result<dashmap::mapref::one::Ref<'_, Uuid, T>, DataStoreError<T>> {
        let map = self.id_index.read().unwrap();
        map.get_by_right(id)
            .map(|uuid| self.lookup(uuid))
            .unwrap_or_else(|| Err(DataStoreError::no_such_id(*id)))
    }
}

/// Source of journal identities, so a replaced provider never matches a revision of the old one.
static NEXT_JOURNAL: AtomicU64 = AtomicU64::new(1);

/// A point in one data provider's change history, as returned by [`DataProvider::revision`].
///
/// The default revision matches no provider, so the first [`DataProvider::changes_since`] call
/// for it reports [`DataChanges::All`].
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DataRevision {
    /// Identity of the provider instance the revision belongs to.
    journal: u64,
    /// Number of mutations the provider had applied.
    revision: u64,
}

/// Items of a data provider that changed after a [`DataRevision`].
#[derive(Debug, PartialEq, Eq)]
pub enum DataChanges {
    /// The provider was cleared or replaced, so every item must be treated as changed.
    All,
    /// UUIDs of items added, replaced or removed, in no particular order.
    Items(Vec<Uuid>),
}

/// Records which items changed at which revision, so consumers can process only those items.
struct ChangeJournal {
    /// Identity of this journal, unique per provider instance.
    journal: u64,
    /// Count of mutations applied so far.
    revision: u64,
    /// Revision of the last clear; changes at or before it are covered by [`DataChanges::All`].
    cleared_at: u64,
    /// Revision at which each item last changed, including removed items.
    changed_at: HashMap<Uuid, u64>,
}

impl Default for ChangeJournal {
    /// Starts an empty journal with a process-unique identity.
    fn default() -> Self {
        Self {
            journal: NEXT_JOURNAL.fetch_add(1, Ordering::Relaxed),
            revision: 0,
            cleared_at: 0,
            changed_at: HashMap::new(),
        }
    }
}

impl ChangeJournal {
    /// Records a change to one item.
    fn record(&mut self, uid: Uuid) {
        self.revision += 1;
        self.changed_at.insert(uid, self.revision);
    }

    /// Records that every item changed.
    fn record_clear(&mut self) {
        self.revision += 1;
        self.cleared_at = self.revision;
        self.changed_at.clear();
    }
}

/// Generic ECS resource for managing items with identifiers.
///
/// Provides storage and lookup by both UUID and numeric ID for any type implementing HasIdentifiers.
/// Thread-safe via DashMap for concurrent access. Every mutation is journaled, so systems that
/// derive state from the items can update only what changed (see [`DataProvider::changes_since`]).
#[derive(Resource, Default)]
pub struct DataProvider<T: HasIdentifiers> {
    store: DataStore<T>,
    journal: ChangeJournal,
}

impl<T: HasIdentifiers> DataProvider<T> {
    /// Validates an add operation without changing stored data or indexes.
    pub fn validate_add(&self, item: &T) -> Result<(), DataStoreError<T>> {
        self.store.validate_add(item)
    }

    pub fn get(
        &self,
        uuid: Uuid,
    ) -> Result<dashmap::mapref::one::Ref<'_, Uuid, T>, DataStoreError<T>> {
        self.store.lookup(&uuid)
    }

    pub fn add(&mut self, item: T) -> Result<(), DataStoreError<T>> {
        let uid = item.identifiers().uid;
        self.store.add(item)?;
        self.journal.record(uid);
        Ok(())
    }

    pub fn remove(&mut self, uuid: &Uuid) -> Result<T, DataStoreError<T>> {
        let item = self.store.remove(uuid)?;
        self.journal.record(*uuid);
        Ok(item)
    }

    pub fn iter(&self) -> Iter<'_, Uuid, T> {
        self.store.data.iter()
    }

    pub fn clear(&mut self) {
        self.store.data.clear();
        self.store.id_index.write().unwrap().clear();
        self.journal.record_clear();
    }

    /// Returns the current point in this provider's change history.
    pub fn revision(&self) -> DataRevision {
        DataRevision {
            journal: self.journal.journal,
            revision: self.journal.revision,
        }
    }

    /// Returns the items added, replaced or removed after `since`.
    ///
    /// Reports [`DataChanges::All`] when `since` belongs to another provider instance (such as
    /// the default revision, or a provider that was since replaced) or the provider was cleared
    /// after it.
    pub fn changes_since(&self, since: DataRevision) -> DataChanges {
        let journal = &self.journal;
        if since.journal != journal.journal || journal.cleared_at > since.revision {
            return DataChanges::All;
        }
        if since.revision == journal.revision {
            return DataChanges::Items(Vec::new());
        }
        DataChanges::Items(
            journal
                .changed_at
                .iter()
                .filter(|(_, revision)| **revision > since.revision)
                .map(|(uid, _)| *uid)
                .collect(),
        )
    }

    pub fn from_id(
        &self,
        id: u32,
    ) -> Result<dashmap::mapref::one::Ref<'_, Uuid, T>, DataStoreError<T>> {
        self.store.item_by_id(&id)
    }
}

impl<T: HasIdentifiers + Clone> Extend<T> for DataProvider<T> {
    fn extend<I: IntoIterator<Item = T>>(&mut self, iter: I) {
        for elem in iter {
            if let Err(e) = self.add(elem) {
                tracing::warn!("Failed to add item during extend: {}", e);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal identifier-bearing item used to exercise `DataProvider`.
    #[derive(Clone, Debug, Default)]
    struct TestItem {
        identifiers: Identifiers,
    }

    impl HasIdentifiers for TestItem {
        fn identifiers(&self) -> &Identifiers {
            &self.identifiers
        }
    }

    /// Builds a test item with `id` and a UID derived from it.
    fn item(id: u32) -> TestItem {
        TestItem {
            identifiers: Identifiers {
                id,
                uid: Uuid::from_u128(u128::from(id)),
                label: String::new(),
            },
        }
    }

    /// Verifies the journal reports added, replaced and removed items after a revision, and
    /// nothing for an unchanged provider.
    #[test]
    fn changes_since_lists_items_changed_after_a_revision() {
        let mut provider = DataProvider::<TestItem>::default();
        provider.add(item(1)).unwrap();
        provider.add(item(2)).unwrap();
        let revision = provider.revision();
        assert_eq!(provider.changes_since(revision), DataChanges::Items(vec![]));

        provider.add(item(2)).unwrap();
        provider.add(item(3)).unwrap();
        provider.remove(&Uuid::from_u128(1)).unwrap();
        let DataChanges::Items(mut changed) = provider.changes_since(revision) else {
            panic!("expected item changes");
        };
        changed.sort();
        assert_eq!(
            changed,
            vec![Uuid::from_u128(1), Uuid::from_u128(2), Uuid::from_u128(3)]
        );
    }

    /// Verifies a cleared provider, a replaced provider and the default revision all report
    /// every item as changed, and that failed adds record nothing.
    #[test]
    fn changes_since_reports_all_after_clear_or_replacement() {
        let mut provider = DataProvider::<TestItem>::default();
        assert_eq!(
            provider.changes_since(DataRevision::default()),
            DataChanges::All
        );
        provider.add(item(1)).unwrap();
        let revision = provider.revision();
        let mut duplicate = item(1);
        duplicate.identifiers.uid = Uuid::from_u128(9);
        assert!(provider.add(duplicate).is_err());
        assert_eq!(provider.changes_since(revision), DataChanges::Items(vec![]));

        provider.clear();
        assert_eq!(provider.changes_since(revision), DataChanges::All);
        let replacement = DataProvider::<TestItem>::default();
        assert_eq!(replacement.changes_since(revision), DataChanges::All);
    }

    #[test]
    fn test_add_item_succeeds() {
        let mut provider = DataProvider::<TestItem>::default();
        let item = TestItem {
            identifiers: Identifiers {
                id: 1,
                uid: Uuid::new_v4(),
                label: "test".to_string(),
            },
        };
        assert!(provider.add(item).is_ok());
    }

    #[test]
    fn test_add_duplicate_id_fails() {
        let mut provider = DataProvider::<TestItem>::default();
        let item1 = TestItem {
            identifiers: Identifiers {
                id: 1,
                uid: Uuid::new_v4(),
                label: "item1".to_string(),
            },
        };
        let item2 = TestItem {
            identifiers: Identifiers {
                id: 1,               // Same ID
                uid: Uuid::new_v4(), // Different UID
                label: "item2".to_string(),
            },
        };

        assert!(provider.add(item1).is_ok());
        let result = provider.add(item2);
        assert!(result.is_err());
        assert!(matches!(
            result.unwrap_err(),
            DataStoreError::DuplicateId { id: 1, .. }
        ));
    }

    #[test]
    fn test_update_same_uid_succeeds() {
        let mut provider = DataProvider::<TestItem>::default();
        let uid = Uuid::new_v4();
        let item1 = TestItem {
            identifiers: Identifiers {
                id: 1,
                uid,
                label: "item1".to_string(),
            },
        };
        let item2 = TestItem {
            identifiers: Identifiers {
                id: 2, // Different ID
                uid,   // Same UID (update)
                label: "item1_updated".to_string(),
            },
        };

        assert!(provider.add(item1).is_ok());
        assert!(provider.add(item2).is_ok()); // Should succeed - updating existing item
    }

    /// Test type that opts out of unique ID validation (like Cue)
    #[derive(Clone, Default)]
    struct ScopedIdItem {
        identifiers: Identifiers,
    }

    impl HasIdentifiers for ScopedIdItem {
        fn identifiers(&self) -> &Identifiers {
            &self.identifiers
        }

        fn requires_unique_id() -> bool {
            false
        }
    }

    #[test]
    fn test_duplicate_id_allowed_when_opted_out() {
        let mut provider = DataProvider::<ScopedIdItem>::default();
        let item1 = ScopedIdItem {
            identifiers: Identifiers {
                id: 1,
                uid: Uuid::new_v4(),
                label: "item1".to_string(),
            },
        };
        let item2 = ScopedIdItem {
            identifiers: Identifiers {
                id: 1,               // Same ID
                uid: Uuid::new_v4(), // Different UID
                label: "item2".to_string(),
            },
        };

        assert!(provider.add(item1).is_ok());
        assert!(provider.add(item2).is_ok()); // Should succeed - type opts out of unique ID check
    }
}
