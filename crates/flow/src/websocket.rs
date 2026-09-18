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
use serde_json::Value;

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

/// Deserialize and dispatch FlowCommand from JSON.
pub fn deserialize_flow_command(
    world: &mut World,
    json: Value,
    command_id: CommandId,
    undo_id: UndoId,
) -> Result<(), String> {
    let command: FlowCommand = serde_json::from_str(&json.to_string())
        .map_err(|e| format!("Failed to parse FlowCommand: {}", e))?;

    world.write_message(CommandEnvelope::with_context(
        command_id,
        undo_id,
        CommandOrigin::WebUi,
        ReplyTarget::ClientBroadcast,
        command,
    ));

    Ok(())
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

/// Send node templates on resync.
pub fn send_node_templates(registry: Res<FlowNodeRegistry>, broadcaster: Res<ClientEventSink>) {
    let templates = registry.list();

    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &FlowWsMessage::FlowNodeTemplates(&templates),
    );
}

/// Handle ResyncState by sending flow definitions and node templates immediately.
pub fn handle_resync_state(
    mut events: MessageReader<ResyncRequested>,
    flow_provider: Res<DataProvider<FlowDefinition>>,
    registry: Res<FlowNodeRegistry>,
    broadcaster: Res<ClientEventSink>,
) {
    let should_resync = events.read().next().is_some();

    if !should_resync {
        return;
    }

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

#[cfg(test)]
mod tests {
    use bevy_ecs::message::Messages;

    use super::*;

    /// Verifies deserialization preserves admitted command and undo context.
    #[test]
    fn deserialize_flow_command_writes_semantic_envelope() {
        let mut world = World::new();
        world.insert_resource(Messages::<CommandEnvelope<FlowCommand>>::default());

        let command_id = CommandId::new();
        let undo_id = UndoId::new();
        deserialize_flow_command(
            &mut world,
            serde_json::json!({
                "type": "StopFlow",
                "data": 7
            }),
            command_id,
            undo_id,
        )
        .expect("flow command should deserialize");

        let messages: Vec<_> = world
            .resource_mut::<Messages<CommandEnvelope<FlowCommand>>>()
            .drain()
            .collect();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].command_id, command_id);
        assert_eq!(messages[0].undo_id, undo_id);
        assert!(matches!(messages[0].command, FlowCommand::StopFlow(7)));
    }
}
