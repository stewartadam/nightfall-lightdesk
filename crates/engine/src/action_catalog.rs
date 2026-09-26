// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Publishes domain registrations without importing the domains that own them.

use bevy_ecs::prelude::*;
use nightfall_actions::{ActionDescriptor, ActionRegistry};
use serde::Serialize;

use crate::prelude::{ClientEventSink, DISCRIMINATOR_NON_DROPPABLE, ResyncRequested};

/// Catalog envelope shared by native and embedded client transports.
#[derive(Serialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum ActionCatalogMessage {
    /// Complete catalog, replacing the previous client snapshot.
    ActionCatalog(Vec<ActionDescriptor>),
}

/// Sends a complete catalog on client resync or after domain registration changes.
pub(crate) fn publish_action_catalog(
    registry: Option<Res<ActionRegistry>>,
    mut requests: MessageReader<ResyncRequested>,
    sink: Res<ClientEventSink>,
) {
    let requested = requests.read().count() > 0;
    let Some(registry) = registry else {
        return;
    };
    if !requested && !registry.is_changed() {
        return;
    }
    sink.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &ActionCatalogMessage::ActionCatalog(registry.iter().cloned().collect()),
    );
}

#[cfg(test)]
mod tests {
    use bevy_app::{App, Update};
    use nightfall_actions::{ActionId, ActionInputKind, ActionSurface, InvocationDispatch};
    use serde_json::{Value, json};

    use super::*;

    /// An independently registered action is published and resent without domain imports.
    #[test]
    fn catalog_publishes_registration_and_resync_without_repeating_unchanged_state() {
        let (sender, receiver) = async_channel::unbounded();
        let mut app = App::new();
        app.init_resource::<ActionRegistry>();
        app.insert_resource(ClientEventSink::new(sender));
        app.add_message::<ResyncRequested>();
        app.add_systems(Update, publish_action_catalog);
        let mut descriptor = ActionDescriptor {
            id: ActionId::new("independent.test"),
            capabilities: Vec::new(),
            label: "Independent action".into(),
            allowed_surfaces: vec![ActionSurface::Midi],
            input_kind: ActionInputKind::Trigger,
            argument_schema: json!({ "type": "object" }),
        };
        app.world_mut()
            .resource_mut::<ActionRegistry>()
            .register::<Value, _>(descriptor.clone(), |_, _, _| {
                Ok(InvocationDispatch::succeeded())
            });
        app.world_mut()
            .resource_mut::<ActionRegistry>()
            .register_capability::<Value, u32, _>(
                "independent.test",
                "independent.plan.v1",
                ActionSurface::Midi,
                |_| Ok(42),
            );
        descriptor
            .capabilities
            .push(nightfall_actions::ActionCapabilityDescriptor {
                id: "independent.plan.v1".into(),
                surface: ActionSurface::Midi,
            });
        app.update();
        let first = receiver.try_recv().expect("initial catalog");
        assert_eq!(first[0], DISCRIMINATOR_NON_DROPPABLE);
        let message: Value = minicbor_serde::from_slice(&first[1..]).unwrap();
        assert_eq!(
            message,
            json!({ "type": "ActionCatalog", "data": [descriptor] })
        );
        app.update();
        assert!(receiver.try_recv().is_err());
        app.world_mut()
            .write_message(ResyncRequested { command_id: None });
        app.update();
        assert_eq!(receiver.try_recv().expect("resync catalog"), first);
    }
}
