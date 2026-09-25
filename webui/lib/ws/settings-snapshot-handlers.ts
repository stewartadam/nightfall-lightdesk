// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  applyActionCatalogSnapshot,
  applyActionInvocationFailure,
  applyAvailableAudioDevicesSnapshot,
  applyAvailableNetworkInterfacesSnapshot,
  applyAvailableUsbDmxDevicesSnapshot,
  applyClientActionInvocation,
  applyExternalControlStateSnapshot,
  applyIoSettingsSnapshot,
  applyMidiDeviceListSnapshot,
  applyMidiLastEventSnapshot,
  applyMidiMappingDiagnosticsSnapshot,
  applyMidiMappingsSnapshot,
  applyNetworkInterfaceStatusSnapshot,
  applyOscLastEventSnapshot,
  applyOscListenerStatusSnapshot,
  applyOscMappingDiagnosticsSnapshot,
  applyOscMappingsSnapshot,
  applyOscSourcesSnapshot,
  applySettingsSnapshot,
  applyTelemetryStateSnapshot,
} from "../../state/io-snapshots";
import type { WsMessageHandlerRegistry } from "./message-registry";
import type { AnyWsMessage } from "./types";

/** Registers settings and input/output snapshot handlers. */
export function registerSettingsSnapshotHandlers(
  registry: WsMessageHandlerRegistry<AnyWsMessage>,
): void {
  registry.register("Settings", (message) => {
    applySettingsSnapshot(message.data);
  });

  registry.register("ExternalControlState", (message) => {
    applyExternalControlStateSnapshot(message.data);
  });

  registry.register("TelemetryState", (message) => {
    applyTelemetryStateSnapshot(message.data);
  });

  registry.register("IoSettings", (message) => {
    applyIoSettingsSnapshot(message.data);
  });

  registry.register("AvailableNetworkInterfaces", (message) => {
    applyAvailableNetworkInterfacesSnapshot(message.data);
  });

  registry.register("NetworkInterfaceStatus", (message) => {
    applyNetworkInterfaceStatusSnapshot(message.data);
  });

  registry.register("AvailableAudioDevices", (message) => {
    applyAvailableAudioDevicesSnapshot(message.data);
  });

  registry.register("AvailableUsbDmxDevices", (message) => {
    applyAvailableUsbDmxDevicesSnapshot(message.data);
  });

  registry.register("MidiDeviceList", (message) => {
    applyMidiDeviceListSnapshot(message.data);
  });

  registry.register("MidiMappings", (message) => {
    applyMidiMappingsSnapshot(message.data);
  });

  registry.register("MidiMappingDiagnostics", (message) => {
    applyMidiMappingDiagnosticsSnapshot(message.data);
  });

  registry.register("MidiLastEvent", (message) => {
    applyMidiLastEventSnapshot(message.data);
  });

  registry.register("OscSources", (message) => {
    applyOscSourcesSnapshot(message.data);
  });

  registry.register("OscMappings", (message) => {
    applyOscMappingsSnapshot(message.data);
  });

  registry.register("OscMappingDiagnostics", (message) => {
    applyOscMappingDiagnosticsSnapshot(message.data);
  });

  registry.register("OscLastEvent", (message) => {
    applyOscLastEventSnapshot(message.data);
  });

  registry.register("OscListenerStatus", (message) => {
    applyOscListenerStatusSnapshot(message.data);
  });

  registry.register("ActionCatalog", (message) => {
    applyActionCatalogSnapshot(message.data);
  });

  registry.register("ClientActionInvocation", (message) => {
    applyClientActionInvocation(message.data);
  });

  registry.register("ActionInvocationFailed", (message) => {
    applyActionInvocationFailure(message.data);
  });
}
