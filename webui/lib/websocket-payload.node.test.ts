// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeWebsocketPayload } from "./websocket-payload";

/** Verifies repeated update payload objects survive websocket serialization. */
test("sanitizeWebsocketPayload preserves repeated object references", () => {
  const position = { type: "Y", data: 34.567 };
  const payload = sanitizeWebsocketPayload({
    module: "FixtureCommand",
    command: {
      type: "UpdateFixturePlacements",
      data: {
        updates: [
          { id: 311, position },
          { id: 312, position },
        ],
      },
    },
  }) as {
    command: {
      data: {
        updates: Array<{ position?: typeof position }>;
      };
    };
  };

  assert.deepEqual(payload.command.data.updates[0]?.position, position);
  assert.deepEqual(payload.command.data.updates[1]?.position, position);
  assert.notEqual(
    payload.command.data.updates[0]?.position,
    payload.command.data.updates[1]?.position,
  );
});

/** Verifies true cycles are omitted instead of failing JSON serialization. */
test("sanitizeWebsocketPayload drops cyclic references", () => {
  const payload: { type: string; self?: unknown } = { type: "Loop" };
  payload.self = payload;

  assert.deepEqual(sanitizeWebsocketPayload(payload), { type: "Loop" });
});
