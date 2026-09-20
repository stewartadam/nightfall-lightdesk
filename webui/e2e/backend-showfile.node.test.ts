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
  rejectCreation = false,
  errorOnSwap = false,
} = {}) {
  const sockets: ScriptedSocket[] = [];
  const commands: string[] = [];
  const showNames: string[] = [];
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
      const request = JSON.parse(payload);
      const command = request.command.type;
      if (command === "NewNamedShowfile") {
        assert.equal(request.command.data.includeSampleData, false);
        showNames.push(request.command.data.name);
      }
      commands.push(command);
      setTimeout(() => {
        if (
          (command === "NewNamedShowfile" && !rejectCreation) ||
          (retireFirstSession && sockets[0] === this)
        ) {
          if (errorOnSwap && command === "NewNamedShowfile") {
            this.dispatchEvent(new Event("error"));
          }
          this.close();
          return;
        }
        const body = malformed
          ? new Uint8Array([0xff])
          : encode(
              command === "NewNamedShowfile"
                ? {
                    type: "CommandResult",
                    data: {
                      command_id: request.command_id,
                      outcome: {
                        type: "Failed",
                        data: {
                          code: "duplicate_name",
                          message: "Show already exists.",
                        },
                      },
                    },
                  }
                : { type: "ResyncComplete" },
            );
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
  return { sockets, commands, showNames };
}

/** Verifies the normal initial resync, world replacement, and final resync sequence. */
test("fresh backend setup closes all three completed connections", async () => {
  const { sockets, commands } = installBackend();
  await prepareFreshBackendShowfile(1234);
  assert.deepEqual(commands, [
    "ResyncState",
    "NewNamedShowfile",
    "ResyncState",
  ]);
  assert.equal(sockets.length, 3);
  assert.ok(sockets.every((socket) => socket.closed));
});

/** Covers a listener retiring after accepting the connection but before its open event. */
test("fresh backend setup retries a closed handshake", async () => {
  const { sockets, commands } = installBackend({ retireBeforeOpen: true });
  await prepareFreshBackendShowfile(1234);
  assert.deepEqual(commands, [
    "ResyncState",
    "NewNamedShowfile",
    "ResyncState",
  ]);
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
    "NewNamedShowfile",
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

/** Ensures seeded default shows and repeated resets never share a creation name. */
test("fresh backend setup creates distinct blank named shows", async () => {
  const { showNames } = installBackend();
  const first = await prepareFreshBackendShowfile(1234);
  const second = await prepareFreshBackendShowfile(1234);
  assert.deepEqual(showNames, [first, second]);
  assert.equal(new Set(showNames).size, 2);
  assert.ok(showNames.every((name) => name.startsWith("playwright-")));
});

/** Reproduces rejected creation without closing the socket or waiting for a timeout. */
test("fresh backend setup surfaces creation errors immediately", {
  timeout: 1000,
}, async () => {
  const { sockets, commands } = installBackend({ rejectCreation: true });
  await assert.rejects(
    prepareFreshBackendShowfile(1234),
    /duplicate_name.*Show already exists/,
  );
  assert.deepEqual(commands, ["ResyncState", "NewNamedShowfile"]);
  assert.ok(sockets.every((socket) => socket.closed));
});

/** Covers backends whose world shutdown emits a transport error before socket close. */
test("fresh backend setup resyncs after a swap transport error", async () => {
  const { sockets, commands } = installBackend({ errorOnSwap: true });
  await prepareFreshBackendShowfile(1234);
  assert.deepEqual(commands, [
    "ResyncState",
    "NewNamedShowfile",
    "ResyncState",
  ]);
  assert.ok(sockets.every((socket) => socket.closed));
});
