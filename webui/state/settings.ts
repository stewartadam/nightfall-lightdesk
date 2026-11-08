// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { atom, computed } from "nanostores";
import {
  type AudioSettings,
  BackupLinkStatus,
  type BackupState,
  CurrentNetworkInterfaceMode,
  type ExternalControlState,
  InputUniverseVisibilityMode,
  type IoRuntimeSettings,
  type NetworkInterfaceInfo,
  type NetworkInterfaceStatus,
  type PanelLayouts,
  type ParameterStreamSettings,
  type ProgrammingSettings,
  SelectionFlattenPolicy,
  SequenceReorderRenumberPolicy,
  type ShowfileSettings,
  type TelemetryState,
  TimeDisplayPreference,
  TimelinePlacementPreference,
  type UiPreferences,
  type UsbDmxDeviceInfo,
} from "../types";

/**
 * Settings sections saved with the showfile, keyed as the backend saves and sends them. Each
 * section belongs to one backend plugin; a section whose plugin is not running keeps its
 * defaults here.
 */
export type SettingsSections = {
  ui: UiPreferences;
  panelLayouts: PanelLayouts;
  programming: ProgrammingSettings;
  parameterStream: ParameterStreamSettings;
  audio: AudioSettings;
  showfile: ShowfileSettings;
  io: IoRuntimeSettings;
};

/** Section values used until the backend sends its own, matching the backend defaults. */
export const DEFAULT_SETTINGS: SettingsSections = {
  ui: {
    time_display: TimeDisplayPreference.Auto,
    timeline_placement: TimelinePlacementPreference.Playhead,
    sequence_reorder_renumber_policy: SequenceReorderRenumberPolicy.Preserve,
  },
  panelLayouts: { layouts: [], default_layout_id: undefined },
  programming: {
    auto_select: false,
    selection_flatten_policy: SelectionFlattenPolicy.Silent,
  },
  parameterStream: { keyframes_only: false },
  audio: { output_device: undefined },
  showfile: { backup_retention: 20 },
  io: {
    network_interface: undefined,
    network_output_enabled: true,
    network_input_enabled: true,
    usb_output_enabled: true,
    network_dmx_outputs: { targets: [] },
    usb_dmx_outputs: { targets: [] },
    input_signal_loss_policy: { type: "Hold" },
    input_signal_loss_timeout: { secs: 2, nanos: 0 },
    input_universe_visibility_mode: InputUniverseVisibilityMode.ExternalOnly,
    dmx_output_rate_hz: 44,
    artnet_sync_enabled: false,
    sacn_sync_enabled: false,
    sacn_sync_universe: 1,
    sacn_priority: 100,
  },
};

/** Current settings sections, updated section by section as the backend reports changes. */
export const $settings = atom<SettingsSections>(DEFAULT_SETTINGS);

/** IO runtime settings section, read-only; IO changes go through the IO settings commands. */
export const $ioSettings = computed($settings, (settings) => settings.io);

/** Increments whenever a backend settings snapshot is applied. */
export const $settingsSnapshotRevision = atom(0);

/** Available network interfaces for selection */
export const $availableNetworkInterfaces = atom<NetworkInterfaceInfo[]>([]);

/** Current/default network interface status */
export const $networkInterfaceStatus = atom<NetworkInterfaceStatus>({
  default_interface: undefined,
  current_interface: undefined,
  current_interface_mode: CurrentNetworkInterfaceMode.SystemDefault,
  selected_interface_missing: false,
});

/** Available audio output devices for selection */
export const $availableAudioDevices = atom<Record<string, string>>({});

/** Compatible USB DMX devices for output transport selection */
export const $availableUsbDmxDevices = atom<UsbDmxDeviceInfo[]>([]);

/** Host-owned telemetry consent and the anonymous identifier reports are grouped under. */
export const $telemetryState = atom<TelemetryState>({
  available: false,
  consent: { decided: false, share_usage: false, share_errors: false },
  install_id: "",
  error: undefined,
});

/** Host-owned backup role: which primary this host follows and how its link stands. */
export const $backupState = atom<BackupState>({
  available: false,
  primary_address: undefined,
  link: BackupLinkStatus.Off,
  error: undefined,
  showfile_name: undefined,
  synced_at_ms: undefined,
  epoch: 0,
  auto_take_over: true,
  backup_address: undefined,
  took_over_automatically_at_ms: undefined,
});

/** Host-owned external control preferences and live listener status. */
export const $externalControlState = atom<ExternalControlState>({
  available: false,
  settings: { enabled: false, interface: undefined },
  listening_addresses: [],
  error: undefined,
});
