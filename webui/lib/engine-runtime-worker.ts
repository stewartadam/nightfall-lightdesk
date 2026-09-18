// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Engine runtime worker using the native backend adapter.
 *
 * This worker owns the WebSocket connection and performs all CBOR decoding,
 * sending only decoded messages to the main thread. This prevents the main
 * thread from being blocked by decode operations (~2.4ms each) and ensures
 * WebSocket messages are received promptly even when the main thread is busy
 * with rendering.
 *
 * Runtime protocol:
 * - Main -> Worker: { type: "start", config } | { type: "submit", data } | { type: "stop" }
 * - Main -> Worker: { type: "pullFrame" } | { type: "resumeAfterResyncRequest" }
 * - Worker -> Main: { type: "messageBatch", messages } | { type: "status", status } | { type: "error", error }
 */

import { decode } from "cborg";
import type {
  EngineRuntimeConfig,
  EngineRuntimeWorkerRequest,
} from "./engine-runtime-protocol";
import { RollingTimingSamples } from "./rolling-timing-samples";

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

// Connection status values (must match main thread EngineRuntimeStatus)
const Status = {
  Disconnected: "disconnected",
  Connecting: "connecting",
  Connected: "connected",
} as const;

const DISCRIMINATOR_DROPPABLE = 1;
const STRUCTURAL_QUEUE_LIMIT = 10_000;
const MAX_EMBEDDED_SHOWFILE_BYTES = 5 * 1024 * 1024;

interface QueuedDecodedMessage {
  data: unknown;
  postedAtMs: number;
  deliveryMessageId: number;
  messageType: string;
}

// Type-level metrics tracking
interface TypeMetrics {
  totalCount: number;
  droppedCount: number;
  avgDecodeMs: number;
  avgProcessMs: number;
  windowCount: number;
  windowStartMs: number;
}

const typeMetrics = new Map<string, TypeMetrics>();
const EMA_ALPHA = 0.1;
const STATS_EMIT_INTERVAL_MS = 1000;
const HEARTBEAT_INTERVAL_MS = 1000;
const HEARTBEAT_EXPIRATION_MS = 10000;
const TRANSPORT_HEARTBEAT_TYPE = "WebSocketHeartbeat";
const TRANSPORT_HEARTBEAT_RESPONSE_TYPE = "WebSocketHeartbeatResponse";

/** Returns the decoded websocket payload type used for per-type metrics. */
function getMessageType(decoded: unknown): string {
  if (decoded && typeof decoded === "object" && "type" in decoded) {
    return (decoded as { type: string }).type;
  }
  return "unknown";
}

/** Updates rolling decode, processing, throughput, and drop metrics for one message type. */
function recordTypeMetrics(
  type: string,
  decodeTimeMs: number,
  processTimeMs: number,
  wasDropped: boolean,
): void {
  const now = performance.now();
  let m = typeMetrics.get(type);

  if (!m) {
    m = {
      totalCount: 0,
      droppedCount: 0,
      avgDecodeMs: decodeTimeMs,
      avgProcessMs: processTimeMs,
      windowCount: 0,
      windowStartMs: now,
    };
    typeMetrics.set(type, m);
  }

  m.totalCount++;
  if (wasDropped) m.droppedCount++;
  m.avgDecodeMs = EMA_ALPHA * decodeTimeMs + (1 - EMA_ALPHA) * m.avgDecodeMs;
  m.avgProcessMs = EMA_ALPHA * processTimeMs + (1 - EMA_ALPHA) * m.avgProcessMs;

  if (now - m.windowStartMs >= 1000) {
    m.windowCount = 1;
    m.windowStartMs = now;
  } else {
    m.windowCount++;
  }
}

let socket: WebSocket | null = null;
let url = "";
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let embeddedTickTimer: ReturnType<typeof setInterval> | null = null;
let embeddedEngine: EmbeddedBrowserEngine | null = null;
let embeddedLastTickMs = 0;
let embeddedInitMs = 0;
let embeddedTickRateHz = 0;
let embeddedTickCount = 0;
let embeddedTickTotalMs = 0;
let embeddedTickMaxMs = 0;
let embeddedWasmMemory: WebAssembly.Memory | null = null;
let runtimeGeneration = 0;
let isRunning = false;
let nextHeartbeatId = 1;
let nextDeliveryMessageId = 1;
let lastStagedDeliveryMessageId = 0;

// Pull-frame staging: non-droppable messages remain ordered and lossless, while
// droppable messages keep only the newest snapshot per message type.
const structuralQueue: QueuedDecodedMessage[] = [];
const latestDroppableByType = new Map<string, QueuedDecodedMessage>();
let structuralOverflowNotified = false;
let stagingSuspendedForResync = false;

// Heartbeat tracking for transport-level latency measurement
const pendingHeartbeats: Map<number, number> = new Map();

// Stats
let rawCount = 0;
let decodeTimeMs = 0;
const processingSamples = new RollingTimingSamples();
let droppedCount = 0;

/** Sends a connection status update to the main thread. */
function postStatus(status: string) {
  self.postMessage({ type: "status", status });
}

/** Sends a worker-level websocket or decode error to the main thread. */
function postError(error: string) {
  self.postMessage({ type: "error", error });
}

/** Clears all staged payloads and lets the worker accept new websocket data. */
function resetStagedPayloads(): void {
  structuralQueue.length = 0;
  latestDroppableByType.clear();
  structuralOverflowNotified = false;
  stagingSuspendedForResync = false;
}

/** Returns a cross-context high-resolution timestamp in milliseconds. */
function absolutePerformanceNowMs(): number {
  return performance.timeOrigin + performance.now();
}

/** Builds one queued decoded payload with timing and sequence diagnostics. */
function createQueuedDecodedMessage(
  decoded: unknown,
  messageType: string,
): QueuedDecodedMessage {
  const deliveryMessageId = nextDeliveryMessageId++;
  lastStagedDeliveryMessageId = deliveryMessageId;
  return {
    data: decoded,
    postedAtMs: absolutePerformanceNowMs(),
    deliveryMessageId,
    messageType,
  };
}

/** Stages one decoded payload for the next main-thread frame pull. */
function stageDecodedMessage(
  decoded: unknown,
  messageType: string,
  isDroppable: boolean,
): boolean {
  if (stagingSuspendedForResync) {
    droppedCount++;
    return true;
  }

  const message = createQueuedDecodedMessage(decoded, messageType);

  if (isDroppable) {
    const replacedExisting = latestDroppableByType.has(messageType);
    if (replacedExisting) {
      droppedCount++;
    }
    latestDroppableByType.set(messageType, message);
    return replacedExisting;
  }

  if (structuralQueue.length >= STRUCTURAL_QUEUE_LIMIT) {
    droppedCount++;
    structuralQueue.length = 0;
    latestDroppableByType.clear();
    stagingSuspendedForResync = true;
    if (!structuralOverflowNotified) {
      structuralOverflowNotified = true;
      self.postMessage({
        type: "resyncRequired",
        reason: `Non-droppable websocket queue exceeded ${STRUCTURAL_QUEUE_LIMIT} messages`,
      });
    }
    return true;
  }

  structuralQueue.push(message);
  if (messageType === "CommandResult") {
    self.postMessage({ type: "commandResultReady" });
  }
  return false;
}

/** Sends the currently staged websocket payload batch to the main thread. */
function postPulledMessageBatch(): void {
  const messages = structuralQueue.splice(0, structuralQueue.length);
  for (const message of latestDroppableByType.values()) {
    messages.push(message);
  }
  latestDroppableByType.clear();

  self.postMessage({
    type: "messageBatch",
    messages,
  });
}

/** Removes transport heartbeat samples that never received a response. */
function pruneExpiredHeartbeats(now = performance.now()): void {
  const cutoff = now - HEARTBEAT_EXPIRATION_MS;
  for (const [id, sentTime] of pendingHeartbeats) {
    if (sentTime < cutoff) {
      pendingHeartbeats.delete(id);
    }
  }
}

/** Sends one transport-owned heartbeat directly over the websocket connection. */
function sendTransportHeartbeat(): void {
  if (socket?.readyState !== WebSocket.OPEN) return;

  const id = nextHeartbeatId;
  nextHeartbeatId =
    nextHeartbeatId >= Number.MAX_SAFE_INTEGER ? 1 : nextHeartbeatId + 1;
  pendingHeartbeats.set(id, performance.now());
  pruneExpiredHeartbeats();
  socket.send(
    JSON.stringify({
      type: TRANSPORT_HEARTBEAT_TYPE,
      data: { id },
    }),
  );
}

/** Starts periodic transport heartbeats for worker-side latency measurement. */
function startHeartbeatTimer(): void {
  stopHeartbeatTimer();
  sendTransportHeartbeat();
  heartbeatTimer = setInterval(sendTransportHeartbeat, HEARTBEAT_INTERVAL_MS);
}

/** Stops periodic transport heartbeats and clears pending latency samples. */
function stopHeartbeatTimer(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  pendingHeartbeats.clear();
}

/** Decode and stage one discriminator-prefixed engine publication. */
function processEncodedPublication(bytes: Uint8Array): void {
  const processStart = performance.now();
  if (bytes.length < 2) return;

  rawCount++;
  const discriminator = bytes[0];
  const cborData = bytes.subarray(1);

  const decodeStart = performance.now();
  let decoded: unknown;
  try {
    decoded = decode(cborData);
  } catch (error) {
    postError(`CBOR decode error: ${error}`);
    return;
  }
  const decodeElapsed = performance.now() - decodeStart;
  decodeTimeMs += decodeElapsed;

  const msgType = getMessageType(decoded);
  let wasDropped = false;
  if (msgType === TRANSPORT_HEARTBEAT_RESPONSE_TYPE) {
    const heartbeat = decoded as { data?: { id?: unknown } };
    const id = heartbeat.data?.id;
    if (typeof id === "number") {
      const sentTime = pendingHeartbeats.get(id);
      if (sentTime !== undefined) {
        self.postMessage({
          type: "latency",
          latency: performance.now() - sentTime,
        });
        pendingHeartbeats.delete(id);
      }
    }
  } else {
    wasDropped = stageDecodedMessage(
      decoded,
      msgType,
      discriminator === DISCRIMINATOR_DROPPABLE,
    );
  }

  const processElapsed = performance.now() - processStart;
  processingSamples.record(processElapsed, performance.now());
  recordTypeMetrics(msgType, decodeElapsed, processElapsed, wasDropped);
}

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
  if (!embeddedEngine || !isRunning) return;
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
    if (!isRunning || generation !== runtimeGeneration) return;

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
    if (!isRunning || generation !== runtimeGeneration) return;

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
    if (generation !== runtimeGeneration) return;
    postError(`Unable to start embedded engine during ${stage}: ${error}`);
    postStatus(Status.Disconnected);
  }
}

/** Submit one UI payload to the embedded command or update ingress. */
function submitEmbeddedPayload(data: string | object): void {
  if (!embeddedEngine) return;
  try {
    const payload: unknown = typeof data === "string" ? JSON.parse(data) : data;
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

/** Opens the websocket, decodes binary CBOR messages, and forwards decoded events to the main thread. */
function connect() {
  stopHeartbeatTimer();
  if (socket) {
    socket.close();
    socket = null;
  }

  postStatus(Status.Connecting);

  socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";

  socket.onopen = () => {
    postStatus(Status.Connected);
    startHeartbeatTimer();
    // Signal main thread to send resync
    self.postMessage({ type: "connected" });
  };

  socket.onclose = () => {
    stopHeartbeatTimer();
    postStatus(Status.Disconnected);
    socket = null;
    scheduleReconnect();
  };

  socket.onerror = () => {
    postError("WebSocket error");
  };

  socket.onmessage = (event: MessageEvent<ArrayBuffer>) => {
    if (!(event.data instanceof ArrayBuffer)) return;
    processEncodedPublication(new Uint8Array(event.data));
  };
}

/** Schedules a single reconnect attempt while the worker is still running. */
function scheduleReconnect() {
  if (reconnectTimer || !isRunning) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (isRunning) connect();
  }, 1000);
}

/** Cancels any pending reconnect attempt. */
function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

// Handle messages from main thread
self.onmessage = (event: MessageEvent<EngineRuntimeWorkerRequest>) => {
  const msg = event.data;

  switch (msg.type) {
    case "start":
      runtimeGeneration++;
      isRunning = true;
      resetStagedPayloads();
      if (msg.config.mode === "remote") {
        url = msg.config.websocketUrl;
        connect();
      } else {
        void startEmbeddedRuntime(msg.config, runtimeGeneration);
      }
      break;

    case "submit":
      if (embeddedEngine) {
        submitEmbeddedPayload(msg.data);
      } else if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(msg.data));
      }
      break;

    case "stop":
      runtimeGeneration++;
      isRunning = false;
      clearReconnectTimer();
      stopHeartbeatTimer();
      stopEmbeddedRuntime();
      resetStagedPayloads();
      if (socket) {
        socket.close();
        socket = null;
      }
      break;

    case "pullFrame":
      postPulledMessageBatch();
      break;

    case "resumeAfterResyncRequest":
      resetStagedPayloads();
      break;
  }
};

// Emit stats to main thread every second
setInterval(() => {
  const now = performance.now();
  const byType: Record<
    string,
    {
      count: number;
      dropped: number;
      avgDecodeMs: number;
      avgProcessMs: number;
      ratePerSec: number;
    }
  > = {};

  for (const [type, m] of typeMetrics) {
    const windowElapsed = (now - m.windowStartMs) / 1000;
    byType[type] = {
      count: m.totalCount,
      dropped: m.droppedCount,
      avgDecodeMs: m.avgDecodeMs,
      avgProcessMs: m.avgProcessMs,
      ratePerSec: windowElapsed > 0 ? m.windowCount / windowElapsed : 0,
    };
  }

  const queueDepth = structuralQueue.length + latestDroppableByType.size;

  self.postMessage({
    type: "stats",
    data: {
      aggregate: {
        totalMessages: rawCount,
        droppedMessages: droppedCount,
        avgDecodeMs: rawCount > 0 ? decodeTimeMs / rawCount : 0,
        queueDepth,
        lastStagedDeliveryMessageId,
        processing: processingSamples.summarize(
          "nightfall:websocket.worker-processing",
          now,
        ),
      },
      byType,
      timestamp: now,
    },
  });
  postEmbeddedRuntimeInfo();
}, STATS_EMIT_INTERVAL_MS);
