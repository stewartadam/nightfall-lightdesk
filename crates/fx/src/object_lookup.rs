// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Object identity lookups registered by this domain.

use bevy_app::App;
use bevy_ecs::prelude::*;
use nightfall::prelude::{ObjectRef, ObjectType};
use nightfall_engine::{
    object_registry::{
        ObjectLookupResult, lookup_provider_object, register_object_lookup, unique_object_uid,
    },
    prelude::DataProvider,
};

use crate::{fx, step_fx, stored_module};

/// Resolves an FX reference from this domain's authoritative storage.
fn lookup_fx(
    In(reference): In<ObjectRef>,
    provider: Res<DataProvider<fx::Fx>>,
) -> ObjectLookupResult {
    lookup_provider_object(&reference, &provider)
}

/// Resolves a step FX reference from this domain's authoritative storage.
fn lookup_step_fx(
    In(reference): In<ObjectRef>,
    objects: Query<&step_fx::StepFx>,
) -> ObjectLookupResult {
    unique_object_uid(
        objects
            .iter()
            .filter(|object| match reference {
                ObjectRef::ById { id, .. } => object.identifiers.id == id,
                ObjectRef::ByUid { uid, .. } => object.identifiers.uid == uid,
            })
            .map(|object| object.identifiers.uid),
    )
}

/// Resolves an FX-module reference from this domain's authoritative storage.
fn lookup_fx_module(
    In(reference): In<ObjectRef>,
    provider: Res<DataProvider<stored_module::StoredFxModule>>,
) -> ObjectLookupResult {
    lookup_provider_object(&reference, &provider)
}

/// Registers object identity lookups owned by this domain.
pub(crate) fn register_object_lookups(app: &mut App) {
    register_object_lookup(app.world_mut(), ObjectType::Fx, lookup_fx);
    register_object_lookup(app.world_mut(), ObjectType::StepFx, lookup_step_fx);
    register_object_lookup(app.world_mut(), ObjectType::FxModule, lookup_fx_module);
}

#[cfg(test)]
mod tests {
    use nightfall::prelude::ObjectIdentity;
    use nightfall_engine::object_registry::{ObjectLookupError, resolve_object};

    use super::*;

    /// Exercises domain registration against authoritative storage, including numeric-ID changes.
    #[test]
    fn registered_provider_objects_follow_stored_ids() {
        let mut app = App::new();
        register_object_lookups(&mut app);
        app.init_resource::<DataProvider<fx::Fx>>();
        let mut object = fx::Fx::default();
        object.identifiers.id = 7;
        let uid = object.identifiers.uid;
        app.world_mut()
            .resource_mut::<DataProvider<fx::Fx>>()
            .add(object.clone())
            .unwrap();
        assert!(
            matches!(resolve_object(app.world_mut(), &ObjectRef::ById { object_type: ObjectType::Fx, id: 7 }), Ok(ObjectIdentity { object_type: ObjectType::Fx, uid: found }) if found == uid)
        );
        object.identifiers.id = 8;
        app.world_mut()
            .resource_mut::<DataProvider<fx::Fx>>()
            .add(object)
            .unwrap();
        assert!(matches!(
            resolve_object(
                app.world_mut(),
                &ObjectRef::ById {
                    object_type: ObjectType::Fx,
                    id: 7
                }
            ),
            Err(ObjectLookupError::Missing)
        ));
        assert!(
            matches!(resolve_object(app.world_mut(), &ObjectRef::ById { object_type: ObjectType::Fx, id: 8 }), Ok(ObjectIdentity { object_type: ObjectType::Fx, uid: found }) if found == uid)
        );
        app.init_resource::<DataProvider<stored_module::StoredFxModule>>();
        let mut object = stored_module::StoredFxModule::default();
        object.identifiers.id = 7;
        let uid = object.identifiers.uid;
        app.world_mut()
            .resource_mut::<DataProvider<stored_module::StoredFxModule>>()
            .add(object.clone())
            .unwrap();
        assert!(
            matches!(resolve_object(app.world_mut(), &ObjectRef::ById { object_type: ObjectType::FxModule, id: 7 }), Ok(ObjectIdentity { object_type: ObjectType::FxModule, uid: found }) if found == uid)
        );
        object.identifiers.id = 8;
        app.world_mut()
            .resource_mut::<DataProvider<stored_module::StoredFxModule>>()
            .add(object)
            .unwrap();
        assert!(matches!(
            resolve_object(
                app.world_mut(),
                &ObjectRef::ById {
                    object_type: ObjectType::FxModule,
                    id: 7
                }
            ),
            Err(ObjectLookupError::Missing)
        ));
        assert!(
            matches!(resolve_object(app.world_mut(), &ObjectRef::ById { object_type: ObjectType::FxModule, id: 8 }), Ok(ObjectIdentity { object_type: ObjectType::FxModule, uid: found }) if found == uid)
        );
    }

    /// Rejects duplicate ECS IDs and resolves again after the duplicate disappears.
    #[test]
    fn registered_step_fx_object_requires_unique_id() {
        let mut app = App::new();
        register_object_lookups(&mut app);
        let object = step_fx::StepFx {
            identifiers: nightfall::prelude::Identifiers {
                id: 7,
                ..Default::default()
            },
            selection: Default::default(),
            ..Default::default()
        };
        let uid = object.identifiers.uid;
        assert!(matches!(
            resolve_object(
                app.world_mut(),
                &ObjectRef::ById {
                    object_type: ObjectType::StepFx,
                    id: 7
                }
            ),
            Err(ObjectLookupError::Missing)
        ));
        let entity = app.world_mut().spawn(object.clone()).id();
        let duplicate = app.world_mut().spawn(object).id();
        assert!(matches!(
            resolve_object(
                app.world_mut(),
                &ObjectRef::ById {
                    object_type: ObjectType::StepFx,
                    id: 7
                }
            ),
            Err(ObjectLookupError::Ambiguous)
        ));
        app.world_mut().despawn(duplicate);
        assert!(
            matches!(resolve_object(app.world_mut(), &ObjectRef::ById { object_type: ObjectType::StepFx, id: 7 }), Ok(ObjectIdentity { object_type: ObjectType::StepFx, uid: found }) if found == uid)
        );
        let reference = ObjectRef::ByUid {
            object_type: ObjectType::StepFx,
            uid,
        };
        assert_eq!(
            resolve_object(app.world_mut(), &reference),
            Ok(ObjectIdentity {
                object_type: ObjectType::StepFx,
                uid
            })
        );
        app.world_mut().despawn(entity);
        assert_eq!(
            resolve_object(app.world_mut(), &reference),
            Err(ObjectLookupError::Missing)
        );
    }
}
