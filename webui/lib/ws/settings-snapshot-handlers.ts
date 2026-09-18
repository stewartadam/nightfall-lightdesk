// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  applyAvailableAudioDevicesSnapshot,
  applyAvailableNetworkInterfacesSnapshot,
  applyAvailableUsbDmxDevicesSnapshot,
  applyExternalControlStateSnapshot,
  applyIoSettingsSnapshot,
  applyMidiDeviceListSnapshot,
  applyMidiLastEventSnapshot,
  applyMidiMappingsSnapshot,
  applyNetworkInterfaceStatusSnapshot,
  applyOscLastEventSnapshot,
  applyOscListenerStatusSnapshot,
  applyOscMappingsSnapshot,
  applyOscSourcesSnapshot,
  applySettingsSnapshot,
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

  registry.register("MidiLastEvent", (message) => {
    applyMidiLastEventSnapshot(message.data);
  });

  registry.register("OscSources", (message) => {
    applyOscSourcesSnapshot(message.data);
  });

  registry.register("OscMappings", (message) => {
    applyOscMappingsSnapshot(message.data);
  });

  registry.register("OscLastEvent", (message) => {
    applyOscLastEventSnapshot(message.data);
  });

  registry.register("OscListenerStatus", (message) => {
    applyOscListenerStatusSnapshot(message.data);
  });
}
