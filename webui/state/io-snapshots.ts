// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  appendInvocationFailure,
  describeInvocationFailure,
} from "../features/actions/model/invocation-failures";
import { normalizeFixtureUid } from "../lib/binding-utils";
import { markCommandFailurePresented } from "../lib/command-failure-toasts";
import {
  replaceStoredLayoutsFromShowfile,
  type StoredPanelLayout,
} from "../lib/layoutStorage";
import { setStoreAction } from "../lib/nanostore-action";
import type * as types from "../types";
import {
  actionCatalog,
  actionInvocationFailures,
  clientActionInvocation,
  controllerMappingMode,
  midiControlTouches,
  midiDevices,
  midiLastEvent,
  midiMappingDiagnostics,
  midiMappings,
  oscControlTouches,
  oscLastEvent,
  oscListenerStatus,
  oscMappingDiagnostics,
  oscMappings,
  oscSources,
} from "./appStores";
import { reconcileLayoutSessions } from "./layout-switcher";
import { pushToast } from "./notifications";
import {
  $availableAudioDevices,
  $availableNetworkInterfaces,
  $availableUsbDmxDevices,
  $externalControlState,
  $ioSettings,
  $networkInterfaceStatus,
  $settings,
  $settingsSnapshotRevision,
  $telemetryState,
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

/**
 * Returns mappings with their IDs as unhyphenated UUID strings.
 *
 * The binary transport delivers mapping IDs as UUID bytes, which do not survive the JSON
 * cloning used when mappings are edited and sent back, so they are stored as strings.
 */
function withStringMappingIds<M extends { id: string }>(mappings: M[]): M[] {
  return mappings.map((mapping) => ({
    ...mapping,
    id: normalizeFixtureUid(mapping.id),
  }));
}

/** Applies the current MIDI mapping list to the MIDI store. */
export function applyMidiMappingsSnapshot(mappings: types.MidiMapping[]): void {
  setStoreAction(
    midiMappings,
    "Receive MidiMappings",
    withStringMappingIds(mappings),
  );
}

/** Applies the backend's diagnostics of MIDI mappings that cannot invoke their action. */
export function applyMidiMappingDiagnosticsSnapshot(
  diagnostics: types.BindingDiagnostic[],
): void {
  setStoreAction(
    midiMappingDiagnostics,
    "Receive MidiMappingDiagnostics",
    diagnostics,
  );
}

/** Applies the last observed MIDI event to the MIDI store. */
export function applyMidiLastEventSnapshot(
  event: types.MidiLastEvent | null,
): void {
  setStoreAction(midiLastEvent, "Receive MidiLastEvent", event);
}

/** Publishes one frame of MIDI controls touched while controller mapping mode is active. */
export function applyMidiControlTouched(touches: types.MidiLastEvent[]): void {
  setStoreAction(midiControlTouches, "Receive MidiControlTouched", touches);
}

/** Publishes one frame of OSC messages received while controller mapping mode is active. */
export function applyOscControlTouched(touches: types.OscLastEvent[]): void {
  setStoreAction(oscControlTouches, "Receive OscControlTouched", touches);
}

/** Applies how many clients are mapping controllers, which pauses MIDI and OSC actions. */
export function applyControllerMappingModeSnapshot(
  state: types.ControllerMappingModeState,
): void {
  setStoreAction(controllerMappingMode, "Receive ControllerMappingMode", state);
}

/** Publishes one forwarded client action invocation to local listeners. */
export function applyClientActionInvocation(
  invocation: types.ClientActionInvocation,
): void {
  setStoreAction(
    clientActionInvocation,
    "Receive ClientActionInvocation",
    invocation,
  );
}

/**
 * Records a failed action invocation and tells the operator which action failed.
 *
 * When the failure finished a client command, this labelled toast replaces the generic
 * `CommandResult` failure toast, which the backend always sends afterwards.
 */
export function applyActionInvocationFailure(
  failure: types.ActionInvocationFailure,
): void {
  setStoreAction(
    actionInvocationFailures,
    "Receive ActionInvocationFailed",
    appendInvocationFailure(actionInvocationFailures.get(), failure),
  );
  if (failure.command_id != null) {
    markCommandFailurePresented(failure.command_id);
  }
  const toast = describeInvocationFailure(failure, actionCatalog.get());
  pushToast(toast.level, toast.message, toast.ttlMs, [], {
    title: toast.title,
  });
}

/** Applies the backend action catalog used by mapping and binding pickers. */
export function applyActionCatalogSnapshot(
  catalog: types.ActionCatalogEntry[],
): void {
  setStoreAction(actionCatalog, "Receive ActionCatalog", catalog);
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
    withStringMappingIds(mappings),
  );
}

/** Applies the backend's diagnostics of OSC mappings that cannot invoke their action. */
export function applyOscMappingDiagnosticsSnapshot(
  diagnostics: types.BindingDiagnostic[],
): void {
  setStoreAction(
    oscMappingDiagnostics,
    "Receive OscMappingDiagnostics",
    diagnostics,
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

/** Applies host-owned telemetry consent so every client reflects the same choices. */
export function applyTelemetryStateSnapshot(state: types.TelemetryState): void {
  setStoreAction($telemetryState, "Receive TelemetryState", state);
}

/** Applies host-owned external control preferences and listener health. */
export function applyExternalControlStateSnapshot(
  state: types.ExternalControlState,
): void {
  setStoreAction($externalControlState, "Receive ExternalControlState", state);
}
