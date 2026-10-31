// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Inbound command deserialization, routing, and outbound command echoes.

use super::*;

/// Deserializes desk commands and queues eval wrappers for pre-dispatch expansion.
pub fn deserialize_desk_command(
    world: &mut World,
    json: Value,
    command_id: CommandId,
    undo_id: UndoId,
) -> Result<(), String> {
    let command = decode_client_command::<DeskCommand>(json)?;
    if matches!(command, DeskCommand::Eval(_)) {
        buffer_command(world, command_id, undo_id, command);
    } else {
        admit_command(world, command_id, undo_id, command);
    }
    Ok(())
}

/// Forward group commands to UI via byte-oriented broadcaster
/// Forward group commands to UI via broadcaster
///
/// Note: CRUD commands (StoreGroup, RenameGroup, DeleteGroup) are intentionally
/// NOT forwarded here because the command echo would be sent before we know if
/// the operation succeeded. Instead, we rely on send_groups_on_change to send
/// full definitions after changes.
pub fn forward_group_commands(
    mut events: MessageReader<CommandEnvelope<GroupCommand>>,
    _broadcaster: Res<ClientEventSink>,
) {
    // Drain the events to avoid them accumulating
    for _event in events.read() {
        // CRUD commands are not forwarded - rely on send_groups_on_change instead
    }
}

/// Forward clip commands to UI via broadcaster
///
/// Note: RenameClip is intentionally NOT forwarded here because the command
/// echo would be sent before we know if the rename succeeded. Instead, we rely
/// on send_clips_on_clip_change to send full definitions after changes.
pub fn forward_clip_commands(
    mut events: MessageReader<CommandEnvelope<ClipCommand>>,
    broadcaster: Res<ClientEventSink>,
) {
    for event in events.read() {
        if matches!(event.command, ClipCommand::DeleteClip(..)) {
            tracing::trace!(?event, "Forwarding ClipCommand to UI");
            broadcaster.publish(
                DISCRIMINATOR_NON_DROPPABLE,
                &DeskWsMessage::ClipCommand(&event.command),
            );
        }
    }
}

/// Forward blueprint commands to UI via broadcaster
/// Forward blueprint commands to UI via broadcaster
///
/// Note: CRUD commands (StoreBlueprint, RenameBlueprint, DeleteBlueprint) are
/// intentionally NOT forwarded here because the command echo would be sent before
/// we know if the operation succeeded. Instead, we rely on send_blueprints_on_change
/// to send full definitions after changes.
pub fn forward_blueprint_commands(
    mut events: MessageReader<CommandEnvelope<BlueprintCommand>>,
    _broadcaster: Res<ClientEventSink>,
) {
    // Drain the events to avoid them accumulating
    for _event in events.read() {
        // CRUD commands are not forwarded - rely on send_blueprints_on_change instead
    }
}

/// Forward selected desk commands to UI via broadcaster.
///
/// Currently only SetLogLevel is forwarded so CLI log-level changes can update
/// both backend tracing and the UI logger configuration.
pub fn forward_desk_commands(
    mut events: MessageReader<CommandEnvelope<DeskCommand>>,
    broadcaster: Res<ClientEventSink>,
) {
    for event in events.read() {
        if matches!(event.command, DeskCommand::SetLogLevel(_)) {
            tracing::trace!(?event, "Forwarding DeskCommand to UI");
            broadcaster.publish(
                DISCRIMINATOR_NON_DROPPABLE,
                &DeskWsMessage::DeskCommand(&event.command),
            );
        }
    }
}

/// Forwards UI-only notifications to the WebSocket broadcaster.
pub fn forward_ui_notifications(
    mut events: MessageReader<UiNotification>,
    broadcaster: Res<ClientEventSink>,
    mut pending: ResMut<UiNotificationState>,
) {
    for event in events.read() {
        pending.observe(event);
        tracing::trace!(?event, "Forwarding UiNotification to UI");
        broadcaster.publish(
            DISCRIMINATOR_NON_DROPPABLE,
            &DeskWsMessage::UiNotification(event),
        );
    }
}

/// Broadcasts queued transient notifications to every client, since they are drained once and no
/// client has seen them yet, then sends the retained showfile identity to the resyncing clients.
pub(super) fn flush_pending_ui_notifications(
    pending_ui_notifications: Option<&mut UiNotificationState>,
    broadcaster: &ClientEventSink,
    resyncing: &ClientEventSink,
) {
    let Some(pending_ui_notifications) = pending_ui_notifications else {
        return;
    };

    for notification in pending_ui_notifications.take_for_resync() {
        tracing::trace!(
            ?notification,
            "Replaying pending UiNotification after resync"
        );
        let sink = if matches!(notification, UiNotification::CurrentShowfileChanged { .. }) {
            resyncing
        } else {
            broadcaster
        };
        sink.publish(
            DISCRIMINATOR_NON_DROPPABLE,
            &DeskWsMessage::UiNotification(&notification),
        );
    }
}

/// Deserializes and dispatches an untracked master level update from JSON.
pub fn deserialize_master_update(world: &mut World, json: Value) -> Result<(), String> {
    let update: crate::masters::MasterUpdate =
        serde_json::from_value(json).map_err(|e| format!("Failed to parse MasterUpdate: {}", e))?;

    world.write_message(update);

    Ok(())
}

/// Deserializes and dispatches an untracked fader update from JSON.
pub fn deserialize_fader_update(world: &mut World, json: Value) -> Result<(), String> {
    let update: crate::faders::FaderUpdate =
        serde_json::from_value(json).map_err(|e| format!("Failed to parse FaderUpdate: {}", e))?;

    world.write_message(update);

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verifies UI eval input enters the queue that expands before typed dispatch.
    #[test]
    fn eval_deserialization_queues_pre_dispatch_expansion() {
        let mut world = World::new();
        world.init_resource::<PendingCommandBuffer>();
        let command_id = CommandId::new();

        deserialize_desk_command(
            &mut world,
            serde_json::json!({ "type": "Eval", "data": "fps 44" }),
            command_id,
            command_id.into(),
        )
        .expect("eval command should deserialize");

        let queued = world.resource_mut::<PendingCommandBuffer>().drain();
        assert_eq!(queued.len(), 1);
        assert_eq!(queued[0].command_id, command_id);
        assert!(matches!(
            queued[0].payload.as_any().downcast_ref::<DeskCommand>(),
            Some(DeskCommand::Eval(command)) if command == "fps 44"
        ));
    }
}
