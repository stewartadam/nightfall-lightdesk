// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type * as types from "../types";
import { engineRuntime } from "./engine-runtime";
import { getLogger } from "./logger";
import {
  normalizeNetworkDmxOutputs,
  normalizeUsbDmxOutputs,
} from "./network-dmx-output-targets";

const log = getLogger(import.meta.url);

/** Sends updated Network DMX output targets to the backend. */
export function sendNetworkDmxOutputs(
  targets: types.NetworkDmxOutputTarget[],
): void {
  const outputs = normalizeNetworkDmxOutputs({ targets });
  const command: types.SettingsCommand = {
    type: "SetNetworkDmxOutputs",
    data: outputs,
  };
  engineRuntime.sendCommand({ module: "SettingsCommand", command });
  log.info("Requested Network DMX output target update");
}

/** Sends updated USB DMX output targets to the backend. */
export function sendUsbDmxOutputs(targets: types.UsbDmxOutputTarget[]): void {
  const outputs = normalizeUsbDmxOutputs({ targets });
  const command: types.SettingsCommand = {
    type: "SetUsbDmxOutputs",
    data: outputs,
  };
  engineRuntime.sendCommand({ module: "SettingsCommand", command });
  log.info("Requested USB DMX output target update");
}

/** Sends the requested Network DMX output enabled state to the backend. */
export function sendNetworkOutputEnabled(enabled: boolean): void {
  const command: types.SettingsCommand = {
    type: "SetNetworkOutputEnabled",
    data: enabled,
  };
  engineRuntime.sendCommand({ module: "SettingsCommand", command });
  log.info("Requested Network DMX output enabled update");
}

/** Sends the requested Network DMX input enabled state to the backend. */
export function sendNetworkInputEnabled(enabled: boolean): void {
  const command: types.SettingsCommand = {
    type: "SetNetworkInputEnabled",
    data: enabled,
  };
  engineRuntime.sendCommand({ module: "SettingsCommand", command });
  log.info("Requested Network DMX input enabled update");
}

/** Sends the requested USB DMX output enabled state to the backend. */
export function sendUsbOutputEnabled(enabled: boolean): void {
  const command: types.SettingsCommand = {
    type: "SetUsbOutputEnabled",
    data: enabled,
  };
  engineRuntime.sendCommand({ module: "SettingsCommand", command });
  log.info("Requested USB DMX output enabled update");
}
