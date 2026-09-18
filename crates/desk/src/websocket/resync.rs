// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Ordered full-state resynchronization and low-frequency projection scheduling.

use super::*;

/// Websocket request payload for resyncing runtime settings.
#[derive(SystemParam)]
pub(crate) struct ResyncSettingsParams<'w> {
    settings: Res<'w, crate::settings::DeskSettings>,
    io_settings: Res<'w, IoRuntimeSettings>,
    external_control: Res<'w, ExternalControlState>,
    available_audio_devices: Res<'w, AvailableAudioDevices>,
    available_usb_dmx_devices: Res<'w, AvailableUsbDmxDevices>,
    network_interface_state: Res<'w, NetworkInterfaceState>,
}

/// Resync state needed to send backend-owned control snapshots.
#[derive(SystemParam)]
pub(crate) struct ResyncControlParams<'w, 's> {
    masters: Res<'w, DataProvider<Master>>,
    controls: Res<'w, Controls>,
    instance_index: Res<'w, InstanceIndex>,
    controls_query: Query<'w, 's, &'static InstanceControls>,
}

/// Handle ResyncState by sending desk-owned lists immediately
pub(crate) fn handle_resync_state(
    mut events: MessageReader<ResyncRequested>,
    group_data_provider: Res<DataProvider<Group>>,
    exec_query: Query<&Clip>,
    blueprint_data_provider: Res<DataProvider<Blueprint>>,
    blueprint_reference_index: Res<BlueprintReferenceIndex>,
    fixture_data_provider: Res<FixtureDataProviderExt>,
    resync_settings: ResyncSettingsParams,
    parameters_query: Query<&Parameter>,
    layers: Query<super::layers::LayerSnapshotData>,
    instance_query: Query<super::instances::InstanceSnapshotData>,
    materialized_clips: Query<&MaterializedClip>,
    control_params: ResyncControlParams,
    undo_manager: Res<UndoManager>,
    mut pending_ui_notifications: Option<ResMut<PendingUiNotifications>>,
    broadcaster: Res<ClientEventSink>,
) {
    let should_resync = events.read().next().is_some();

    if !should_resync {
        return;
    }

    send_groups(group_data_provider, &broadcaster);
    send_masters(&control_params.masters, &broadcaster);
    send_clips(exec_query, materialized_clips, &broadcaster);
    send_instances(instance_query, materialized_clips, exec_query, &broadcaster);
    send_controls(
        &control_params.controls,
        &exec_query,
        &control_params.masters,
        &materialized_clips,
        &control_params.instance_index,
        &control_params.controls_query,
        &broadcaster,
    );
    send_blueprints(blueprint_data_provider, &broadcaster);
    send_blueprint_dependencies(&blueprint_reference_index, &broadcaster);
    send_settings(&resync_settings.settings, &broadcaster);
    send_io_settings(&resync_settings.io_settings, &broadcaster);
    send_external_control_state(&resync_settings.external_control, &broadcaster);
    send_network_interface_state(
        &resync_settings.io_settings,
        &resync_settings.network_interface_state,
        &broadcaster,
    );
    send_available_audio_devices(
        resync_settings.available_audio_devices.as_ref(),
        &broadcaster,
    );
    send_available_usb_dmx_devices(&resync_settings.available_usb_dmx_devices.0, &broadcaster);
    send_layer_stack(
        &fixture_data_provider,
        parameters_query,
        layers,
        None,
        &broadcaster,
    );
    send_undo_state(undo_manager, &broadcaster);
    flush_pending_ui_notifications(pending_ui_notifications.as_deref_mut(), &broadcaster);
}

/// Emits rate-limited droppable metrics, layer, and playback snapshots.
pub(crate) fn handle_low_freq_updates(
    fixtures_data_provider: Res<FixtureDataProviderExt>,
    parameters_query: Query<&Parameter>,
    layers: Query<super::layers::LayerSnapshotData>,
    io_settings: Res<IoRuntimeSettings>,
    network_interface_state: Res<NetworkInterfaceState>,
    dmx_universes: Res<ConsoleDmxUniverses>,
    network_stats: Res<crate::resources::network_stats::NetworkStats>,
    layer_only_query: Query<&Layer>,
    entities_query: Query<Entity>,
    diagnostics: Res<DiagnosticsStore>,
    mut performance_diagnostics: Diagnostics,
    framepace_stats: Res<FramePaceStats>,
    instance_query: Query<super::instances::InstanceSnapshotData>,
    materialized_clips: Query<&MaterializedClip>,
    clips: Query<&Clip>,
    broadcaster: Res<ClientEventSink>,
) {
    let now_ms = current_time_ms();
    if io_settings.is_changed() || network_interface_state.is_changed() {
        send_network_interface_state(&io_settings, &network_interface_state, &broadcaster);
    }

    // Apply rate limit
    let last_send = LAST_DROPPABLE_SEND_MS.load(std::sync::atomic::Ordering::Relaxed);
    let within_rate_limit = now_ms.saturating_sub(last_send) < DROPPABLE_INTERVAL_MS;

    if within_rate_limit {
        return;
    }
    LAST_DROPPABLE_SEND_MS.store(now_ms, std::sync::atomic::Ordering::Relaxed);

    send_metrics(
        dmx_universes,
        network_stats,
        layer_only_query,
        entities_query,
        diagnostics,
        framepace_stats,
        &broadcaster,
    );
    send_layer_stack(
        &fixtures_data_provider,
        parameters_query,
        layers,
        Some(&mut performance_diagnostics),
        &broadcaster,
    );
    send_instances(instance_query, materialized_clips, clips, &broadcaster);
}

/// Returns wall-clock milliseconds for the low-frequency snapshot rate limiter.
fn current_time_ms() -> u64 {
    web_time::SystemTime::now()
        .duration_since(web_time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// Last time droppable websocket data was sent (ms since epoch)
static LAST_DROPPABLE_SEND_MS: AtomicU64 = AtomicU64::new(0);
const DROPPABLE_INTERVAL_MS: u64 = (1000.0 / 10.0) as u64;
