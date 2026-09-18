// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Generic ECS data provider for managing items with identifiers.

use std::sync::RwLock;

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

/// Generic ECS resource for managing items with identifiers.
///
/// Provides storage and lookup by both UUID and numeric ID for any type implementing HasIdentifiers.
/// Thread-safe via DashMap for concurrent access.
#[derive(Resource, Default)]
pub struct DataProvider<T: HasIdentifiers> {
    store: DataStore<T>,
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
        self.store.add(item)
    }

    pub fn remove(&mut self, uuid: &Uuid) -> Result<T, DataStoreError<T>> {
        self.store.remove(uuid)
    }

    pub fn iter(&self) -> Iter<'_, Uuid, T> {
        self.store.data.iter()
    }

    pub fn clear(&mut self) {
        self.store.data.clear();
        self.store.id_index.write().unwrap().clear();
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
            if let Err(e) = self.store.add(elem) {
                tracing::warn!("Failed to add item during extend: {}", e);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal identifier-bearing item used to exercise `DataProvider`.
    #[derive(Clone, Default)]
    struct TestItem {
        identifiers: Identifiers,
    }

    impl HasIdentifiers for TestItem {
        fn identifiers(&self) -> &Identifiers {
            &self.identifiers
        }
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
