// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! WebSocket integration for flow commands and definitions.

use bevy_ecs::prelude::*;
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
/// the operation succeeded. Instead, we rely on send_flows_on_change to send
/// full definitions after changes.
pub fn forward_flow_commands(
    mut events: MessageReader<CommandEnvelope<FlowCommand>>,
    _broadcaster: Res<ClientEventSink>,
) {
    // Drain the events to avoid them accumulating
    for _event in events.read() {
        // CRUD commands are not forwarded - rely on send_flows_on_change instead
    }
}

/// Send flow definitions when DataProvider<FlowDefinition> changes.
pub fn send_flows_on_change(
    flow_provider: Res<DataProvider<FlowDefinition>>,
    broadcaster: Res<ClientEventSink>,
) {
    if flow_provider.is_changed() {
        send_flows(flow_provider, broadcaster);
    }
}

/// Send flow definitions on resync.
pub fn send_flows(
    flow_provider: Res<DataProvider<FlowDefinition>>,
    broadcaster: Res<ClientEventSink>,
) {
    let flow_list: Vec<FlowDefinition> = flow_provider
        .iter()
        .map(|entry| entry.value().clone())
        .collect();

    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &FlowWsMessage::FlowDefinitions(&flow_list),
    );
}

/// Handle ResyncState by sending flow definitions and node templates immediately.
pub fn handle_resync_state(
    mut resync: ResyncReplies,
    flow_provider: Res<DataProvider<FlowDefinition>>,
    registry: Res<FlowNodeRegistry>,
) {
    let Some(broadcaster) = resync.sink() else {
        return;
    };

    // Send flow definitions
    let flow_list: Vec<FlowDefinition> = flow_provider
        .iter()
        .map(|entry| entry.value().clone())
        .collect();

    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &FlowWsMessage::FlowDefinitions(&flow_list),
    );

    // Send node templates
    let templates = registry.list();

    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &FlowWsMessage::FlowNodeTemplates(&templates),
    );
}
