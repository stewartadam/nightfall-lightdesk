// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Websocket publication of the undo and redo stacks.

use nightfall_engine::prelude::*;
use serde::{Deserialize, Serialize};

use crate::manager::{UndoGroup, UndoManager};

/// Developer-visible metadata for one undo or redo stack group.
#[typeshare::typeshare]
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct UndoStackEntryMessage {
    /// Zero-based position in execution order, where 0 is the next group to apply.
    pub order: u32,
    /// Human-readable description for the grouped operation.
    pub description: String,
    /// Number of commands grouped into this undoable operation.
    pub entry_count: u32,
    /// Age of the grouped operation when this message was emitted.
    pub age_ms: u32,
    /// Whether this group was preserved from a redo branch by GURQ.
    pub is_gurq_preserved: bool,
    /// Batch ID linking commands that undo or redo together.
    pub undo_id: String,
    /// Human-readable descriptions for commands in this group.
    pub entry_descriptions: Vec<String>,
    /// Correlation IDs linking grouped commands to the original command envelopes.
    pub correlation_ids: Vec<String>,
}

/// Current state of the undo/redo system for UI display
#[typeshare::typeshare]
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct UndoStateMessage {
    /// Whether there are operations available to undo
    pub can_undo: bool,
    /// Whether there are operations available to redo
    pub can_redo: bool,
    /// Description of the next undo operation
    pub undo_description: Option<String>,
    /// Description of the next redo operation
    pub redo_description: Option<String>,
    /// Number of items in the undo stack
    pub undo_depth: u32,
    /// Number of items in the redo stack
    pub redo_depth: u32,
    /// Undo stack groups in undo execution order.
    pub undo_stack: Vec<UndoStackEntryMessage>,
    /// Redo stack groups in redo execution order.
    pub redo_stack: Vec<UndoStackEntryMessage>,
}

/// Undo messages sent to clients.
#[derive(Serialize)]
#[serde(tag = "type", content = "data")]
#[typeshare::typeshare]
enum UndoWsMessage<'a> {
    /// Current undo/redo state
    UndoState(&'a UndoStateMessage),
}

/// Converts an undo group into developer-visible websocket metadata.
fn undo_stack_entry_message(order: usize, group: &UndoGroup) -> UndoStackEntryMessage {
    UndoStackEntryMessage {
        order: order as u32,
        description: group.description.clone(),
        entry_count: group.entries.len() as u32,
        age_ms: group.timestamp.elapsed().as_millis().min(u32::MAX as u128) as u32,
        is_gurq_preserved: group.is_gurq_preserved,
        undo_id: group.undo_id.to_string(),
        entry_descriptions: group
            .entries
            .iter()
            .map(|entry| entry.description.clone())
            .collect(),
        correlation_ids: group
            .entries
            .iter()
            .filter_map(|entry| entry.command_id.map(|command_id| command_id.to_string()))
            .collect(),
    }
}

impl ResourceFeed for UndoManager {
    /// Publishes the undo and redo stacks with their developer-visible group metadata.
    fn publish(&self, sink: &ClientEventSink) {
        send_undo_state(self, sink);
    }
}

/// Sends the current undo and redo stacks to clients.
fn send_undo_state(undo_manager: &UndoManager, broadcaster: &ClientEventSink) {
    let state = UndoStateMessage {
        can_undo: undo_manager.can_undo(),
        can_redo: undo_manager.can_redo(),
        undo_description: undo_manager.peek_undo().map(|g| g.description.clone()),
        redo_description: undo_manager.peek_redo().map(|g| g.description.clone()),
        undo_depth: undo_manager.undo_depth() as u32,
        redo_depth: undo_manager.redo_depth() as u32,
        undo_stack: undo_manager
            .undo_stack()
            .rev()
            .enumerate()
            .map(|(order, group)| undo_stack_entry_message(order, group))
            .collect(),
        redo_stack: undo_manager
            .redo_stack()
            .rev()
            .enumerate()
            .map(|(order, group)| undo_stack_entry_message(order, group))
            .collect(),
    };
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &UndoWsMessage::UndoState(&state),
    );
    tracing::trace!("Sending undo state to websocket clients");
}

#[cfg(test)]
mod tests {
    use bevy_app::{App, Last, Update};
    use bevy_ecs::prelude::*;
    use nightfall_engine::prelude::EnginePayload;

    use super::*;
    use crate::context::UndoContext;
    use crate::manager::UndoEntry;
    use crate::traits::Undoable;

    /// Test command used to verify undo-manager behavior without app dependencies.
    #[derive(Debug, Clone, EnginePayload)]
    struct TestUndoCommand;

    impl Undoable for TestUndoCommand {
        /// Produces no inverse because this command exists only to populate undo metadata.
        fn inverse(&self, _ctx: &UndoContext) -> Option<Box<dyn Undoable>> {
            None
        }

        /// Returns the stable description asserted by the undo-state tests.
        fn description(&self) -> String {
            "Test Undo Command".to_string()
        }
    }

    /// Removes any startup messages from a test websocket receiver.
    fn drain_channel(rx: &async_channel::Receiver<OutboundFrame>) {
        while rx.try_recv().is_ok() {}
    }

    /// Decodes a discriminator-prefixed websocket payload into its JSON representation.
    fn decode_ws_message(raw: &[u8]) -> serde_json::Value {
        assert!(
            !raw.is_empty(),
            "websocket payload must include discriminator"
        );
        minicbor_serde::from_slice::<serde_json::Value>(&raw[1..])
            .expect("failed to decode websocket payload")
    }

    #[test]
    /// Verifies an unchanged undo manager produces no repeated websocket traffic.
    fn send_undo_state_on_change_does_not_broadcast_when_idle() {
        let (tx, rx) = async_channel::unbounded::<OutboundFrame>();
        let mut app = App::new();
        app.insert_resource(ClientEventSink::new(tx));
        app.init_resource::<UndoManager>();
        app.add_systems(
            Update,
            publish_client_feed::<ResourceFeedParam<UndoManager>>
                .run_if(resource_changed::<UndoManager>),
        );
        app.add_systems(Last, crate::systems::finalize_detached_undo_groups);

        // Allow any startup frame noise, then assert no repeated UndoState traffic.
        app.update();
        drain_channel(&rx);

        app.update();
        app.update();

        assert!(
            rx.try_recv().is_err(),
            "did not expect undo state broadcasts while undo manager is idle"
        );
    }

    #[test]
    /// Verifies undo stack changes broadcast complete developer-visible metadata.
    fn send_undo_state_on_change_broadcasts_on_undo_stack_change() {
        let (tx, rx) = async_channel::unbounded::<OutboundFrame>();
        let mut app = App::new();
        app.insert_resource(ClientEventSink::new(tx));
        app.init_resource::<UndoManager>();
        app.add_systems(
            Update,
            publish_client_feed::<ResourceFeedParam<UndoManager>>
                .run_if(resource_changed::<UndoManager>),
        );

        app.update();
        drain_channel(&rx);

        let entry = UndoEntry {
            command: Box::new(TestUndoCommand),
            description: "Add fixture".to_string(),
            command_id: Some(CommandId::new()),
            coalesce_key: None,
        };
        app.world_mut()
            .resource_mut::<UndoManager>()
            .push_undo_group_direct(UndoGroup {
                entries: vec![entry],
                description: "Add fixture".to_string(),
                timestamp: std::time::Instant::now(),
                is_gurq_preserved: false,
                undo_id: UndoId::new(),
            });

        app.update();

        let payload = rx
            .try_recv()
            .expect("expected websocket payload for undo state change");
        let message = decode_ws_message(&payload.bytes);
        assert_eq!(message["type"], "UndoState");
        assert_eq!(message["data"]["can_undo"], true);
        assert_eq!(message["data"]["undo_depth"], 1);
        assert_eq!(message["data"]["undo_description"], "Add fixture");
        assert_eq!(message["data"]["undo_stack"][0]["order"], 0);
        assert_eq!(
            message["data"]["undo_stack"][0]["description"],
            "Add fixture"
        );
        assert_eq!(message["data"]["undo_stack"][0]["entry_count"], 1);
        assert!(
            message["data"]["undo_stack"][0]["age_ms"]
                .as_u64()
                .is_some(),
            "expected undo stack age in milliseconds"
        );
        assert_eq!(message["data"]["undo_stack"][0]["is_gurq_preserved"], false);
        assert_eq!(
            message["data"]["undo_stack"][0]["entry_descriptions"][0],
            "Add fixture"
        );
        assert_eq!(
            message["data"]["undo_stack"][0]["correlation_ids"]
                .as_array()
                .expect("expected correlation IDs")
                .len(),
            1
        );
        assert_eq!(
            message["data"]["redo_stack"]
                .as_array()
                .expect("expected redo stack")
                .len(),
            0
        );
    }
}
