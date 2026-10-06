// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { serializeError } from "serialize-error";

/**
 * Serializes an arbitrary value for diagnostics immediately, preserving errors,
 * marking cyclic references, and stringifying bigint values. Safe to use from
 * workers.
 */
export function formatDiagnosticValue(value: unknown): string {
  if (typeof value === "string") return value;
  const seen = new WeakSet<object>();
  try {
    return (
      JSON.stringify(value, (_key, item: unknown) => {
        if (typeof item === "bigint") return String(item);
        if (item && typeof item === "object") {
          if (seen.has(item)) return "[Circular]";
          seen.add(item);
          if (item instanceof Error) return serializeError(item);
        }
        return item;
      }) ?? String(value)
    );
  } catch {
    return "[Unserializable value]";
  }
}
