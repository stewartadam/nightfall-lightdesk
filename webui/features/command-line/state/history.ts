// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { bestEffortPersistentAtom } from "../../../lib/best-effort-persistent-atom";
import { getLogger } from "../../../lib/logger";

const log = getLogger(import.meta.url);
const HISTORY_KEY = "commandLineHistory";

/** Decodes persisted command history while dropping malformed entries. */
export function decodeCommandHistory(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

export const commandLineHistory = bestEffortPersistentAtom<string[]>(
  HISTORY_KEY,
  [],
  {
    decode: decodeCommandHistory,
    encode: JSON.stringify,
    onSetError: (error) => log.warn("Failed to persist command history", error),
  },
);

/** Updates command history and persists it as a best-effort side effect. */
export function setCommandHistory(history: string[]): void {
  commandLineHistory.set(history);
}
