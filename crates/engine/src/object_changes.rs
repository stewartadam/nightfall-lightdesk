// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Per-object change messages published from [`DataProvider`] change journals.
//!
//! A domain that stores objects in a [`DataProvider`] calls
//! [`ObjectChangesAppExt::publish_object_changes`] once. Every frame, after event handling, a
//! generic system reads the provider's journal and writes one [`ObjectChanged`] message per
//! object added, replaced, or removed that frame. Owners never emit change messages by hand, so
//! a mutation path can't forget to notify the objects that depend on it.

use std::{fmt, marker::PhantomData};

use bevy_app::prelude::*;
use bevy_ecs::prelude::*;
use nightfall::prelude::*;
use uuid::Uuid;

use crate::{
    EventHandling,
    data_provider::{DataChanges, DataProvider, DataRevision},
};

/// Reports that the object with this uid was added, replaced, or removed in its [`DataProvider`].
///
/// When the provider is cleared or replaced, such as on showfile load, every object it holds
/// afterwards is reported; objects the clear removed are not.
#[derive(Message)]
pub struct ObjectChanged<T: Send + Sync + 'static> {
    /// Stable identity of the object that changed.
    pub uid: Uuid,
    /// Ties the message to the object type without storing one.
    marker: PhantomData<fn() -> T>,
}

impl<T: Send + Sync + 'static> ObjectChanged<T> {
    /// Creates a change message for the object with `uid`.
    pub fn new(uid: Uuid) -> Self {
        Self {
            uid,
            marker: PhantomData,
        }
    }
}

impl<T: Send + Sync + 'static> Clone for ObjectChanged<T> {
    /// Copies the uid; the type marker carries no data.
    fn clone(&self) -> Self {
        Self::new(self.uid)
    }
}

impl<T: Send + Sync + 'static> fmt::Debug for ObjectChanged<T> {
    /// Formats the message with the object type name, since the marker has no value to show.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ObjectChanged")
            .field("type", &std::any::type_name::<T>())
            .field("uid", &self.uid)
            .finish()
    }
}

/// `Update` system set in which [`ObjectChanged`] messages are written.
///
/// Runs after [`EventHandling`], so every command and operation applied that frame is reported
/// in the same frame. Consumers order themselves after this set.
#[derive(SystemSet, Debug, Clone, PartialEq, Eq, Hash)]
pub struct ObjectChangePublication;

/// Marks an object type whose changes are already published, so registration runs once.
#[derive(Resource)]
struct ObjectChangesPublished<T: Send + Sync + 'static>(PhantomData<fn() -> T>);

impl<T: Send + Sync + 'static> Default for ObjectChangesPublished<T> {
    /// Creates the marker; it holds no data.
    fn default() -> Self {
        Self(PhantomData)
    }
}

/// App extension that publishes [`ObjectChanged`] messages for a stored object type.
pub trait ObjectChangesAppExt {
    /// Registers [`ObjectChanged<T>`] and the system that writes it from the
    /// [`DataProvider<T>`] journal. Calling it again for the same type does nothing.
    fn publish_object_changes<T: HasIdentifiers + Send + Sync + 'static>(&mut self) -> &mut Self;
}

impl ObjectChangesAppExt for App {
    /// Adds the message and its publishing system once per object type.
    fn publish_object_changes<T: HasIdentifiers + Send + Sync + 'static>(&mut self) -> &mut Self {
        if self
            .world()
            .contains_resource::<ObjectChangesPublished<T>>()
        {
            return self;
        }
        self.init_resource::<ObjectChangesPublished<T>>();
        self.add_message::<ObjectChanged<T>>();
        self.configure_sets(Update, ObjectChangePublication.after(EventHandling));
        self.add_systems(
            Update,
            publish_object_changes::<T>.in_set(ObjectChangePublication),
        );
        self
    }
}

/// Writes one [`ObjectChanged`] per object that changed in the provider since the last run.
///
/// The first run that sees the provider, and any run after the provider was cleared or
/// replaced, reports every object it holds. Objects removed by a clear are not reported, since
/// the journal does not keep them. Does nothing while the provider resource is absent.
fn publish_object_changes<T: HasIdentifiers + Send + Sync + 'static>(
    provider: Option<Res<DataProvider<T>>>,
    mut published: Local<DataRevision>,
    mut changes: MessageWriter<ObjectChanged<T>>,
) {
    let Some(provider) = provider else {
        return;
    };
    let revision = provider.revision();
    let since = std::mem::replace(&mut *published, revision);
    if since == revision {
        return;
    }
    match provider.changes_since(since) {
        DataChanges::All => changes.write_batch(
            provider
                .iter()
                .map(|entry| ObjectChanged::new(*entry.key())),
        ),
        DataChanges::Items(uids) => changes.write_batch(uids.into_iter().map(ObjectChanged::new)),
    };
}

#[cfg(test)]
mod tests {
    use nightfall::prelude::Identifiers;

    use super::*;

    /// Minimal stored object for journal-driven change tests.
    #[derive(Clone, Debug, Default)]
    struct TestObject {
        identifiers: Identifiers,
    }

    impl HasIdentifiers for TestObject {
        /// Returns the object's identifiers.
        fn identifiers(&self) -> &Identifiers {
            &self.identifiers
        }
    }

    /// Builds an object with a fresh uid and the given numeric id.
    fn object(id: u32) -> TestObject {
        TestObject {
            identifiers: Identifiers {
                id,
                uid: Uuid::new_v4(),
                ..Default::default()
            },
        }
    }

    /// Builds an app that publishes changes for [`TestObject`].
    fn app() -> App {
        let mut app = App::new();
        app.init_resource::<DataProvider<TestObject>>();
        app.publish_object_changes::<TestObject>();
        app.update();
        app
    }

    /// Returns the uids reported since the last drain.
    fn drain(app: &mut App) -> Vec<Uuid> {
        app.world_mut()
            .resource_mut::<Messages<ObjectChanged<TestObject>>>()
            .drain()
            .map(|change| change.uid)
            .collect()
    }

    /// Adds, replaces, and removes are each reported once, in the frame they happen.
    #[test]
    fn reports_each_mutated_object_once_per_frame() {
        let mut app = app();
        let first = object(1);
        let uid = first.identifiers.uid;
        {
            let mut provider = app.world_mut().resource_mut::<DataProvider<TestObject>>();
            provider.add(first.clone()).unwrap();
            provider.add(first).unwrap();
        }
        app.update();
        assert_eq!(drain(&mut app), vec![uid]);

        app.update();
        assert!(drain(&mut app).is_empty());

        app.world_mut()
            .resource_mut::<DataProvider<TestObject>>()
            .remove(&uid)
            .unwrap();
        app.update();
        assert_eq!(drain(&mut app), vec![uid]);
    }

    /// Clearing the provider reports every object it holds afterwards.
    #[test]
    fn reports_all_objects_after_clear() {
        let mut app = app();
        let kept = object(2);
        let uid = kept.identifiers.uid;
        {
            let mut provider = app.world_mut().resource_mut::<DataProvider<TestObject>>();
            provider.add(object(1)).unwrap();
            provider.clear();
            provider.add(kept).unwrap();
        }
        app.update();
        assert_eq!(drain(&mut app), vec![uid]);
    }

    /// Objects already stored when publishing starts are reported on the first run.
    #[test]
    fn reports_existing_objects_on_first_run() {
        let mut app = App::new();
        let existing = object(1);
        let uid = existing.identifiers.uid;
        app.init_resource::<DataProvider<TestObject>>();
        app.world_mut()
            .resource_mut::<DataProvider<TestObject>>()
            .add(existing)
            .unwrap();
        app.publish_object_changes::<TestObject>();
        app.update();
        assert_eq!(drain(&mut app), vec![uid]);
    }

    /// A message type registered before publishing starts still gets its publishing system.
    #[test]
    fn publishes_when_message_was_registered_first() {
        let mut app = App::new();
        app.init_resource::<DataProvider<TestObject>>();
        app.add_message::<ObjectChanged<TestObject>>();
        app.publish_object_changes::<TestObject>();
        app.update();
        let added = object(1);
        let uid = added.identifiers.uid;
        app.world_mut()
            .resource_mut::<DataProvider<TestObject>>()
            .add(added)
            .unwrap();
        app.update();
        assert_eq!(drain(&mut app), vec![uid]);
    }

    /// Registering twice keeps one publishing system, so changes are not reported twice.
    #[test]
    fn registering_twice_publishes_once() {
        let mut app = app();
        app.publish_object_changes::<TestObject>();
        let added = object(1);
        let uid = added.identifiers.uid;
        app.world_mut()
            .resource_mut::<DataProvider<TestObject>>()
            .add(added)
            .unwrap();
        app.update();
        assert_eq!(drain(&mut app), vec![uid]);
    }
}
