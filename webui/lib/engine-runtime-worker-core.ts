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
import type { ParameterLayout, ParameterStateFrame } from "../types";
import { peekCborMessageType } from "./cbor-message-type";
import type {
  EngineRuntimeConfig,
  EngineRuntimeWorkerRequest,
} from "./engine-runtime-protocol";
import {
  packParameterStateFrame,
  parameterStateTransfers,
} from "./parameter-state-transfer";
import { RollingTimingSamples } from "./rolling-timing-samples";

/** Optional demo adapter; native workers do not import its WASM implementation. */
export interface EmbeddedRuntime {
  /** Load and initialize the selected showfile while honoring worker cancellation. */
  start(
    config: Extract<EngineRuntimeConfig, { mode: "embedded-demo" }>,
    generation: number,
  ): Promise<void>;
  /** Release the engine and stop its frame timer. */
  stop(): void;
  /** Route a command or update envelope to the engine. */
  submit(data: string | object): void;
  /** Publish engine timing and memory statistics. */
  postInfo(): void;
}

/** Callbacks keep both adapters on the same decoder, delivery queue and lifecycle. */
export type EmbeddedRuntimeFactory = (callbacks: {
  /** Publish connection state to the main thread. */
  postStatus(status: string): void;
  /** Publish an adapter error to the main thread. */
  postError(error: string): void;
  /** Decode and stage an engine publication. */
  processEncodedPublication(bytes: Uint8Array): void;
  /** Determine whether an asynchronous start still belongs to the active runtime. */
  isCurrent(generation: number): boolean;
}) => EmbeddedRuntime;

/** Install worker message handling and telemetry, optionally enabling the demo engine. */
export function startEngineRuntimeWorker(
  createEmbeddedRuntime?: EmbeddedRuntimeFactory,
): void {
  // Connection status values (must match main thread EngineRuntimeStatus)
  const Status = {
    Disconnected: "disconnected",
    Connecting: "connecting",
    Connected: "connected",
  } as const;

  const DISCRIMINATOR_DROPPABLE = 1;
  const STRUCTURAL_QUEUE_LIMIT = 10_000;
  const PARAMETER_STATE_TYPE = "ParameterState";
  const PARAMETER_LAYOUT_TYPE = "ParameterLayout";

  interface QueuedDecodedMessage {
    data: unknown;
    postedAtMs: number;
    deliveryMessageId: number;
    messageType: string;
  }

  /**
   * Newest droppable snapshot of one type, kept encoded until a pull decodes it. Holds
   * the decoded value instead when its type tag could only be read by decoding it.
   */
  interface StagedSnapshot {
    payload: { encoded: Uint8Array } | { decoded: unknown };
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

  /** Returns the metrics entry for one message type, creating it with initial averages. */
  function typeMetricsFor(
    type: string,
    initialDecodeMs: number,
    initialProcessMs: number,
  ): TypeMetrics {
    let m = typeMetrics.get(type);
    if (!m) {
      m = {
        totalCount: 0,
        droppedCount: 0,
        avgDecodeMs: initialDecodeMs,
        avgProcessMs: initialProcessMs,
        windowCount: 0,
        windowStartMs: performance.now(),
      };
      typeMetrics.set(type, m);
    }
    return m;
  }

  /** Folds one deferred snapshot decode into its type's rolling decode average. */
  function recordSnapshotDecode(type: string, decodeTimeMs: number): void {
    const m = typeMetricsFor(type, decodeTimeMs, 0);
    m.avgDecodeMs = EMA_ALPHA * decodeTimeMs + (1 - EMA_ALPHA) * m.avgDecodeMs;
  }

  /**
   * Updates rolling processing, throughput, and drop metrics for one received message, and
   * its decode average when it was decoded on receipt rather than deferred to a pull.
   */
  function recordTypeMetrics(
    type: string,
    decodeTimeMs: number | undefined,
    processTimeMs: number,
    wasDropped: boolean,
  ): void {
    const now = performance.now();
    const m = typeMetricsFor(type, decodeTimeMs ?? 0, processTimeMs);

    m.totalCount++;
    if (wasDropped) m.droppedCount++;
    if (decodeTimeMs !== undefined) {
      m.avgDecodeMs =
        EMA_ALPHA * decodeTimeMs + (1 - EMA_ALPHA) * m.avgDecodeMs;
    }
    m.avgProcessMs =
      EMA_ALPHA * processTimeMs + (1 - EMA_ALPHA) * m.avgProcessMs;

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
  let runtimeGeneration = 0;
  let runtimeMode: EngineRuntimeConfig["mode"] = "remote";
  let isRunning = false;
  let nextHeartbeatId = 1;
  let nextDeliveryMessageId = 1;
  let lastStagedDeliveryMessageId = 0;

  // Pull-frame staging: non-droppable messages remain ordered and lossless, while
  // droppable messages keep only the newest encoded snapshot per message type.
  const structuralQueue: QueuedDecodedMessage[] = [];
  const latestDroppableByType = new Map<string, StagedSnapshot>();
  let structuralOverflowNotified = false;
  let stagingSuspendedForResync = false;
  // Values frames are indexed by the most recent ParameterLayout; frames for any other
  // layout cannot be resolved and are dropped when pulled.
  let parameterLayoutId: number | null = null;

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
    parameterLayoutId = null;
  }

  /**
   * Tracks the parameter layout the backend published last. A staged values frame indexed by an
   * earlier layout is discarded, since the main thread could no longer resolve its slots.
   */
  function acceptParameterLayout(layoutId: number): void {
    if (
      parameterLayoutId !== layoutId &&
      latestDroppableByType.delete(PARAMETER_STATE_TYPE)
    ) {
      droppedCount++;
    }
    parameterLayoutId = layoutId;
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

  /**
   * Keeps the newest snapshot of one droppable type for the next pull, returning whether
   * it replaced an older snapshot that will now never be delivered.
   */
  function stageSnapshot(
    payload: StagedSnapshot["payload"],
    messageType: string,
  ): boolean {
    if (stagingSuspendedForResync) {
      droppedCount++;
      return true;
    }

    const deliveryMessageId = nextDeliveryMessageId++;
    lastStagedDeliveryMessageId = deliveryMessageId;
    const replacedExisting = latestDroppableByType.has(messageType);
    if (replacedExisting) {
      droppedCount++;
    }
    latestDroppableByType.set(messageType, {
      payload,
      postedAtMs: absolutePerformanceNowMs(),
      deliveryMessageId,
      messageType,
    });
    return replacedExisting;
  }

  /**
   * Decodes staged snapshots into pullable messages, skipping any that fail to decode and
   * parameter values frames indexed by a layout other than the latest one.
   */
  function decodeStagedSnapshots(): QueuedDecodedMessage[] {
    const messages: QueuedDecodedMessage[] = [];
    for (const snapshot of latestDroppableByType.values()) {
      let decoded: unknown;
      if ("decoded" in snapshot.payload) {
        decoded = snapshot.payload.decoded;
      } else {
        const decodeStart = performance.now();
        try {
          decoded = decode(snapshot.payload.encoded);
        } catch (error) {
          postError(`CBOR decode error: ${error}`);
          continue;
        }
        const decodeElapsed = performance.now() - decodeStart;
        decodeTimeMs += decodeElapsed;
        recordSnapshotDecode(snapshot.messageType, decodeElapsed);
      }
      if (
        snapshot.messageType === PARAMETER_STATE_TYPE &&
        (decoded as { data: ParameterStateFrame }).data.layout_id !==
          parameterLayoutId
      ) {
        droppedCount++;
        typeMetricsFor(snapshot.messageType, 0, 0).droppedCount++;
        continue;
      }
      messages.push({
        data: decoded,
        postedAtMs: snapshot.postedAtMs,
        deliveryMessageId: snapshot.deliveryMessageId,
        messageType: snapshot.messageType,
      });
    }
    latestDroppableByType.clear();
    return messages;
  }

  /** Stages one decoded ordered payload for the next main-thread frame pull. */
  function stageDecodedMessage(decoded: unknown, messageType: string): boolean {
    if (stagingSuspendedForResync) {
      droppedCount++;
      return true;
    }

    const message = createQueuedDecodedMessage(decoded, messageType);

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

  /**
   * Sends the staged websocket payload batch to the main thread. Snapshots ride in the
   * same batch as ordered messages so a command result is never applied before the state
   * the engine published ahead of it.
   */
  function postPulledMessageBatch(): void {
    const messages = structuralQueue.splice(0, structuralQueue.length);
    messages.push(...decodeStagedSnapshots());

    const transfers: ArrayBuffer[] = [];
    const wireMessages = messages.map((message) => {
      if (message.messageType !== PARAMETER_STATE_TYPE) return message;
      const snapshot = message.data as { data: ParameterStateFrame };
      const packedParameters = packParameterStateFrame(snapshot.data);
      transfers.push(...parameterStateTransfers(packedParameters));
      return { ...message, data: undefined, packedParameters };
    });
    self.postMessage(
      {
        type: "messageBatch",
        messages: wireMessages,
      },
      { transfer: transfers },
    );
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

    // Snapshots are decoded when pulled, so one superseded before the next pull is never
    // decoded and messages queued behind it are received without waiting on its decode.
    if (discriminator === DISCRIMINATOR_DROPPABLE) {
      const snapshotType = peekCborMessageType(cborData);
      if (snapshotType !== undefined) {
        const wasDropped = stageSnapshot({ encoded: cborData }, snapshotType);
        const processElapsed = performance.now() - processStart;
        processingSamples.record(processElapsed, performance.now());
        recordTypeMetrics(snapshotType, undefined, processElapsed, wasDropped);
        return;
      }
    }

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
    } else if (discriminator === DISCRIMINATOR_DROPPABLE) {
      wasDropped = stageSnapshot({ decoded }, msgType);
    } else {
      if (msgType === PARAMETER_LAYOUT_TYPE) {
        acceptParameterLayout(
          (decoded as { data: ParameterLayout }).data.layout_id,
        );
      }
      wasDropped = stageDecodedMessage(decoded, msgType);
    }

    const processElapsed = performance.now() - processStart;
    processingSamples.record(processElapsed, performance.now());
    recordTypeMetrics(msgType, decodeElapsed, processElapsed, wasDropped);
  }

  /** Opens the websocket, decodes binary CBOR messages, and forwards decoded events to the main thread. */
  function connect() {
    stopHeartbeatTimer();
    if (socket) {
      socket.close();
      socket = null;
    }

    postStatus(Status.Connecting);
    // A new connection may reach a different backend world, whose layouts restart.
    parameterLayoutId = null;

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

  const embeddedRuntime = createEmbeddedRuntime?.({
    postStatus,
    postError,
    processEncodedPublication,
    /** Ignore async demo initialization after a stop or replacement start. */
    isCurrent: (generation) => isRunning && generation === runtimeGeneration,
  });

  // Handle messages from main thread
  self.onmessage = (event: MessageEvent<EngineRuntimeWorkerRequest>) => {
    const msg = event.data;

    switch (msg.type) {
      case "start":
        runtimeMode = msg.config.mode;
        runtimeGeneration++;
        isRunning = true;
        resetStagedPayloads();
        if (msg.config.mode === "remote") {
          url = msg.config.websocketUrl;
          connect();
        } else {
          if (embeddedRuntime) {
            void embeddedRuntime.start(msg.config, runtimeGeneration);
          } else {
            postError("This build does not include the embedded demo engine");
            postStatus(Status.Disconnected);
          }
        }
        break;

      case "submit":
        if (runtimeMode === "embedded-demo") {
          embeddedRuntime?.submit(msg.data);
        } else if (socket?.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify(msg.data));
        }
        break;

      case "stop":
        runtimeGeneration++;
        isRunning = false;
        clearReconnectTimer();
        stopHeartbeatTimer();
        embeddedRuntime?.stop();
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
    embeddedRuntime?.postInfo();
  }, STATS_EMIT_INTERVAL_MS);
}
