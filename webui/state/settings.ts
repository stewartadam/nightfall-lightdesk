// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { atom } from "nanostores";
import {
  CurrentNetworkInterfaceMode,
  type DeskSettings,
  type ExternalControlState,
  InputUniverseVisibilityMode,
  type IoRuntimeSettings,
  type NetworkInterfaceInfo,
  type NetworkInterfaceStatus,
  SelectionFlattenPolicy,
  SequenceReorderRenumberPolicy,
  TimeDisplayPreference,
  TimelinePlacementPreference,
  type UsbDmxDeviceInfo,
} from "../types";

/** Current desk-wide settings */
export const $settings = atom<DeskSettings>({
  programmer_auto_select: false,
  audio_device: undefined,
  sequence_reorder_renumber_policy: SequenceReorderRenumberPolicy.Preserve,
  selection_flatten_policy: SelectionFlattenPolicy.Silent,
  time_display_preference: TimeDisplayPreference.Auto,
  timeline_placement_preference: TimelinePlacementPreference.Playhead,
  showfile_backup_retention: 20,
  active_panel_layout: undefined,
});

/** Current transport-owned runtime settings. */
export const $ioSettings = atom<IoRuntimeSettings>({
  network_interface: undefined,
  network_output_enabled: true,
  network_input_enabled: true,
  usb_output_enabled: true,
  network_dmx_outputs: { targets: [] },
  usb_dmx_outputs: { targets: [] },
  input_signal_loss_policy: { type: "Hold" },
  input_signal_loss_timeout: { secs: 2, nanos: 0 },
  input_universe_visibility_mode: InputUniverseVisibilityMode.ExternalOnly,
});

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

/** Host-owned external control preferences and live listener status. */
export const $externalControlState = atom<ExternalControlState>({
  available: false,
  settings: { enabled: false, interface: undefined },
  listening_addresses: [],
  error: undefined,
});
