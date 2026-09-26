// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { decodeCorrelationId } from "../lib/console-scrollback";
import {
  replaceStoredLayoutsFromShowfile,
  type StoredPanelLayout,
} from "../lib/layoutStorage";
import { setStoreAction } from "../lib/nanostore-action";
import type * as types from "../types";
import {
  midiDevices,
  midiLastEvent,
  midiMappings,
  oscLastEvent,
  oscListenerStatus,
  oscMappings,
  oscSources,
} from "./appStores";
import { reconcileLayoutSessions } from "./layout-switcher";
import {
  $availableAudioDevices,
  $availableNetworkInterfaces,
  $availableUsbDmxDevices,
  $externalControlState,
  $ioSettings,
  $networkInterfaceStatus,
  $settings,
  $settingsSnapshotRevision,
} from "./settings";

/** Reads persisted panel layouts from settings while tolerating older snapshots. */
export function panelLayoutsFromSettings(
  settings: types.DeskSettings,
): StoredPanelLayout[] {
  return (
    (
      settings as types.DeskSettings & {
        panel_layouts?: StoredPanelLayout[];
      }
    ).panel_layouts ?? []
  );
}

/** Applies desk settings and refreshes showfile-backed panel layouts. */
export function applySettingsSnapshot(settings: types.DeskSettings): void {
  setStoreAction($settings, "Receive Settings", settings);
  $settingsSnapshotRevision.set($settingsSnapshotRevision.get() + 1);
  replaceStoredLayoutsFromShowfile(panelLayoutsFromSettings(settings));
  reconcileLayoutSessions(
    panelLayoutsFromSettings(settings).map((layout) => layout.id),
  );
}

/** Applies transport-owned runtime settings from the backend. */
export function applyIoSettingsSnapshot(
  settings: types.IoRuntimeSettings,
): void {
  setStoreAction($ioSettings, "Receive IoSettings", settings);
}

/** Applies the host network-interface list to the network settings store. */
export function applyAvailableNetworkInterfacesSnapshot(
  interfaces: types.NetworkInterfaceInfo[],
): void {
  setStoreAction(
    $availableNetworkInterfaces,
    "Receive AvailableNetworkInterfaces",
    interfaces,
  );
}

/** Applies the active network-interface status to the network settings store. */
export function applyNetworkInterfaceStatusSnapshot(
  status: types.NetworkInterfaceStatus,
): void {
  setStoreAction(
    $networkInterfaceStatus,
    "Receive NetworkInterfaceStatus",
    status,
  );
}

/** Applies the host audio device map to the settings store. */
export function applyAvailableAudioDevicesSnapshot(
  devices: Record<string, string>,
): void {
  setStoreAction(
    $availableAudioDevices,
    "Receive AvailableAudioDevices",
    devices,
  );
}

/** Applies compatible USB DMX devices to the settings store. */
export function applyAvailableUsbDmxDevicesSnapshot(
  devices: types.UsbDmxDeviceInfo[],
): void {
  setStoreAction(
    $availableUsbDmxDevices,
    "Receive AvailableUsbDmxDevices",
    devices,
  );
}

/** Applies the current MIDI device list to the MIDI store. */
export function applyMidiDeviceListSnapshot(devices: types.MidiDevice[]): void {
  setStoreAction(midiDevices, "Receive MidiDeviceList", devices);
}

/** Applies the current MIDI mapping list to the MIDI store. */
export function applyMidiMappingsSnapshot(mappings: types.MidiMapping[]): void {
  setStoreAction(
    midiMappings,
    "Receive MidiMappings",
    mappings.map((mapping) => ({
      ...mapping,
      id: decodeCorrelationId(mapping.id) ?? mapping.id,
    })),
  );
}

/** Applies the last observed MIDI event to the MIDI store. */
export function applyMidiLastEventSnapshot(
  event: types.MidiLastEvent | null,
): void {
  setStoreAction(midiLastEvent, "Receive MidiLastEvent", event);
}

/** Applies the current OSC source list to the OSC store. */
export function applyOscSourcesSnapshot(sources: types.OscSource[]): void {
  setStoreAction(oscSources, "Receive OscSources", sources);
}

/** Applies the current OSC mapping list to the OSC store. */
export function applyOscMappingsSnapshot(mappings: types.OscMapping[]): void {
  setStoreAction(
    oscMappings,
    "Receive OscMappings",
    mappings.map((mapping) => ({
      ...mapping,
      id: decodeCorrelationId(mapping.id) ?? mapping.id,
    })),
  );
}

/** Applies the last observed OSC event to the OSC store. */
export function applyOscLastEventSnapshot(
  event: types.OscLastEvent | null,
): void {
  setStoreAction(oscLastEvent, "Receive OscLastEvent", event);
}

/** Applies the current OSC listener status to the OSC store. */
export function applyOscListenerStatusSnapshot(
  status: types.OscListenerStatus | null,
): void {
  setStoreAction(oscListenerStatus, "Receive OscListenerStatus", status);
}

/** Applies host-owned external control preferences and listener health. */
export function applyExternalControlStateSnapshot(
  state: types.ExternalControlState,
): void {
  setStoreAction($externalControlState, "Receive ExternalControlState", state);
}
