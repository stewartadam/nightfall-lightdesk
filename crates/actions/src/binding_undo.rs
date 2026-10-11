// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Undo and redo for edits to stored controller bindings, shared by every binding surface.
//!
//! A binding edit (an upsert that may displace overlapping bindings, or a delete) is undone by
//! a [`RestoreBindings`] operation holding snapshots of the affected bindings on both sides of
//! the edit. Restoring removes the bindings the edit left behind and reinserts the ones it
//! replaced at their original list positions, so undo reproduces the prior order exactly.
//! A restore refuses to run when the store no longer holds the edit's result unchanged, and
//! the undo system then reports a state conflict instead of clobbering newer edits.

use std::fmt::{self, Debug};
use std::marker::PhantomData;

use bevy_app::{App, Update};
use bevy_ecs::component::Mutable;
use bevy_ecs::prelude::*;
use nightfall_engine::prelude::*;
use nightfall_undo::prelude::*;
use uuid::Uuid;

use crate::source::SourceEdgeStates;

/// An ordered collection of controller bindings keyed by stable ID, such as MIDI mappings.
pub trait BindingStore: Resource + Component<Mutability = Mutable> + Clone + Debug {
    /// One stored binding.
    type Binding: Clone + PartialEq + Debug + Send + Sync + 'static;

    /// Returns the stored bindings in list order.
    fn bindings(&self) -> &[Self::Binding];

    /// Returns the stored bindings for in-place restoration.
    fn bindings_mut(&mut self) -> &mut Vec<Self::Binding>;

    /// Returns a binding's stable identity.
    fn binding_id(binding: &Self::Binding) -> Uuid;
}

/// Why a stored binding restore could not be applied to the current store.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BindingRestoreConflict {
    /// A binding the edit produced was changed or removed since.
    Changed(Uuid),
    /// A binding to reinsert already exists again under the same ID.
    Exists(Uuid),
}

impl fmt::Display for BindingRestoreConflict {
    /// Describes the conflicting binding for operator-facing errors.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Changed(id) => write!(f, "binding {id} was changed since the edit"),
            Self::Exists(id) => write!(f, "binding {id} already exists"),
        }
    }
}

/// Restores the bindings one edit affected to their state on the other side of that edit.
///
/// Registered as an undoable engine operation per store by [`register_binding_undo`]. Its
/// inverse is another restore in the opposite direction, which is how redo reapplies an edit.
pub struct RestoreBindings<S: BindingStore> {
    /// Bindings the edit left in the store, which must still be present unchanged.
    pub remove: Vec<S::Binding>,
    /// Bindings the edit replaced or removed, with their list positions before the edit.
    pub insert: Vec<(usize, S::Binding)>,
    /// Operator-facing description of the edit, shown in undo history.
    description: String,
    /// Store the bindings belong to.
    store: PhantomData<fn() -> S>,
}

impl<S: BindingStore> Clone for RestoreBindings<S> {
    /// Clones the snapshots without requiring the store type itself to be cloned.
    fn clone(&self) -> Self {
        Self {
            remove: self.remove.clone(),
            insert: self.insert.clone(),
            description: self.description.clone(),
            store: PhantomData,
        }
    }
}

impl<S: BindingStore> Debug for RestoreBindings<S> {
    /// Formats the snapshots for undo tracing.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RestoreBindings")
            .field("remove", &self.remove)
            .field("insert", &self.insert)
            .field("description", &self.description)
            .finish()
    }
}

impl<S: BindingStore> RestoreBindings<S> {
    /// Builds the restore that turns `after` back into `before` for the affected binding IDs.
    ///
    /// Returns `None` when no affected binding exists in either store, so the edit changed
    /// nothing worth recording.
    pub fn between(
        after: &S,
        before: &S,
        affected: &[Uuid],
        description: impl Into<String>,
    ) -> Option<Self> {
        let remove = after
            .bindings()
            .iter()
            .filter(|binding| affected.contains(&S::binding_id(binding)))
            .cloned()
            .collect::<Vec<_>>();
        let insert = before
            .bindings()
            .iter()
            .enumerate()
            .filter(|(_, binding)| affected.contains(&S::binding_id(binding)))
            .map(|(index, binding)| (index, binding.clone()))
            .collect::<Vec<_>>();
        (!remove.is_empty() || !insert.is_empty()).then(|| Self {
            remove,
            insert,
            description: description.into(),
            store: PhantomData,
        })
    }

    /// Returns the IDs of every binding this restore touches.
    fn affected_ids(&self) -> Vec<Uuid> {
        let mut ids = self
            .remove
            .iter()
            .chain(self.insert.iter().map(|(_, binding)| binding))
            .map(S::binding_id)
            .collect::<Vec<_>>();
        ids.sort_unstable();
        ids.dedup();
        ids
    }

    /// Checks that the store still holds the edit's result and has room for the reinserted
    /// bindings.
    pub fn check(&self, store: &S) -> Result<(), BindingRestoreConflict> {
        for expected in &self.remove {
            let id = S::binding_id(expected);
            if !store.bindings().iter().any(|binding| binding == expected) {
                return Err(BindingRestoreConflict::Changed(id));
            }
        }
        for (_, restored) in &self.insert {
            let id = S::binding_id(restored);
            let removed = self
                .remove
                .iter()
                .any(|binding| S::binding_id(binding) == id);
            if !removed
                && store
                    .bindings()
                    .iter()
                    .any(|binding| S::binding_id(binding) == id)
            {
                return Err(BindingRestoreConflict::Exists(id));
            }
        }
        Ok(())
    }

    /// Applies the restore, leaving the store untouched when it conflicts.
    ///
    /// Reinserting in ascending original position rebuilds the pre-edit order, because the
    /// bindings the edit did not touch kept their relative order.
    pub fn apply(&self, store: &mut S) -> Result<(), BindingRestoreConflict> {
        self.check(store)?;
        let bindings = store.bindings_mut();
        bindings.retain(|binding| !self.remove.contains(binding));
        let mut insert = self.insert.clone();
        insert.sort_by_key(|(index, _)| *index);
        for (index, binding) in insert {
            let index = index.min(bindings.len());
            bindings.insert(index, binding);
        }
        Ok(())
    }
}

impl<S: BindingStore> EnginePayload for RestoreBindings<S> {}

impl<S: BindingStore> EngineOperation for RestoreBindings<S> {}

impl<S: BindingStore> Undoable for RestoreBindings<S> {
    /// Captures the opposite restore, or refuses when the store no longer matches this one.
    fn inverse(&self, ctx: &UndoContext) -> Option<Box<dyn Undoable>> {
        let store = ctx.world.get_resource::<S>()?;
        let mut restored = store.clone();
        self.apply(&mut restored).ok()?;
        RestoreBindings::between(
            &restored,
            store,
            &self.affected_ids(),
            self.description.clone(),
        )
        .map(|restore| Box::new(restore) as Box<dyn Undoable>)
    }

    /// Describes the binding edit this restore reverts or reapplies.
    fn description(&self) -> String {
        self.description.clone()
    }
}

/// Captures the inverse of a binding edit before it is applied.
///
/// `edit` applies the edit to a copy of the current store and returns the IDs of every
/// binding it affected, or `None` when the edit would not change the store (for example a
/// delete of a missing binding). The returned restore snapshots those bindings on both sides.
pub fn capture_binding_edit<S: BindingStore>(
    world: &World,
    description: impl Into<String>,
    edit: impl FnOnce(&mut S) -> Option<Vec<Uuid>>,
) -> Option<Box<dyn Undoable>> {
    let before = world.get_resource::<S>()?;
    let mut after = before.clone();
    let affected = edit(&mut after)?;
    RestoreBindings::between(&after, before, &affected, description)
        .map(|restore| Box::new(restore) as Box<dyn Undoable>)
}

/// Registers a binding store's edit command and its restore operation with the undo system.
///
/// `C` is the store's ingress command, whose [`Undoable::inverse`] should use
/// [`capture_binding_edit`]. Requires the undo plugin.
pub fn register_binding_undo<S, C>(app: &mut App)
where
    S: BindingStore,
    C: Undoable + Clone,
{
    assert!(
        app.world().contains_resource::<UndoRegistry>(),
        "binding undo requires UndoPlugin (provides UndoRegistry)"
    );
    {
        let mut registry = app.world_mut().resource_mut::<UndoRegistry>();
        registry.register::<C>();
        registry.register_operation::<RestoreBindings<S>>();
    }
    register_engine_operation::<RestoreBindings<S>>(app);
    app.add_systems(Update, apply_binding_restores::<S>.in_set(EventHandling));
}

/// Applies undo and redo restores to a binding store and completes their commands.
///
/// Press state is forgotten for every restored binding so a replaced control cannot finish a
/// press that began under its previous binding.
pub fn apply_binding_restores<S: BindingStore>(
    mut events: MessageReader<EngineOperationEnvelope<RestoreBindings<S>>>,
    mut store: ResMut<S>,
    mut edges: ResMut<SourceEdgeStates>,
    mut responder: CommandResponder,
) {
    for event in events.read() {
        let restore = &event.operation;
        let outcome = restore.apply(&mut *store);
        if outcome.is_ok() {
            for id in restore.affected_ids() {
                edges.forget(id);
            }
        } else {
            tracing::warn!(?outcome, "binding_restore_conflict");
        }
        let Some(command_id) = event.command_id else {
            continue;
        };
        let result = match outcome {
            Ok(()) => responder.succeed(command_id),
            Err(conflict) => responder.fail(
                command_id,
                CommandError::new(
                    "actions.binding_restore_conflict",
                    format!("Cannot restore {}: {conflict}", restore.description),
                ),
            ),
        };
        if let Err(error) = result {
            tracing::error!(%command_id, %error, "binding_restore_completion_failed");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal binding store of `(id, label)` pairs.
    #[derive(Resource, Clone, Debug, Default)]
    struct TestStore(Vec<(Uuid, &'static str)>);

    impl BindingStore for TestStore {
        type Binding = (Uuid, &'static str);

        /// Returns the stored pairs.
        fn bindings(&self) -> &[Self::Binding] {
            &self.0
        }

        /// Returns the stored pairs mutably.
        fn bindings_mut(&mut self) -> &mut Vec<Self::Binding> {
            &mut self.0
        }

        /// Returns the pair's ID.
        fn binding_id(binding: &Self::Binding) -> Uuid {
            binding.0
        }
    }

    /// Builds a pair with a deterministic ID.
    fn pair(id: u128, label: &'static str) -> (Uuid, &'static str) {
        (Uuid::from_u128(id), label)
    }

    /// Verifies restoring reinserts displaced and edited bindings at their original positions.
    #[test]
    fn restore_rebuilds_original_order() {
        let before = TestStore(vec![pair(1, "a"), pair(2, "b"), pair(3, "c"), pair(4, "d")]);
        let after = TestStore(vec![pair(1, "a"), pair(3, "c2"), pair(5, "e")]);
        let affected = [2, 3, 4, 5].map(Uuid::from_u128);
        let restore = RestoreBindings::between(&after, &before, &affected, "edit")
            .expect("edit should be recorded");

        let mut store = after.clone();
        restore.apply(&mut store).expect("restore should apply");

        assert_eq!(store.0, before.0);
    }

    /// Verifies a restore refuses to overwrite a binding that changed after the edit.
    #[test]
    fn restore_conflicts_when_result_changed() {
        let before = TestStore(vec![pair(1, "a")]);
        let after = TestStore(vec![pair(1, "b")]);
        let restore = RestoreBindings::between(&after, &before, &[Uuid::from_u128(1)], "edit")
            .expect("edit should be recorded");

        let mut store = TestStore(vec![pair(1, "c")]);
        assert_eq!(
            restore.apply(&mut store),
            Err(BindingRestoreConflict::Changed(Uuid::from_u128(1)))
        );
        assert_eq!(store.0, vec![pair(1, "c")]);
    }

    /// Verifies undoing a delete refuses when the ID was reused since.
    #[test]
    fn restore_conflicts_when_deleted_binding_reappears() {
        let before = TestStore(vec![pair(1, "a")]);
        let after = TestStore::default();
        let restore = RestoreBindings::between(&after, &before, &[Uuid::from_u128(1)], "delete")
            .expect("delete should be recorded");

        let mut store = TestStore(vec![pair(1, "other")]);
        assert_eq!(
            restore.apply(&mut store),
            Err(BindingRestoreConflict::Exists(Uuid::from_u128(1)))
        );
    }

    /// Verifies the inverse of a restore reapplies the original edit.
    #[test]
    fn inverse_reapplies_edit() {
        let before = TestStore(vec![pair(1, "a"), pair(2, "b")]);
        let after = TestStore(vec![pair(2, "b"), pair(3, "c")]);
        let affected = [1, 3].map(Uuid::from_u128);
        let undo = RestoreBindings::between(&after, &before, &affected, "edit")
            .expect("edit should be recorded");

        let mut world = World::new();
        world.insert_resource(after.clone());
        let redo = undo
            .inverse(&UndoContext { world: &world })
            .expect("undo should be applicable");
        undo.apply(&mut world.resource_mut::<TestStore>())
            .expect("undo should apply");
        assert_eq!(world.resource::<TestStore>().0, before.0);

        let redo = redo
            .as_any()
            .downcast_ref::<RestoreBindings<TestStore>>()
            .expect("redo should be a restore");
        redo.apply(&mut world.resource_mut::<TestStore>())
            .expect("redo should apply");
        assert_eq!(world.resource::<TestStore>().0, after.0);
    }
}
