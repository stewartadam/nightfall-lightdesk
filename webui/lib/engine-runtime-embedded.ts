// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { EngineRuntimeConfig } from "./engine-runtime-protocol";
import type { EmbeddedRuntimeFactory } from "./engine-runtime-worker-core";

interface EmbeddedBrowserEngine {
  /** Release the WASM-owned engine allocation. */
  free(): void;
  /** Drain discriminator-prefixed CBOR publications. */
  drain_output(): unknown[];
  /** Queue one lifecycle-tracked command envelope. */
  enqueue_command(envelope: unknown): void;
  /** Queue one untracked update envelope. */
  enqueue_update(envelope: unknown): void;
  /** Return engine identity and accumulated tick telemetry. */
  runtime_info(): unknown;
  /** Advance the engine by one frame. */
  tick(deltaMs: number): number;
}

const MAX_EMBEDDED_SHOWFILE_BYTES = 5 * 1024 * 1024;
const Status = {
  Disconnected: "disconnected",
  Connecting: "connecting",
  Connected: "connected",
} as const;

/** Create the demo-only WASM engine adapter using the worker's shared delivery callbacks. */
export const createEmbeddedRuntime: EmbeddedRuntimeFactory = ({
  postStatus,
  postError,
  processEncodedPublication,
  isCurrent,
}) => {
  let embeddedTickTimer: ReturnType<typeof setInterval> | null = null;
  let embeddedEngine: EmbeddedBrowserEngine | null = null;
  let embeddedLastTickMs = 0;
  let embeddedInitMs = 0;
  let embeddedTickRateHz = 0;
  let embeddedTickCount = 0;
  let embeddedTickTotalMs = 0;
  let embeddedTickMaxMs = 0;
  let embeddedWasmMemory: WebAssembly.Memory | null = null;
  /** Stop and release the embedded WASM adapter, if active. */
  function stopEmbeddedRuntime(): void {
    if (embeddedTickTimer) {
      clearInterval(embeddedTickTimer);
      embeddedTickTimer = null;
    }
    embeddedEngine?.free();
    embeddedEngine = null;
    embeddedLastTickMs = 0;
    embeddedInitMs = 0;
    embeddedTickRateHz = 0;
    embeddedTickCount = 0;
    embeddedTickTotalMs = 0;
    embeddedTickMaxMs = 0;
    embeddedWasmMemory = null;
  }

  /** Publish the latest embedded-runtime identity, engine cost, and memory measurements. */
  function postEmbeddedRuntimeInfo(): void {
    if (!embeddedEngine) return;
    self.postMessage({
      type: "runtimeInfo",
      data: {
        ...(embeddedEngine.runtime_info() as object),
        adapter: "embedded-demo",
        initMs: embeddedInitMs,
        tickRateHz: embeddedTickRateHz,
        tickAverageMs:
          embeddedTickCount > 0 ? embeddedTickTotalMs / embeddedTickCount : 0,
        tickMaxMs: embeddedTickMaxMs,
        wasmMemoryBytes: embeddedWasmMemory?.buffer.byteLength ?? 0,
      },
    });
  }

  /** Advance the embedded engine and feed its output through the shared decoder. */
  function tickEmbeddedRuntime(): void {
    if (!embeddedEngine) return;
    const now = performance.now();
    const deltaMs = embeddedLastTickMs === 0 ? 0 : now - embeddedLastTickMs;
    embeddedLastTickMs = now;

    try {
      const tickStartMs = performance.now();
      embeddedEngine.tick(deltaMs);
      const tickMs = performance.now() - tickStartMs;
      embeddedTickCount++;
      embeddedTickTotalMs += tickMs;
      embeddedTickMaxMs = Math.max(embeddedTickMaxMs, tickMs);
      for (const output of embeddedEngine.drain_output()) {
        if (output instanceof Uint8Array) {
          processEncodedPublication(output);
        } else if (output instanceof ArrayBuffer) {
          processEncodedPublication(new Uint8Array(output));
        } else {
          postError("Embedded engine returned an invalid publication buffer");
        }
      }
    } catch (error) {
      postError(`Embedded engine tick failed: ${error}`);
    }
  }

  /** Fetch and bound the immutable showfile selected by the browser-demo release config. */
  async function fetchEmbeddedShowfile(showfileUrl: string): Promise<string> {
    const response = await fetch(showfileUrl, { cache: "force-cache" });
    if (!response.ok) {
      throw new Error(
        `showfile request failed with ${response.status} ${response.statusText}`,
      );
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > MAX_EMBEDDED_SHOWFILE_BYTES
    ) {
      throw new Error(
        `showfile exceeds ${MAX_EMBEDDED_SHOWFILE_BYTES} byte limit`,
      );
    }
    const showfileJson = await response.text();
    if (
      new TextEncoder().encode(showfileJson).byteLength >
      MAX_EMBEDDED_SHOWFILE_BYTES
    ) {
      throw new Error(
        `showfile exceeds ${MAX_EMBEDDED_SHOWFILE_BYTES} byte limit`,
      );
    }
    return showfileJson;
  }

  /** Load and start the worker-local WASM engine adapter. */
  async function startEmbeddedRuntime(
    config: Extract<EngineRuntimeConfig, { mode: "embedded-demo" }>,
    generation: number,
  ): Promise<void> {
    postStatus(Status.Connecting);
    const initStartMs = performance.now();
    let stage = "module import";
    try {
      stage = "showfile fetch";
      const showfileJson = await fetchEmbeddedShowfile(config.showfileUrl);
      if (!isCurrent(generation)) return;

      stage = "module import";
      // Generated by `npm run wasm-build:browser-demo`; its output remains a build artifact.
      const module = await import(
        "../assets/browser-runtime/nightfall_browser_runtime.js"
      );
      const wasmUrl = new URL(
        "../assets/browser-runtime/nightfall_browser_runtime_bg.wasm",
        import.meta.url,
      );
      stage = "WASM initialization";
      const initialized = await module.default({ module_or_path: wasmUrl });
      if (!isCurrent(generation)) return;

      stage = "engine construction";
      if ("stackTraceLimit" in Error) {
        (
          Error as ErrorConstructor & { stackTraceLimit: number }
        ).stackTraceLimit = 100;
      }
      embeddedEngine = new module.BrowserEngine(
        config.sampleId,
        showfileJson,
      ) as unknown as EmbeddedBrowserEngine;

      embeddedInitMs = performance.now() - initStartMs;
      const tickRateHz = Math.min(120, Math.max(1, config.tickRateHz ?? 60));
      embeddedTickRateHz = tickRateHz;
      embeddedWasmMemory = initialized.memory;
      embeddedLastTickMs = performance.now();
      tickEmbeddedRuntime();
      embeddedTickTimer = setInterval(tickEmbeddedRuntime, 1000 / tickRateHz);
      postStatus(Status.Connected);
      postEmbeddedRuntimeInfo();
      self.postMessage({ type: "connected" });
    } catch (error) {
      if (!isCurrent(generation)) return;
      postError(`Unable to start embedded engine during ${stage}: ${error}`);
      postStatus(Status.Disconnected);
    }
  }

  /** Submit one UI payload to the embedded command or update ingress. */
  function submitEmbeddedPayload(data: string | object): void {
    if (!embeddedEngine) return;
    try {
      const payload: unknown =
        typeof data === "string" ? JSON.parse(data) : data;
      if (!payload || typeof payload !== "object") {
        throw new Error("payload must be a JSON object");
      }
      if ("command_id" in payload && "command" in payload) {
        embeddedEngine.enqueue_command(payload);
      } else if ("update" in payload) {
        embeddedEngine.enqueue_update(payload);
      } else {
        throw new Error("payload is neither a command nor an update envelope");
      }
      tickEmbeddedRuntime();
    } catch (error) {
      postError(`Unable to submit embedded engine payload: ${error}`);
    }
  }

  return {
    start: startEmbeddedRuntime,
    stop: stopEmbeddedRuntime,
    submit: submitEmbeddedPayload,
    postInfo: postEmbeddedRuntimeInfo,
  };
};
