// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! WebSocket integration for OSC input.

use bevy_ecs::prelude::*;
use nightfall_engine::prelude::*;
use serde::Serialize;
use serde_json::Value;

use crate::command::{OscCommand, OscExternalEval, OscLastEvent, OscListenerStatus, OscMapping};
use crate::mapping::OscMappings;
use crate::{LastOscEvent, OscRuntimeStatus, OscSources};

/// OSC source info for UI display.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[typeshare::typeshare]
pub struct OscSource {
    /// Source socket address (`ip:port`).
    pub address: String,
}

/// Websocket messages emitted by the OSC plugin.
#[derive(Serialize)]
#[serde(tag = "type", content = "data")]
#[typeshare::typeshare]
#[allow(clippy::enum_variant_names)]
pub enum OscWsMessage<'a> {
    /// Known source list.
    OscSources(&'a [OscSource]),
    /// Configured mappings.
    OscMappings(&'a [OscMapping]),
    /// Last observed OSC event.
    OscLastEvent(&'a OscLastEvent),
    /// Listener bind status.
    OscListenerStatus(&'a OscListenerStatus),
    /// External eval metadata for CommandLine source tagging.
    OscExternalEval(&'a OscExternalEval),
}

/// Deserialize and dispatch `OscCommand` from JSON.
pub fn deserialize_osc_command(
    world: &mut World,
    json: Value,
    command_id: CommandId,
    undo_id: UndoId,
) -> Result<(), String> {
    let command: OscCommand =
        serde_json::from_value(json).map_err(|e| format!("Failed to parse OscCommand: {e}"))?;

    world.write_message(CommandEnvelope::with_context(
        command_id,
        undo_id,
        CommandOrigin::WebUi,
        ReplyTarget::ClientBroadcast,
        command,
    ));

    Ok(())
}

/// Send OSC state on resync.
pub fn handle_resync_state(
    mut events: MessageReader<ResyncRequested>,
    sources: Res<OscSources>,
    mappings: Res<OscMappings>,
    last_event: Res<LastOscEvent>,
    status: Res<OscRuntimeStatus>,
    broadcaster: Res<ClientEventSink>,
) {
    let should_resync = events.read().next().is_some();

    if !should_resync {
        return;
    }

    send_sources(&sources, &broadcaster);
    send_mappings(&mappings, &broadcaster);
    send_listener_status(&status, &broadcaster);
    if let Some(ref event) = last_event.0 {
        send_last_event(event, &broadcaster);
    }
}

/// Send OSC state updates when resources change.
pub fn send_osc_state(
    sources: Res<OscSources>,
    mappings: Res<OscMappings>,
    last_event: Res<LastOscEvent>,
    status: Res<OscRuntimeStatus>,
    broadcaster: Res<ClientEventSink>,
) {
    if sources.is_changed() {
        send_sources(&sources, &broadcaster);
    }
    if mappings.is_changed() {
        send_mappings(&mappings, &broadcaster);
    }
    if status.is_changed() {
        send_listener_status(&status, &broadcaster);
    }
    if last_event.is_changed()
        && let Some(ref event) = last_event.0
    {
        send_last_event(event, &broadcaster);
    }
}

/// Broadcast external eval metadata for command-line source tags.
pub fn send_external_evals(
    mut events: MessageReader<OscExternalEval>,
    broadcaster: Res<ClientEventSink>,
) {
    for event in events.read() {
        broadcaster.publish(
            DISCRIMINATOR_NON_DROPPABLE,
            &OscWsMessage::OscExternalEval(event),
        );
    }
}

fn send_sources(sources: &OscSources, broadcaster: &ClientEventSink) {
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &OscWsMessage::OscSources(&sources.0),
    );
}

fn send_mappings(mappings: &OscMappings, broadcaster: &ClientEventSink) {
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &OscWsMessage::OscMappings(mappings.mappings()),
    );
}

fn send_last_event(event: &OscLastEvent, broadcaster: &ClientEventSink) {
    broadcaster.publish(DISCRIMINATOR_DROPPABLE, &OscWsMessage::OscLastEvent(event));
}

fn send_listener_status(status: &OscRuntimeStatus, broadcaster: &ClientEventSink) {
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &OscWsMessage::OscListenerStatus(&status.0),
    );
}

#[cfg(test)]
mod tests {
    use bevy_ecs::message::Messages;

    use super::*;

    #[test]
    fn deserialize_osc_command_writes_semantic_envelope() {
        let mut world = World::new();
        world.insert_resource(Messages::<CommandEnvelope<OscCommand>>::default());

        let command_id = CommandId::new();
        let undo_id = UndoId::new();
        deserialize_osc_command(
            &mut world,
            serde_json::json!({
                "type": "DeleteMapping",
                "data": 4
            }),
            command_id,
            undo_id,
        )
        .expect("osc command should deserialize");

        let messages: Vec<_> = world
            .resource_mut::<Messages<CommandEnvelope<OscCommand>>>()
            .drain()
            .collect();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].command_id, command_id);
        assert_eq!(messages[0].undo_id, undo_id);
        assert!(matches!(messages[0].command, OscCommand::DeleteMapping(4)));
    }
}
