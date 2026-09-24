// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Publishes the action catalog to attached clients.

use bevy_ecs::prelude::*;
use nightfall_engine::prelude::{ClientEventSink, DISCRIMINATOR_NON_DROPPABLE, ResyncRequested};
use serde::Serialize;

use crate::descriptor::ActionCatalogEntry;
use crate::registry::ActionRegistry;

/// Websocket messages emitted by the actions plugin.
#[derive(Serialize)]
#[serde(tag = "type", content = "data")]
#[typeshare::typeshare]
pub enum ActionsWsMessage<'a> {
    /// Every registered action with its descriptor and capability names.
    ActionCatalog(&'a [ActionCatalogEntry]),
}

/// Broadcasts the catalog whenever registrations change.
pub fn send_action_catalog_on_change(
    registry: Res<ActionRegistry>,
    sink: Option<Res<ClientEventSink>>,
) {
    if registry.is_changed()
        && let Some(sink) = sink
    {
        send_catalog(&registry, &sink);
    }
}

/// Re-sends the catalog when a client requests a full state resync.
pub fn handle_resync_state(
    mut events: MessageReader<ResyncRequested>,
    registry: Res<ActionRegistry>,
    sink: Option<Res<ClientEventSink>>,
) {
    if events.read().next().is_some()
        && let Some(sink) = sink
    {
        send_catalog(&registry, &sink);
    }
}

/// Serializes and publishes one catalog snapshot.
fn send_catalog(registry: &ActionRegistry, sink: &ClientEventSink) {
    sink.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &ActionsWsMessage::ActionCatalog(&registry.catalog()),
    );
}
