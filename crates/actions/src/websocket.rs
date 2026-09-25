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
use crate::invocation::{ActionInvocationFailure, ClientActionInvocation};
use crate::registry::ActionRegistry;

/// Websocket messages emitted by the actions plugin.
#[derive(Serialize)]
#[serde(tag = "type", content = "data")]
#[typeshare::typeshare]
pub enum ActionsWsMessage<'a> {
    /// Every registered action with its descriptor and capability names.
    ActionCatalog(&'a [ActionCatalogEntry]),
    /// Request for opted-in clients to run a client-hosted `ui.*` action.
    ClientActionInvocation(&'a ClientActionInvocation),
    /// A registered action invocation failed and the operator should be told.
    ActionInvocationFailed(&'a ActionInvocationFailure),
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

/// Broadcasts client-hosted action invocations to connected Web UI clients.
pub fn send_client_action_invocations(
    mut invocations: MessageReader<ClientActionInvocation>,
    sink: Option<Res<ClientEventSink>>,
) {
    let Some(sink) = sink else {
        invocations.clear();
        return;
    };
    for invocation in invocations.read() {
        sink.publish(
            DISCRIMINATOR_NON_DROPPABLE,
            &ActionsWsMessage::ClientActionInvocation(invocation),
        );
    }
}

/// Broadcasts admitted invocation failures to connected clients.
///
/// Failures are non-droppable so a rejected palette, keybinding, MIDI, or OSC action is
/// never silently lost under websocket backpressure; the dispatcher already throttles
/// repeated failures from continuous input.
pub fn send_action_invocation_failures(
    mut failures: MessageReader<ActionInvocationFailure>,
    sink: Option<Res<ClientEventSink>>,
) {
    let Some(sink) = sink else {
        failures.clear();
        return;
    };
    for failure in failures.read() {
        sink.publish(
            DISCRIMINATOR_NON_DROPPABLE,
            &ActionsWsMessage::ActionInvocationFailed(failure),
        );
    }
}
