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
    object_registry::{ObjectLookupResult, lookup_provider_object, register_object_lookup},
    prelude::DataProvider,
};

use crate::definition;

/// Resolves a flow reference from this domain's authoritative storage.
fn lookup_flow(
    In(reference): In<ObjectRef>,
    provider: Res<DataProvider<definition::FlowDefinition>>,
) -> ObjectLookupResult {
    lookup_provider_object(&reference, &provider)
}

/// Registers object identity lookups owned by this domain.
pub(crate) fn register_object_lookups(app: &mut App) {
    register_object_lookup(app.world_mut(), ObjectType::Flow, lookup_flow);
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
        app.init_resource::<DataProvider<definition::FlowDefinition>>();
        let mut object = definition::FlowDefinition::default();
        object.identifiers.id = 7;
        let uid = object.identifiers.uid;
        app.world_mut()
            .resource_mut::<DataProvider<definition::FlowDefinition>>()
            .add(object.clone())
            .unwrap();
        assert!(
            matches!(resolve_object(app.world_mut(), &ObjectRef::ById { object_type: ObjectType::Flow, id: 7 }), Ok(ObjectIdentity { object_type: ObjectType::Flow, uid: found }) if found == uid)
        );
        object.identifiers.id = 8;
        app.world_mut()
            .resource_mut::<DataProvider<definition::FlowDefinition>>()
            .add(object)
            .unwrap();
        assert!(matches!(
            resolve_object(
                app.world_mut(),
                &ObjectRef::ById {
                    object_type: ObjectType::Flow,
                    id: 7
                }
            ),
            Err(ObjectLookupError::Missing)
        ));
        assert!(
            matches!(resolve_object(app.world_mut(), &ObjectRef::ById { object_type: ObjectType::Flow, id: 8 }), Ok(ObjectIdentity { object_type: ObjectType::Flow, uid: found }) if found == uid)
        );
    }
}
