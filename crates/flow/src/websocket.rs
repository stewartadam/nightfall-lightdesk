// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! WebSocket integration for flow commands and definitions.

use bevy_ecs::prelude::*;
use bevy_ecs::system::SystemParam;
use nightfall_engine::prelude::*;
use serde::Serialize;

use crate::FlowCommand;
use crate::definition::FlowDefinition;
use crate::nodes::FlowNodeRegistry;
use crate::protocol::{FlowAck, FlowDelta, FlowPortValueDelta, FlowSnapshot, FlowTriggerDelta};

/// Wrapper for serializing flow websocket messages.
#[derive(Serialize)]
#[serde(tag = "type", content = "data")]
#[typeshare::typeshare]
pub enum FlowWsMessage<'a> {
    /// List of all flow definitions.
    FlowDefinitions(&'a [FlowDefinition]),
    /// List of all registered node templates.
    FlowNodeTemplates(&'a [crate::nodes::FlowNodeDescriptor]),
    /// A flow command for reactive UI handling.
    FlowCommand(&'a FlowCommand),
    /// Applied delta to a flow definition.
    FlowDelta(&'a FlowDelta),
    /// Flow delta acknowledgement.
    FlowAck(&'a FlowAck),
    /// Flow snapshot (rare; full runtime state).
    FlowSnapshot(&'a FlowSnapshot),
    /// Port value delta.
    FlowPortValueDelta(&'a FlowPortValueDelta),
    /// Trigger delta.
    FlowTriggerDelta(&'a FlowTriggerDelta),
}

/// Forward flow commands to the UI for reactive handling.
///
/// Note: CRUD commands (StoreFlow, RenameFlow, DeleteFlow) are intentionally NOT
/// forwarded here because the command echo would be sent before we know if
/// the operation succeeded. Instead, we rely on [`FlowsFeed`] to send
/// full definitions after changes.
pub fn forward_flow_commands(
    mut events: MessageReader<CommandEnvelope<FlowCommand>>,
    _broadcaster: Res<ClientEventSink>,
) {
    // Drain the events to avoid them accumulating
    for _event in events.read() {
        // CRUD commands are not forwarded; FlowsFeed sends the definitions instead
    }
}

/// The flow definitions feed.
#[derive(SystemParam)]
pub(crate) struct FlowsFeed<'w> {
    flows: Res<'w, DataProvider<FlowDefinition>>,
}

impl ClientFeed for FlowsFeed<'static> {
    /// Publishes every flow definition.
    fn publish(feed: &FlowsFeed<'_>, sink: &ClientEventSink) {
        let flow_list: Vec<FlowDefinition> = feed
            .flows
            .iter()
            .map(|entry| entry.value().clone())
            .collect();
        sink.publish(
            DISCRIMINATOR_NON_DROPPABLE,
            &FlowWsMessage::FlowDefinitions(&flow_list),
        );
    }
}

impl ResourceFeed for FlowNodeRegistry {
    /// Publishes every registered node template.
    fn publish(&self, sink: &ClientEventSink) {
        sink.publish(
            DISCRIMINATOR_NON_DROPPABLE,
            &FlowWsMessage::FlowNodeTemplates(&self.list()),
        );
    }
}
