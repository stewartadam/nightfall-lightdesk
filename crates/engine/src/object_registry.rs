// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Domain-registered object identity lookup, independent of its consumers.

use std::collections::HashMap;

use bevy_ecs::{
    prelude::*,
    system::{IntoSystem, SystemId},
};
use nightfall::prelude::{HasIdentifiers, ObjectIdentity, ObjectRef, ObjectType};
use uuid::Uuid;

use crate::data_provider::DataProvider;

/// Failure to identify exactly one currently stored object.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ObjectLookupError {
    /// The object domain has not installed a lookup handler.
    Unsupported,
    /// No stored object matches the reference.
    Missing,
    /// Multiple objects match an unscoped reference.
    Ambiguous,
    /// The registered lookup system could not run.
    Unavailable,
}

/// UUID or structured failure returned by a domain lookup handler.
pub type ObjectLookupResult = Result<Uuid, ObjectLookupError>;

/// Routes references to domain-owned systems without depending on domain crates.
#[derive(Resource, Default)]
pub struct ObjectRegistry(HashMap<ObjectType, SystemId<In<ObjectRef>, ObjectLookupResult>>);

/// Installs the identity lookup handler for an object type, rejecting conflicting owners.
pub fn register_object_lookup<M>(
    world: &mut World,
    object_type: ObjectType,
    system: impl IntoSystem<In<ObjectRef>, ObjectLookupResult, M> + 'static,
) {
    world.init_resource::<ObjectRegistry>();
    assert!(
        !world
            .resource::<ObjectRegistry>()
            .0
            .contains_key(&object_type),
        "duplicate object lookup registration: {object_type:?}"
    );
    let system = world.register_system(system);
    world
        .resource_mut::<ObjectRegistry>()
        .0
        .insert(object_type, system);
}

/// Resolves a numeric or UUID reference against current storage and preserves its namespace.
///
/// UUID references also pass through the domain handler to verify existence. A successful
/// result does not guarantee that the object continues to exist or supports a caller's use.
pub fn resolve_object(
    world: &mut World,
    reference: &ObjectRef,
) -> Result<ObjectIdentity, ObjectLookupError> {
    let object_type = reference.object_type();
    let system = world
        .get_resource::<ObjectRegistry>()
        .and_then(|registry| registry.0.get(&object_type))
        .copied()
        .ok_or(ObjectLookupError::Unsupported)?;
    let uid = world
        .run_system_with(system, reference.clone())
        .map_err(|_| ObjectLookupError::Unavailable)??;
    Ok(ObjectIdentity { object_type, uid })
}

/// Resolves provider-backed objects while respecting domains that permit duplicate numeric IDs.
pub fn lookup_provider_object<T: HasIdentifiers>(
    reference: &ObjectRef,
    provider: &DataProvider<T>,
) -> ObjectLookupResult {
    match reference {
        ObjectRef::ByUid { uid, .. } => provider
            .get(*uid)
            .map(|object| object.identifiers().uid)
            .map_err(|_| ObjectLookupError::Missing),
        ObjectRef::ById { id, .. } if T::requires_unique_id() => provider
            .from_id(*id)
            .map(|object| object.identifiers().uid)
            .map_err(|_| ObjectLookupError::Missing),
        ObjectRef::ById { id, .. } => unique_object_uid(
            provider
                .iter()
                .filter(|object| object.identifiers().id == *id)
                .map(|object| object.identifiers().uid),
        ),
    }
}

/// Rejects absent and duplicate matches instead of selecting an arbitrary object.
pub fn unique_object_uid(mut matches: impl Iterator<Item = Uuid>) -> ObjectLookupResult {
    let uid = matches.next().ok_or(ObjectLookupError::Missing)?;
    if matches.next().is_some() {
        return Err(ObjectLookupError::Ambiguous);
    }
    Ok(uid)
}

#[cfg(test)]
mod tests {
    use nightfall::prelude::{Group, Identifiers};

    use super::*;

    /// Looks up group objects without any dependency on a playback domain or consumer.
    fn lookup_group(
        In(reference): In<ObjectRef>,
        provider: Res<DataProvider<Group>>,
    ) -> ObjectLookupResult {
        lookup_provider_object(&reference, &provider)
    }

    /// Creates a registered group provider containing one stable object identity.
    fn group_world() -> (World, ObjectIdentity) {
        let mut world = World::new();
        register_object_lookup(&mut world, ObjectType::Group, lookup_group);
        world.init_resource::<DataProvider<Group>>();
        let group = Group {
            identifiers: Identifiers {
                id: 7,
                ..Default::default()
            },
            ..Default::default()
        };
        let identity = ObjectIdentity {
            object_type: ObjectType::Group,
            uid: group.identifiers.uid,
        };
        world
            .resource_mut::<DataProvider<Group>>()
            .add(group)
            .unwrap();
        (world, identity)
    }

    /// Non-playback domains resolve through the same registry, with namespace and existence checks.
    #[test]
    fn object_registry_resolves_and_revalidates_non_playback_identity() {
        let (mut world, identity) = group_world();
        let numeric = ObjectRef::ById {
            object_type: ObjectType::Group,
            id: 7,
        };
        assert_eq!(resolve_object(&mut world, &numeric), Ok(identity));
        assert_eq!(resolve_object(&mut world, &identity.into()), Ok(identity));
        assert_eq!(
            resolve_object(
                &mut world,
                &ObjectRef::ById {
                    object_type: ObjectType::Fx,
                    id: 7
                }
            ),
            Err(ObjectLookupError::Unsupported)
        );
        world
            .resource_mut::<DataProvider<Group>>()
            .remove(&identity.uid)
            .unwrap();
        assert_eq!(
            resolve_object(&mut world, &numeric),
            Err(ObjectLookupError::Missing)
        );
        assert_eq!(
            resolve_object(&mut world, &identity.into()),
            Err(ObjectLookupError::Missing)
        );
    }

    /// An object whose console-facing ID is permitted to repeat in different scopes.
    #[derive(Debug, Default)]
    struct ScopedObject(Identifiers);

    impl HasIdentifiers for ScopedObject {
        /// Exposes identifiers used by the provider's UID index and unscoped lookup.
        fn identifiers(&self) -> &Identifiers {
            &self.0
        }

        /// Allows equal numeric IDs so the resolver must detect ambiguous unscoped references.
        fn requires_unique_id() -> bool {
            false
        }
    }

    /// Scoped IDs must not resolve through the provider's single-entry numeric alias index.
    #[test]
    fn provider_object_lookup_rejects_ambiguous_unscoped_ids() {
        let mut provider = DataProvider::<ScopedObject>::default();
        let first = ScopedObject(Identifiers {
            id: 1,
            ..Default::default()
        });
        let uid = first.0.uid;
        let second = ScopedObject(Identifiers {
            id: 1,
            ..Default::default()
        });
        let numeric = ObjectRef::ById {
            object_type: ObjectType::Cue,
            id: 1,
        };
        provider.add(first).unwrap();
        assert_eq!(lookup_provider_object(&numeric, &provider), Ok(uid));
        provider.add(second).unwrap();
        assert_eq!(
            lookup_provider_object(&numeric, &provider),
            Err(ObjectLookupError::Ambiguous)
        );
        assert_eq!(
            lookup_provider_object(
                &ObjectRef::ByUid {
                    object_type: ObjectType::Cue,
                    uid
                },
                &provider
            ),
            Ok(uid)
        );
    }

    /// Missing handler resources produce structured failures, not fabricated identities.
    #[test]
    fn unavailable_object_lookup_returns_failure() {
        let mut world = World::new();
        register_object_lookup(&mut world, ObjectType::Group, lookup_group);
        assert_eq!(
            resolve_object(
                &mut world,
                &ObjectRef::ById {
                    object_type: ObjectType::Group,
                    id: 7
                }
            ),
            Err(ObjectLookupError::Unavailable)
        );
    }

    /// Conflicting domain registrations are rejected before a handler can be overwritten.
    #[test]
    #[should_panic(expected = "duplicate object lookup registration")]
    fn duplicate_object_lookup_registration_is_rejected() {
        let (mut world, _) = group_world();
        register_object_lookup(&mut world, ObjectType::Group, lookup_group);
    }

    /// Identity serialization retains the kind and canonical UUID without a numeric alternative.
    #[test]
    fn object_identity_roundtrips_through_shared_reference_contract() {
        let (_, identity) = group_world();
        let encoded = serde_json::to_value(identity).unwrap();
        assert_eq!(encoded["object_type"], "Group");
        assert_eq!(encoded["uid"], identity.uid.simple().to_string());
        assert_eq!(
            serde_json::from_value::<ObjectIdentity>(encoded).unwrap(),
            identity
        );
        let reference = ObjectRef::from(identity);
        assert_eq!(reference.object_type(), ObjectType::Group);
        assert!(matches!(reference, ObjectRef::ByUid { uid, .. } if uid == identity.uid));
    }
}
