// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { decode } from "cborg";

/** Returns the websocket URL for one test's isolated backend. */
function backendWebsocketUrl(backendPort: number): string {
  return `ws://127.0.0.1:${backendPort}/ws`;
}

/** Decodes one backend websocket frame into the shared message shape. */
async function decodeBackendFrame(data: unknown): Promise<unknown> {
  const bytes =
    data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : data instanceof Blob
          ? new Uint8Array(await data.arrayBuffer())
          : null;
  if (!bytes) return null;
  if (bytes.length < 2) {
    return null;
  }

  return decode(bytes.subarray(1));
}

/** Waits for the requested number of milliseconds. */
async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Attempts one backend websocket connection configured for binary CBOR. */
async function tryOpenBackendSocket(
  backendPort: number,
  timeoutMs: number,
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(backendWebsocketUrl(backendPort));
    socket.binaryType = "arraybuffer";
    /** Releases the handshake listeners after either connection or failure. */
    function cleanup(): void {
      clearTimeout(timeout);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("close", onFailure);
      socket.removeEventListener("error", onFailure);
    }
    /** Hands the connected socket to its protocol exchange. */
    function onOpen(): void {
      cleanup();
      resolve(socket);
    }
    /** Retires failed handshakes so the caller can reconnect promptly. */
    function onFailure(): void {
      cleanup();
      socket.close();
      reject(new Error("Backend websocket connection failed."));
    }
    const timeout = setTimeout(() => {
      cleanup();
      socket.close();
      reject(new Error("Timed out connecting to backend websocket."));
    }, timeoutMs);
    socket.addEventListener("open", onOpen);
    socket.addEventListener("close", onFailure);
    socket.addEventListener("error", onFailure);
  });
}

/** Opens a backend websocket, retrying across world-swap server restarts. */
async function openBackendSocket(
  backendPort: number,
  deadline = Date.now() + 10_000,
): Promise<WebSocket> {
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    try {
      return await tryOpenBackendSocket(
        backendPort,
        Math.max(1, Math.min(10_000, deadline - Date.now())),
      );
    } catch (error) {
      lastError = error;
      await sleep(100);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Timed out connecting to backend websocket.");
}

/** Identifies a connection retired by a backend world swap. */
class BackendSessionClosed extends Error {}

/** Observes resync completion, releasing listeners on every terminal outcome. */
async function waitForSocketReady(
  socket: WebSocket,
  timeoutMs: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    /** Removes this attempt's timer and listeners before settling it. */
    function finish(error?: Error): void {
      clearTimeout(timeout);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      socket.removeEventListener("error", onError);
      if (error) reject(error);
      else resolve();
    }
    /** Decodes readiness frames and reports malformed backend responses immediately. */
    async function onMessage(event: MessageEvent): Promise<void> {
      try {
        const message = await decodeBackendFrame(event.data);
        if (
          message &&
          typeof message === "object" &&
          "type" in message &&
          (message.type === "ResyncComplete" ||
            (message.type === "AppState" &&
              "data" in message &&
              message.data === "Ready"))
        )
          finish();
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    }
    /** Requests a fresh connection when the current world retires its listener. */
    function onClose(): void {
      finish(new BackendSessionClosed("Backend session closed during resync."));
    }
    /** Treats transport failures as a retired session during world replacement. */
    function onError(): void {
      finish(
        new BackendSessionClosed("Backend websocket errored during resync."),
      );
    }
    const timeout = setTimeout(() => {
      finish(new Error("Timed out waiting for backend resync completion."));
    }, timeoutMs);
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
    socket.addEventListener("error", onError);
    if (socket.readyState !== WebSocket.OPEN) {
      onClose();
      return;
    }
    socket.send(
      JSON.stringify({
        command_id: crypto.randomUUID(),
        module: "EngineCommand",
        command: { type: "ResyncState" },
      }),
    );
  });
}

/** Reconnects across world swaps without extending the resync deadline. */
async function waitForBackendReady(backendPort: number): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const socket = await openBackendSocket(backendPort, deadline);
    try {
      await waitForSocketReady(socket, Math.max(1, deadline - Date.now()));
      return;
    } catch (error) {
      if (!(error instanceof BackendSessionClosed)) throw error;
    } finally {
      socket.close();
    }
    await sleep(100);
  }
  throw new Error("Timed out waiting for backend resync completion.");
}

/** Replaces one test backend with a blank showfile and waits until it is ready. */
export async function prepareFreshBackendShowfile(
  backendPort: number,
): Promise<void> {
  await waitForBackendReady(backendPort);
  const socket = await openBackendSocket(backendPort);
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timed out waiting for backend world swap."));
      }, 30_000);

      socket.addEventListener(
        "close",
        () => {
          clearTimeout(timeout);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timeout);
          resolve();
        },
        { once: true },
      );
      socket.send(
        JSON.stringify({
          command_id: crypto.randomUUID(),
          module: "DeskCommand",
          command: { type: "NewShowfile" },
        }),
      );
    });
  } finally {
    socket.close();
  }

  await waitForBackendReady(backendPort);
}
