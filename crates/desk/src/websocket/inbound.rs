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
    let command: DeskCommand =
        serde_json::from_value(json).map_err(|e| format!("Failed to parse DeskCommand: {}", e))?;

    if matches!(command, DeskCommand::Eval(_)) {
        world
            .resource_mut::<PendingCommandBuffer>()
            .push(PayloadEnvelope::with_context(
                command_id,
                undo_id,
                Box::new(command),
            ));
        return Ok(());
    }

    world.write_message(CommandEnvelope::with_context(
        command_id,
        undo_id,
        CommandOrigin::WebUi,
        ReplyTarget::ClientBroadcast,
        command,
    ));

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
) {
    for event in events.read() {
        tracing::trace!(?event, "Forwarding UiNotification to UI");
        broadcaster.publish(
            DISCRIMINATOR_NON_DROPPABLE,
            &DeskWsMessage::UiNotification(event),
        );
    }
}

/// Broadcasts queued startup notifications and removes each notification after it is sent.
pub(super) fn flush_pending_ui_notifications(
    pending_ui_notifications: Option<&mut PendingUiNotifications>,
    broadcaster: &ClientEventSink,
) {
    let Some(pending_ui_notifications) = pending_ui_notifications else {
        return;
    };

    for notification in pending_ui_notifications.drain() {
        tracing::trace!(
            ?notification,
            "Replaying pending UiNotification after resync"
        );
        broadcaster.publish(
            DISCRIMINATOR_NON_DROPPABLE,
            &DeskWsMessage::UiNotification(&notification),
        );
    }
}

/// Deserialize and dispatch GroupCommand from JSON.
pub fn deserialize_group_command(
    world: &mut World,
    json: Value,
    command_id: CommandId,
    undo_id: UndoId,
) -> Result<(), String> {
    let command: GroupCommand =
        serde_json::from_value(json).map_err(|e| format!("Failed to parse GroupCommand: {}", e))?;

    world
        .resource_mut::<PendingCommandBuffer>()
        .push(PayloadEnvelope::with_context(
            command_id,
            undo_id,
            Box::new(command),
        ));

    Ok(())
}

/// Deserialize and dispatch MasterCommand from JSON.
pub fn deserialize_master_command(
    world: &mut World,
    json: Value,
    command_id: CommandId,
    undo_id: UndoId,
) -> Result<(), String> {
    let command: MasterCommand = serde_json::from_value(json)
        .map_err(|e| format!("Failed to parse MasterCommand: {}", e))?;

    world
        .resource_mut::<PendingCommandBuffer>()
        .push(PayloadEnvelope::with_context(
            command_id,
            undo_id,
            Box::new(command),
        ));

    Ok(())
}

/// Deserialize and dispatch ClipCommand from JSON.
///
/// ClipCommand is routed through PendingCommandBuffer to enable undo support
/// for commands like StartClip/StopClip.
pub fn deserialize_clip_command(
    world: &mut World,
    json: Value,
    command_id: CommandId,
    undo_id: UndoId,
) -> Result<(), String> {
    let command: ClipCommand =
        serde_json::from_value(json).map_err(|e| format!("Failed to parse ClipCommand: {}", e))?;

    // Route through PendingCommandBuffer so the undo system can capture inverses
    world
        .resource_mut::<PendingCommandBuffer>()
        .push(PayloadEnvelope::with_context(
            command_id,
            undo_id,
            Box::new(command),
        ));

    Ok(())
}

/// Deserialize and dispatch BlueprintCommand from JSON.
pub fn deserialize_blueprint_command(
    world: &mut World,
    json: Value,
    command_id: CommandId,
    undo_id: UndoId,
) -> Result<(), String> {
    let command: BlueprintCommand = serde_json::from_value(json)
        .map_err(|e| format!("Failed to parse BlueprintCommand: {}", e))?;

    world
        .resource_mut::<PendingCommandBuffer>()
        .push(PayloadEnvelope::with_context(
            command_id,
            undo_id,
            Box::new(command),
        ));

    Ok(())
}

/// Deserialize and dispatch SettingsCommand from JSON.
pub fn deserialize_settings_command(
    world: &mut World,
    json: Value,
    command_id: CommandId,
    undo_id: UndoId,
) -> Result<(), String> {
    let command: SettingsCommand = serde_json::from_value(json)
        .map_err(|e| format!("Failed to parse SettingsCommand: {}", e))?;

    world.write_message(CommandEnvelope::with_context(
        command_id,
        undo_id,
        CommandOrigin::WebUi,
        ReplyTarget::ClientBroadcast,
        command,
    ));

    Ok(())
}

/// Deserialize and dispatch InstanceCommand from JSON.
pub fn deserialize_playback_command(
    world: &mut World,
    json: Value,
    command_id: CommandId,
    undo_id: UndoId,
) -> Result<(), String> {
    let command: InstanceCommand = serde_json::from_value(json)
        .map_err(|e| format!("Failed to parse InstanceCommand: {}", e))?;

    world
        .resource_mut::<PendingCommandBuffer>()
        .push(PayloadEnvelope::with_context(
            command_id,
            undo_id,
            Box::new(command),
        ));

    Ok(())
}

/// Deserialize and dispatch ControlCommand from JSON.
pub fn deserialize_control_command(
    world: &mut World,
    json: Value,
    command_id: CommandId,
    undo_id: UndoId,
) -> Result<(), String> {
    let command: crate::controls::ControlCommand = serde_json::from_value(json)
        .map_err(|e| format!("Failed to parse ControlCommand: {}", e))?;

    world
        .resource_mut::<PendingCommandBuffer>()
        .push(PayloadEnvelope::with_context(
            command_id,
            undo_id,
            Box::new(command),
        ));

    Ok(())
}

/// Deserializes and dispatches an untracked control update from JSON.
pub fn deserialize_control_update(world: &mut World, json: Value) -> Result<(), String> {
    let update: crate::controls::ControlUpdate = serde_json::from_value(json)
        .map_err(|e| format!("Failed to parse ControlUpdate: {}", e))?;

    world.write_message(update);

    Ok(())
}
