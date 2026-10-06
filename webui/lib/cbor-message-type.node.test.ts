// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { encode } from "cborg";
import { peekCborMessageType } from "./cbor-message-type";

/** Encodes a two-entry map in the engine's field order, which cborg's sorted maps would not keep. */
function envelope(first: string, second: string, data: unknown): Uint8Array {
  const entries = [encode(first), encode(second), encode("data"), encode(data)];
  const bytes = new Uint8Array(
    1 + entries.reduce((total, entry) => total + entry.length, 0),
  );
  bytes[0] = 0xa2;
  let offset = 1;
  for (const entry of entries) {
    bytes.set(entry, offset);
    offset += entry.length;
  }
  return bytes;
}

/** Reads the tag from the exact bytes the engine sends for a resync completion. */
test("message type is read from engine-encoded bytes", () => {
  const bytes = new Uint8Array([
    161, 100, 116, 121, 112, 101, 110, 82, 101, 115, 121, 110, 99, 67, 111, 109,
    112, 108, 101, 116, 101,
  ]);
  assert.equal(peekCborMessageType(bytes), "ResyncComplete");
});

/** Reads the tag ahead of a large payload, including tags long enough for a one-byte length. */
test("message type is read without depending on the payload", () => {
  const data = Array.from({ length: 2_000 }, (_, index) => ({ index }));
  assert.equal(
    peekCborMessageType(envelope("type", "ParameterState", data)),
    "ParameterState",
  );
  const longType = "SequenceLookaheadStateUpdated";
  assert.equal(peekCborMessageType(envelope("type", longType, data)), longType);
});

/** Rejects layouts that do not lead with the type tag so callers fall back to a full decode. */
test("message type is undefined for other layouts", () => {
  assert.equal(peekCborMessageType(envelope("kind", "Late", 1)), undefined);
  assert.equal(peekCborMessageType(encode(["type", "List"])), undefined);
  assert.equal(peekCborMessageType(encode({})), undefined);
  assert.equal(peekCborMessageType(new Uint8Array()), undefined);
  assert.equal(
    peekCborMessageType(envelope("type", "Truncated", 1).subarray(0, 8)),
    undefined,
  );
});
