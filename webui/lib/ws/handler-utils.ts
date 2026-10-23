// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { decodeCorrelationId } from "../console-scrollback";
import { measurePerformanceScope } from "../performance-marks";

/** Indexes backend definitions by their stable UID for keyed store lookups. */
export function arrayToUidMap<T extends { identifiers: { uid: string } }>(
  array: T[],
): Record<string, T> {
  const map: Record<string, T> = {};
  for (const item of array) {
    map[item.identifiers.uid] = item;
  }
  return map;
}

/**
 * Measures one named sub-step inside a websocket message dispatch, nested under
 * the `websocket-main.dispatch.<type>` scope the runtime opens per message.
 */
export function measureDispatchStep<T>(
  messageType: string,
  stepName: string,
  callback: () => T,
  detail?: unknown,
): T {
  return measurePerformanceScope(
    `websocket-main.dispatch.${messageType}.${stepName}`,
    callback,
    detail,
  );
}

/**
 * Normalizes direct backend UUID fields into the compact UID keys used by
 * stores, falling back to the string form when the value is not a UUID.
 */
export function normalizeBackendUid(rawUid: unknown): string {
  const decoded = decodeCorrelationId(rawUid);
  if (decoded) return decoded;
  return typeof rawUid === "string" ? rawUid : String(rawUid);
}
