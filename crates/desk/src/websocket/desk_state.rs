// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Desk-owned definition, settings, device, and undo state projectors.

use super::*;

/// Send group definitions
pub fn send_groups(group_data_provider: Res<DataProvider<Group>>, broadcaster: &ClientEventSink) {
    let groups: Vec<Group> = group_data_provider
        .iter()
        .map(|e| e.value().clone())
        .collect();
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &DeskWsMessage::GroupDefinitions(&groups),
    );
    tracing::trace!("Sending groups definitions to websocket clients");
}

/// Send groups when DataProvider<Group> changes
pub fn send_groups_on_change(
    group_data_provider: Res<DataProvider<Group>>,
    broadcaster: Res<ClientEventSink>,
) {
    if group_data_provider.is_changed() {
        send_groups(group_data_provider, &broadcaster);
    }
}

/// Send master definitions.
pub fn send_masters(master_data_provider: &DataProvider<Master>, broadcaster: &ClientEventSink) {
    let masters: Vec<Master> = master_data_provider
        .iter()
        .map(|entry| entry.value().clone())
        .collect();
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &DeskWsMessage::MasterDefinitions(&masters),
    );
    tracing::trace!("Sending master definitions to websocket clients");
}

/// Send masters when DataProvider<Master> changes.
pub fn send_masters_on_change(
    master_data_provider: Res<DataProvider<Master>>,
    broadcaster: Res<ClientEventSink>,
) {
    if master_data_provider.is_changed() {
        send_masters(&master_data_provider, &broadcaster);
    }
}

/// Send clip definitions to UI
pub fn send_clips(
    exec_query: Query<&Clip>,
    materialized_clips: Query<&MaterializedClip>,
    broadcaster: &ClientEventSink,
) {
    // Collect active clip IDs from MaterializedClips
    let active_clip_ids: std::collections::HashSet<u32> = materialized_clips
        .iter()
        .map(|mexec| mexec.clip_id)
        .collect();

    let clips: Vec<OutboundClipLocal> = exec_query
        .iter()
        .map(|exec| OutboundClipLocal {
            clip: exec.clone(),
            is_active: active_clip_ids.contains(&exec.identifiers.id),
        })
        .collect();
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &DeskWsMessage::ClipDefinitions(&clips),
    );
    tracing::trace!("Sending clip definitions to websocket clients");
}

/// Send clips when MaterializedClip changes (playback starts/stops)
pub fn send_clips_on_change(
    exec_query: Query<&Clip>,
    materialized_clips: Query<&MaterializedClip>,
    added_materialized: Query<&MaterializedClip, Added<MaterializedClip>>,
    removed_materialized: RemovedComponents<MaterializedClip>,
    broadcaster: Res<ClientEventSink>,
) {
    // Trigger when any MaterializedClip is added or removed
    if added_materialized.is_empty() && removed_materialized.is_empty() {
        return;
    }
    tracing::trace!("Sending clips due to MaterializedClip change");
    send_clips(exec_query, materialized_clips, &broadcaster);
}

/// Send clips when any Clip component changes (e.g., rename)
pub fn send_clips_on_clip_change(
    exec_query: Query<&Clip>,
    materialized_clips: Query<&MaterializedClip>,
    changed_clips: Query<&Clip, Changed<Clip>>,
    broadcaster: Res<ClientEventSink>,
) {
    if changed_clips.is_empty() {
        return;
    }
    tracing::trace!("Sending clips due to Clip component change");
    send_clips(exec_query, materialized_clips, &broadcaster);
}

/// Send blueprints when DataProvider<Blueprint> changes
pub fn send_blueprints(
    blueprint_data_provider: Res<DataProvider<Blueprint>>,
    broadcaster: &ClientEventSink,
) {
    let blueprints: Vec<Blueprint> = blueprint_data_provider
        .iter()
        .map(|e| e.value().clone())
        .collect();
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &DeskWsMessage::BlueprintDefinitions(&blueprints),
    );
    tracing::trace!("Sending blueprint definitions to websocket clients");
}

/// Send blueprints when DataProvider<Blueprint> changes
pub fn send_blueprints_on_change(
    blueprint_data_provider: Res<DataProvider<Blueprint>>,
    broadcaster: Res<ClientEventSink>,
) {
    if blueprint_data_provider.is_changed() {
        send_blueprints(blueprint_data_provider, &broadcaster);
    }
}

/// Sends the reverse dependency index used by Blueprint panels and navigation.
pub fn send_blueprint_dependencies(
    reference_index: &BlueprintReferenceIndex,
    broadcaster: &ClientEventSink,
) {
    let dependencies = reference_index
        .snapshot()
        .into_iter()
        .map(|(blueprint_uid, dependents)| OutboundBlueprintDependency {
            blueprint_uid,
            dependents,
        })
        .collect::<Vec<_>>();
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &DeskWsMessage::BlueprintDependencies(&dependencies),
    );
}

/// Sends Blueprint reverse dependencies after an indexing subsystem changes them.
pub fn send_blueprint_dependencies_on_change(
    reference_index: Res<BlueprintReferenceIndex>,
    broadcaster: Res<ClientEventSink>,
) {
    if reference_index.is_changed() {
        send_blueprint_dependencies(&reference_index, &broadcaster);
    }
}

/// Convert an undo group into developer-visible websocket metadata.
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

/// Send current undo/redo state to websocket clients
pub fn send_undo_state(undo_manager: Res<UndoManager>, broadcaster: &ClientEventSink) {
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
        &DeskWsMessage::UndoState(&state),
    );
    tracing::trace!("Sending undo state to websocket clients");
}

/// Send undo state when UndoManager changes
pub fn send_undo_state_on_change(
    undo_manager: Res<UndoManager>,
    broadcaster: Res<ClientEventSink>,
) {
    if undo_manager.is_changed() {
        send_undo_state(undo_manager, &broadcaster);
    }
}

/// Send current desk settings to websocket clients
pub fn send_settings(settings: &crate::settings::DeskSettings, broadcaster: &ClientEventSink) {
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &DeskWsMessage::Settings(settings),
    );
    tracing::trace!("Sending settings to websocket clients");
}

/// Sends current IO runtime settings to websocket clients.
pub fn send_io_settings(settings: &IoRuntimeSettings, broadcaster: &ClientEventSink) {
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &DeskWsMessage::IoSettings(settings),
    );
    tracing::trace!("Sending IO settings to websocket clients");
}

/// Send settings when DeskSettings changes
pub fn send_settings_on_change(
    settings: Res<crate::settings::DeskSettings>,
    broadcaster: Res<ClientEventSink>,
) {
    if !settings.is_changed() {
        return;
    }

    send_settings(&settings, &broadcaster);
}

/// Sends IO runtime settings when the resource changes.
pub fn send_io_settings_on_change(
    settings: Res<IoRuntimeSettings>,
    external_control: Res<ExternalControlState>,
    broadcaster: Res<ClientEventSink>,
) {
    if external_control.is_changed() {
        send_external_control_state(&external_control, &broadcaster);
    }
    if !settings.is_changed() {
        return;
    }

    send_io_settings(&settings, &broadcaster);
}

/// Send available audio devices when the desk-facing resource changes.
pub fn send_available_audio_devices_on_change(
    available_audio_devices: Res<AvailableAudioDevices>,
    broadcaster: Res<ClientEventSink>,
) {
    if !available_audio_devices.is_changed() {
        return;
    }

    send_available_audio_devices(available_audio_devices.as_ref(), &broadcaster);
}

/// Send compatible USB DMX devices when the desk-facing resource changes.
pub fn send_available_usb_dmx_devices_on_change(
    available_usb_dmx_devices: Res<AvailableUsbDmxDevices>,
    broadcaster: Res<ClientEventSink>,
) {
    if !available_usb_dmx_devices.is_changed() {
        return;
    }

    send_available_usb_dmx_devices(&available_usb_dmx_devices.0, &broadcaster);
}

/// Broadcast available network interfaces (helper for callers)
pub fn send_available_network_interfaces(
    network_interface_state: &NetworkInterfaceState,
    broadcaster: &ClientEventSink,
) {
    broadcast_available_network_interfaces(
        &network_interface_state.available_interfaces,
        broadcaster,
    );
}

/// Broadcast current/default network interface status (helper for callers)
pub fn send_network_interface_status(
    settings: &IoRuntimeSettings,
    network_interface_state: &NetworkInterfaceState,
    broadcaster: &ClientEventSink,
) {
    let status = resolve_network_interface_status(settings, network_interface_state);
    broadcast_network_interface_status(&status, broadcaster);
}

/// Broadcast network interface list and current/default status from a single snapshot.
pub fn send_network_interface_state(
    settings: &IoRuntimeSettings,
    network_interface_state: &NetworkInterfaceState,
    broadcaster: &ClientEventSink,
) {
    let status = resolve_network_interface_status(settings, network_interface_state);
    broadcast_available_network_interfaces(
        &network_interface_state.available_interfaces,
        broadcaster,
    );
    broadcast_network_interface_status(&status, broadcaster);
}

/// Broadcast available audio devices (helper for callers)
pub fn send_available_audio_devices(
    devices: &AvailableAudioDevices,
    broadcaster: &ClientEventSink,
) {
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &DeskWsMessage::AvailableAudioDevices(&devices.0),
    );
    tracing::trace!("Sending available audio devices to websocket clients");
}

/// Broadcast compatible USB DMX devices to websocket clients.
pub fn send_available_usb_dmx_devices(devices: &[UsbDmxDeviceInfo], broadcaster: &ClientEventSink) {
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &DeskWsMessage::AvailableUsbDmxDevices(devices),
    );
    tracing::trace!(
        count = devices.len(),
        "Sending available USB DMX devices to websocket clients"
    );
}

/// Serializes and broadcasts the available network-interface list.
fn broadcast_available_network_interfaces(
    interfaces: &[NetworkInterfaceInfo],
    broadcaster: &ClientEventSink,
) {
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &DeskWsMessage::AvailableNetworkInterfaces(interfaces),
    );
    tracing::trace!("Sending available network interfaces to websocket clients");
}

/// Resolves and broadcasts the current/default network-interface status.
fn broadcast_network_interface_status(
    status: &NetworkInterfaceStatus,
    broadcaster: &ClientEventSink,
) {
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &DeskWsMessage::NetworkInterfaceStatus(status),
    );
    tracing::trace!("Sending network interface status to websocket clients");
}

/// Publishes host control preferences and actual listener status to clients.
pub fn send_external_control_state(state: &ExternalControlState, broadcaster: &ClientEventSink) {
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &DeskWsMessage::ExternalControlState(state),
    );
}
