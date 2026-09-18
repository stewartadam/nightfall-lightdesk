// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { engineRuntime } from "../../../lib/engine-runtime";
import type * as types from "../../../types";

/** Generates a backend-compatible UUID string for a new showfile object. */
export function newMasterUid(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

/** Sends one master command through the websocket command bus. */
export function sendMasterCommand(command: types.MasterCommand): void {
  engineRuntime.sendCommand({ module: "MasterCommand", command });
}
