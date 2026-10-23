// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type * as types from "../types";
import { isEmbeddedDemoRuntime } from "./runtime-config";

/**
 * Returns whether the backend can create, open, save, import, and export shows, so every
 * showfile entry point hides together when it cannot.
 *
 * Capabilities are cleared while a resync is pending; until they arrive this falls back to
 * the runtime kind, which keeps native menus steady across show loads and reconnects.
 */
export function hasDiskStorage(
  capabilities: types.RuntimeCapabilities | null | undefined,
): boolean {
  return capabilities?.disk_storage ?? !isEmbeddedDemoRuntime();
}
