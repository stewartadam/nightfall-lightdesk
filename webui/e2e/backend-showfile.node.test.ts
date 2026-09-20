// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { encode } from "cborg";
import { prepareFreshBackendShowfile } from "./backend-showfile";

const originalWebSocket = globalThis.WebSocket;

/** Restores the real transport after each deterministic connection scenario. */
afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
});

/** Installs a scripted transport whose first resync can race a world shutdown. */
function installBackend({
  retireFirstSession = false,
  retireBeforeOpen = false,
  malformed = false,
} = {}) {
  const sockets: ScriptedSocket[] = [];
  const commands: string[] = [];
  /** Models asynchronous backend frames and records connection cleanup. */
  class ScriptedSocket extends EventTarget {
    static OPEN = 1;
    readyState = 0;
    closed = false;
    /** Opens each connection in a later task, as the native websocket does. */
    constructor(_url: string) {
      super();
      sockets.push(this);
      setTimeout(() => {
        if (retireBeforeOpen && sockets[0] === this) {
          this.close();
          return;
        }
        this.readyState = 1;
        this.dispatchEvent(new Event("open"));
      }, 0);
    }
    /** Sends protocol responses or retires the world before its resync reply. */
    send(payload: string): void {
      const command = JSON.parse(payload).command.type;
      commands.push(command);
      setTimeout(() => {
        if (
          command === "NewShowfile" ||
          (retireFirstSession && sockets[0] === this)
        ) {
          this.close();
          return;
        }
        const body = malformed
          ? new Uint8Array([0xff])
          : encode({ type: "ResyncComplete" });
        const frame = new Uint8Array(body.length + 1);
        frame.set(body, 1);
        this.dispatchEvent(new MessageEvent("message", { data: frame.buffer }));
      }, 0);
    }
    /** Closes the transport once, including the ready-state transition. */
    close(): void {
      if (this.closed) return;
      this.closed = true;
      this.readyState = 3;
      this.dispatchEvent(new Event("close"));
    }
  }
  globalThis.WebSocket = ScriptedSocket as unknown as typeof WebSocket;
  return { sockets, commands };
}

/** Verifies the normal initial resync, world replacement, and final resync sequence. */
test("fresh backend setup closes all three completed connections", async () => {
  const { sockets, commands } = installBackend();
  await prepareFreshBackendShowfile(1234);
  assert.deepEqual(commands, ["ResyncState", "NewShowfile", "ResyncState"]);
  assert.equal(sockets.length, 3);
  assert.ok(sockets.every((socket) => socket.closed));
});

/** Covers a listener retiring after accepting the connection but before its open event. */
test("fresh backend setup retries a closed handshake", async () => {
  const { sockets, commands } = installBackend({ retireBeforeOpen: true });
  await prepareFreshBackendShowfile(1234);
  assert.deepEqual(commands, ["ResyncState", "NewShowfile", "ResyncState"]);
  assert.equal(sockets.length, 4);
  assert.ok(sockets.every((socket) => socket.closed));
});

/** Reproduces a world shutdown after resync is sent but before its response arrives. */
test("fresh backend setup reconnects when a world closes during resync", async () => {
  const { sockets, commands } = installBackend({ retireFirstSession: true });
  await prepareFreshBackendShowfile(1234);
  assert.deepEqual(commands, [
    "ResyncState",
    "ResyncState",
    "NewShowfile",
    "ResyncState",
  ]);
  assert.equal(sockets.length, 4);
  assert.ok(sockets.every((socket) => socket.closed));
});

/** Ensures corrupt backend responses fail immediately instead of being retried as disconnects. */
test("fresh backend setup propagates invalid CBOR and closes the connection", async () => {
  const { sockets } = installBackend({ malformed: true });
  await assert.rejects(prepareFreshBackendShowfile(1234));
  assert.equal(sockets.length, 1);
  assert.ok(sockets[0].closed);
});
