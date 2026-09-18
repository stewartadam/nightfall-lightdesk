// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Serializes websocket payloads while preserving repeated object references and dropping only cycles.
 */
export function sanitizeWebsocketPayload<T extends object>(data: T): object {
  const ancestors: object[] = [];
  return JSON.parse(
    JSON.stringify(data, function (this: object, _key, value) {
      if (typeof value === "bigint") {
        return Number(value);
      }
      if (typeof value === "object" && value !== null) {
        while (
          ancestors.length > 0 &&
          ancestors[ancestors.length - 1] !== this
        ) {
          ancestors.pop();
        }
        if (ancestors.includes(value)) {
          return undefined;
        }
        ancestors.push(value);
      }
      return value;
    }),
  );
}
