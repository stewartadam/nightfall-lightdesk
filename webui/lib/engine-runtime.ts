// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createSignal } from "solid-js";
import { v4 as uuidv4 } from "uuid";
import type { PerformanceMeasureStats } from "../state/appStores";
import { browserDemoAudioHost } from "./browser-demo-audio";
import { getLogger } from "./logger";
import { setStoreAction } from "./nanostore-action";
import { measurePerformanceScope } from "./performance-marks";
import { recordExternalPerformanceMeasure } from "./performance-measure-collector";
import { currentShowfileName } from "./showfile-loading";
import {
  configureActiveShowfileUrl,
  resolveCurrentNativeShowfileUrl,
} from "./showfile-resources";
import {
  createInitialWebsocketBacklogSnapshot,
  DEFAULT_WEBSOCKET_BACKLOG_THRESHOLDS,
  normalizeDeliveryLag,
  refreshWebsocketBacklogSnapshot,
  updateWebsocketBacklogSnapshot,
} from "./websocket-backlog";
import { sanitizeWebsocketPayload } from "./websocket-payload";

export { getWebSocketUrl } from "./api";

const log = getLogger(import.meta.url);
const WEBSOCKET_WORKER_DELIVERY_MEASURE = "nightfall:websocket.worker-to-main";

import EngineRuntimeWorker from "#engine-runtime-worker?worker";
import {
  addConsoleSendError,
  addPendingConsoleCommand,
  applyConsoleCommandResult,
  browserDemoRuntimeInfo,
  clearSelectionFlattenConfirmation,
  cueDefinitionsLoaded,
  dmxUniverseWatch,
  referenceList,
  referenceListWatch,
  runtimeCapabilities,
  selectionFlattenConfirmation,
  sequenceDefinitionsLoaded,
  timelineDefinitionsLoaded,
  type WsPullStats,
  waitForSelectionFlattenConfirmation,
  wsLatency,
  wsStats,
} from "../state/appStores";
import type * as types from "../types";
import {
  abandonCommandCorrelation,
  aliasCommandResult,
  type CommandResultWaiter,
  registerCommandResultWaiter,
  registerPendingCurrentShowfileName,
  rejectPendingCommandWaiters,
  selectionFlattenRetryFromResult,
} from "./command-correlation";
import { normalizeCorrelationId } from "./console-scrollback";
import type { EngineRuntimeConfig } from "./engine-runtime-protocol";
import {
  resetReactiveParameterStateQueue,
  updateImmediateParams,
} from "./parameter-state-publisher";
import {
  carriesParameterState,
  ParameterStateDecoder,
  queuedWorkerMessageData,
  type WorkerQueuedMessage,
} from "./parameter-state-transfer";
import type { ParameterStreamStats } from "./parameter-stream";
import { watchWorkerUncaughtErrors } from "./uncaught-error-reporter";
import { createMainThreadMessageHandlerRegistry } from "./ws/main-thread-handlers";
import type { AnyWsMessage, FixtureParameterState } from "./ws/types";

/** Worker stats per message type */
interface WorkerTypeStats {
  count: number;
  dropped: number;
  avgDecodeMs: number;
  avgProcessMs?: number;
  ratePerSec: number;
}

/** Worker aggregate stats */
interface WorkerAggregateStats {
  totalMessages: number;
  droppedMessages: number;
  avgDecodeMs: number;
  queueDepth: number;
  lastStagedDeliveryMessageId: number;
  parameterStream?: ParameterStreamStats;
  processing?: PerformanceMeasureStats;
}

/** Combined worker stats message */
interface WorkerStatsData {
  aggregate: WorkerAggregateStats;
  byType: Record<string, WorkerTypeStats>;
}

type WebsocketPullHandle =
  | { kind: "raf"; id: number }
  | { kind: "timeout"; id: ReturnType<typeof setTimeout> };

interface WebsocketPullMetricsState {
  lastSampleMs: number;
  requestsSinceSample: number;
  responsesSinceSample: number;
  nonEmptyResponsesSinceSample: number;
  messagesSinceSample: number;
  parameterStatesSinceSample: number;
  lastBatchSize: number;
  lastRequestAtMs: number | null;
  cadenceSamplesSinceSample: number;
  cadenceSumMs: number;
  cadenceMinMs: number;
  cadenceMaxMs: number;
  inFlight: boolean;
}

// Stats for message processing on main thread
let processedCount = 0;
const droppedOnMain = 0;
// Track cumulative dropped counts per message type (preserve across worker restarts)
const cumulativeDroppedByType: Record<string, number> = {};
const lastWorkerDroppedByType: Record<string, number> = {};
let websocketBacklogSnapshot = createInitialWebsocketBacklogSnapshot();
let lastSeenDeliveryMessageId = 0;
let websocketPullHandle: WebsocketPullHandle | null = null;
let urgentWebsocketPullPending = false;
const websocketPullMetrics: WebsocketPullMetricsState = {
  lastSampleMs: performance.now(),
  requestsSinceSample: 0,
  responsesSinceSample: 0,
  nonEmptyResponsesSinceSample: 0,
  messagesSinceSample: 0,
  parameterStatesSinceSample: 0,
  lastBatchSize: 0,
  lastRequestAtMs: null,
  cadenceSamplesSinceSample: 0,
  cadenceSumMs: 0,
  cadenceMinMs: Number.POSITIVE_INFINITY,
  cadenceMaxMs: 0,
  inFlight: false,
};

/** Returns a cross-context high-resolution timestamp in milliseconds. */
function absolutePerformanceNowMs(): number {
  return performance.timeOrigin + performance.now();
}

/** Publishes one websocket worker-to-main delivery sample to rolling metrics. */
function recordWorkerDeliveryMeasure(lagMs: number): void {
  recordExternalPerformanceMeasure(
    WEBSOCKET_WORKER_DELIVERY_MEASURE,
    normalizeDeliveryLag(lagMs),
  );
}

/** Records how long a decoded worker message waited before main-thread handling. */
function recordWorkerDeliveryLag(postedAtMs: unknown): void {
  if (typeof postedAtMs !== "number") return;

  const nowMs = absolutePerformanceNowMs();
  const lagMs = nowMs - postedAtMs;
  const update = updateWebsocketBacklogSnapshot(
    websocketBacklogSnapshot,
    lagMs,
    nowMs,
  );
  websocketBacklogSnapshot = update.snapshot;
  recordWorkerDeliveryMeasure(update.snapshot.lastDeliveryLagMs);

  if (update.shouldWarn) {
    log.warn(
      `WebSocket worker-to-main delivery lag ${update.snapshot.lastDeliveryLagMs.toFixed(
        1,
      )} ms crossed above ${DEFAULT_WEBSOCKET_BACKLOG_THRESHOLDS.lagWarningMs} ms (avg ${update.snapshot.avgDeliveryLagMs.toFixed(
        1,
      )} ms, max ${update.snapshot.maxDeliveryLagMs.toFixed(1)} ms)`,
    );
  }
}

/** Clears a scheduled websocket pull without changing an in-flight request. */
function clearScheduledWebsocketPull(): void {
  if (!websocketPullHandle) return;
  if (websocketPullHandle.kind === "raf") {
    cancelAnimationFrame(websocketPullHandle.id);
  } else {
    clearTimeout(websocketPullHandle.id);
  }
  websocketPullHandle = null;
}

/** Cancels scheduled and pending websocket pulls from the worker. */
function cancelWebsocketPull(): void {
  clearScheduledWebsocketPull();
  urgentWebsocketPullPending = false;
  websocketPullMetrics.inFlight = false;
}

/** Records one main-thread request to pull staged websocket payloads. */
function recordWebsocketPullRequest(nowMs: number): void {
  websocketPullMetrics.requestsSinceSample++;
  if (websocketPullMetrics.lastRequestAtMs !== null) {
    const cadenceMs = nowMs - websocketPullMetrics.lastRequestAtMs;
    websocketPullMetrics.cadenceSamplesSinceSample++;
    websocketPullMetrics.cadenceSumMs += cadenceMs;
    websocketPullMetrics.cadenceMinMs = Math.min(
      websocketPullMetrics.cadenceMinMs,
      cadenceMs,
    );
    websocketPullMetrics.cadenceMaxMs = Math.max(
      websocketPullMetrics.cadenceMaxMs,
      cadenceMs,
    );
  }
  websocketPullMetrics.lastRequestAtMs = nowMs;
}

/** Records one worker response to a websocket pull request. */
function recordWebsocketPullResponse(messages: unknown): void {
  websocketPullMetrics.responsesSinceSample++;
  if (!Array.isArray(messages)) {
    websocketPullMetrics.lastBatchSize = 0;
    return;
  }

  websocketPullMetrics.lastBatchSize = messages.length;
  websocketPullMetrics.messagesSinceSample += messages.length;
  if (messages.length > 0) {
    websocketPullMetrics.nonEmptyResponsesSinceSample++;
  }

  for (const message of messages) {
    if (carriesParameterState(message)) {
      websocketPullMetrics.parameterStatesSinceSample++;
    }
  }
}

/** Resets websocket pull counters that are sampled into the instrumentation panel. */
function resetWebsocketPullMetricsSample(nowMs: number): void {
  websocketPullMetrics.lastSampleMs = nowMs;
  websocketPullMetrics.requestsSinceSample = 0;
  websocketPullMetrics.responsesSinceSample = 0;
  websocketPullMetrics.nonEmptyResponsesSinceSample = 0;
  websocketPullMetrics.messagesSinceSample = 0;
  websocketPullMetrics.parameterStatesSinceSample = 0;
  websocketPullMetrics.cadenceSamplesSinceSample = 0;
  websocketPullMetrics.cadenceSumMs = 0;
  websocketPullMetrics.cadenceMinMs = Number.POSITIVE_INFINITY;
  websocketPullMetrics.cadenceMaxMs = 0;
}

/** Returns the latest websocket pull instrumentation sample and resets counters. */
function snapshotWebsocketPullStats(nowMs: number): WsPullStats {
  const elapsedSeconds = Math.max(
    (nowMs - websocketPullMetrics.lastSampleMs) / 1000,
    0.001,
  );
  const cadenceAvgMs =
    websocketPullMetrics.cadenceSamplesSinceSample > 0
      ? websocketPullMetrics.cadenceSumMs /
        websocketPullMetrics.cadenceSamplesSinceSample
      : null;
  const cadenceMinMs =
    websocketPullMetrics.cadenceSamplesSinceSample > 0
      ? websocketPullMetrics.cadenceMinMs
      : null;
  const cadenceMaxMs =
    websocketPullMetrics.cadenceSamplesSinceSample > 0
      ? websocketPullMetrics.cadenceMaxMs
      : null;

  const sample: WsPullStats = {
    pullsPerSec: websocketPullMetrics.requestsSinceSample / elapsedSeconds,
    responsesPerSec: websocketPullMetrics.responsesSinceSample / elapsedSeconds,
    nonEmptyResponsesPerSec:
      websocketPullMetrics.nonEmptyResponsesSinceSample / elapsedSeconds,
    messagesPerSec: websocketPullMetrics.messagesSinceSample / elapsedSeconds,
    parameterStatesPerSec:
      websocketPullMetrics.parameterStatesSinceSample / elapsedSeconds,
    lastBatchSize: websocketPullMetrics.lastBatchSize,
    cadenceAvgMs,
    cadenceMinMs,
    cadenceMaxMs,
    inFlight: websocketPullMetrics.inFlight,
  };

  resetWebsocketPullMetricsSample(nowMs);

  return sample;
}

/** Sends one pull request for payloads already staged by the websocket worker. */
function requestWebsocketPull(): void {
  if (!engineRuntime.worker || !engineRuntime.isRunning) return;
  websocketPullMetrics.inFlight = true;
  recordWebsocketPullRequest(performance.now());
  engineRuntime.worker.postMessage({ type: "pullFrame" });
}

/** Pulls a terminal command result without waiting for the next browser frame. */
function requestUrgentWebsocketPull(): void {
  urgentWebsocketPullPending = true;
  if (websocketPullMetrics.inFlight) return;
  if (!engineRuntime.worker || !engineRuntime.isRunning) return;

  clearScheduledWebsocketPull();
  urgentWebsocketPullPending = false;
  requestWebsocketPull();
}

/** Schedules one main-thread frame pull for staged websocket worker payloads. */
function scheduleWebsocketPull(): void {
  if (websocketPullHandle || websocketPullMetrics.inFlight) return;
  if (!engineRuntime.worker || !engineRuntime.isRunning) return;

  const pull = () => {
    websocketPullHandle = null;
    requestWebsocketPull();
  };

  if (typeof requestAnimationFrame === "function") {
    websocketPullHandle = {
      kind: "raf",
      id: requestAnimationFrame(pull),
    };
  } else {
    websocketPullHandle = {
      kind: "timeout",
      id: setTimeout(pull, 16),
    };
  }
}

/** Resolves slot-indexed parameter values frames against the backend's latest layout. */
const parameterStateDecoder = new ParameterStateDecoder();

/** Applies one pulled websocket payload from the worker. */
function applyWorkerQueuedMessage(message: WorkerQueuedMessage): void {
  recordWorkerDeliveryLag(message.postedAtMs);
  if (typeof message.deliveryMessageId === "number") {
    lastSeenDeliveryMessageId = message.deliveryMessageId;
  }
  const data = message.packedParameters
    ? measurePerformanceScope("websocket-main.parameter-state.unpack", () =>
        queuedWorkerMessageData(message, parameterStateDecoder),
      )
    : queuedWorkerMessageData(message, parameterStateDecoder);
  if (data) queueWorkerMessage(data);
}

/** Applies a pulled worker batch and schedules the next frame pull. */
function applyWorkerMessageBatch(messages: unknown): void {
  recordWebsocketPullResponse(messages);
  try {
    if (!Array.isArray(messages)) {
      return;
    }

    for (const message of messages) {
      applyWorkerQueuedMessage(message as WorkerQueuedMessage);
    }
  } finally {
    websocketPullMetrics.inFlight = false;
    if (urgentWebsocketPullPending) {
      requestUrgentWebsocketPull();
    } else {
      scheduleWebsocketPull();
    }
  }
}

/**
 * Queue a message from the worker for processing.
 * Pulled messages are dispatched synchronously on the main thread after the
 * worker has ordered non-droppable messages before coalesced snapshots.
 */
function queueWorkerMessage(raw: AnyWsMessage) {
  log.trace(`Received message from websocket worker: ${raw.type}`);

  // ParameterState: always update immediate output for visualizer
  if (raw.type === "ParameterState") {
    measurePerformanceScope(
      "websocket-main.parameter-state.immediate-params",
      () => updateImmediateParams(raw.data as FixtureParameterState[]),
      { fixtureCount: (raw.data as FixtureParameterState[]).length },
    );
  }

  // Dispatch immediately
  measurePerformanceScope(
    `websocket-main.dispatch.${raw.type}`,
    () => dispatchMessage(raw),
    { messageType: raw.type },
  );
}

/**
 * Counts one processed message and routes it to the domain handler registered
 * for its type, warning about types no domain module handles.
 */
function dispatchMessage(raw: AnyWsMessage) {
  // Track that main thread processed a message
  // NOTE: transport heartbeat latency is measured in the worker for timing accuracy
  processedCount++;
  if (!mainThreadMessageHandlers.dispatch(raw)) {
    log.warn(`Unknown WsOutbound type: ${raw.type}`, raw);
  }
}

const EngineRuntimeStatus = {
  Disconnected: "disconnected",
  Connecting: "connecting",
  Connected: "connected",
} as const;

type EngineRuntimeStatus =
  (typeof EngineRuntimeStatus)[keyof typeof EngineRuntimeStatus];

// Preserve signals across HMR to keep components working
const hmrSignals = import.meta.hot?.data;
const [connectionStatus, setConnectionStatus] = hmrSignals?.connectionStatus
  ? [hmrSignals.connectionStatus, hmrSignals.setConnectionStatus]
  : createSignal<EngineRuntimeStatus>(EngineRuntimeStatus.Disconnected);

// Track when resync is complete after reconnection
const [resyncComplete, setResyncComplete] = hmrSignals?.resyncComplete
  ? [hmrSignals.resyncComplete, hmrSignals.setResyncComplete]
  : createSignal<boolean>(false);
const [resyncGeneration, setResyncGeneration] = hmrSignals?.resyncGeneration
  ? [hmrSignals.resyncGeneration, hmrSignals.setResyncGeneration]
  : createSignal<number>(0);
const [backendAppState, setBackendAppState] = hmrSignals?.backendAppState
  ? [hmrSignals.backendAppState, hmrSignals.setBackendAppState]
  : createSignal<types.AppState | null>(null);

const mainThreadMessageHandlers = createMainThreadMessageHandlerRegistry({
  session: {
    resyncGeneration: () => resyncGeneration(),
    markResyncComplete: () => {
      setResyncComplete(true);
      setResyncGeneration(resyncGeneration() + 1);
    },
    setBackendAppState: (state) => setBackendAppState(state),
    requestBackendSessionState: () =>
      engineRuntime.requestBackendSessionState(),
    sendDmxUniverseWatch,
    sendReferenceListWatch,
  },
});

/** Marks the current websocket state as waiting for a fresh backend resync. */
function markResyncPending(): void {
  resetReactiveParameterStateQueue();
  setResyncComplete(false);
  setStoreAction(cueDefinitionsLoaded, "Start Resync", false);
  setStoreAction(sequenceDefinitionsLoaded, "Start Resync", false);
  setStoreAction(timelineDefinitionsLoaded, "Start Resync", false);
  setStoreAction(runtimeCapabilities, "Start Resync", null);
}

// The worker handles WebSocket connection, CBOR decoding, and frame dropping.
// Main thread receives decoded messages and dispatches to stores.
const BACKEND_SESSION_CHANGED_CONFIRMATION_CANCEL_REASON =
  "Selection flatten confirmation canceled: backend session changed";

/** Cancels an outstanding selection-flatten confirmation and resolves its command as an error. */
function cancelPendingSelectionFlattenConfirmation(reason: string) {
  const pendingConfirmation = selectionFlattenConfirmation.get();
  if (!pendingConfirmation) {
    return;
  }

  clearSelectionFlattenConfirmation();
  if (pendingConfirmation.correlationId) {
    applyConsoleCommandResult(pendingConfirmation.correlationId, {
      type: "Failed",
      data: {
        code: "client.selection_confirmation_canceled",
        message: reason,
        details: null,
      },
    });
  }
}

/** Identifies a command whose result was interrupted when its runtime stopped. */
export class EngineRuntimeCommandDisconnectedError extends Error {
  /** Creates the stable transport error used by world-swap command handling. */
  constructor() {
    super("Engine runtime stopped before the command completed");
    this.name = "EngineRuntimeCommandDisconnectedError";
  }
}

/**
 * Returns the console statement carried by a desk `Eval` command envelope, so typed
 * statements sent from panels echo in console scrollback like ones typed at the command line.
 */
function evalStatementOf(data: object): string | undefined {
  const command = (data as { command?: { type?: unknown; data?: unknown } })
    .command;
  return command?.type === "Eval" && typeof command.data === "string"
    ? command.data
    : undefined;
}

export type { EngineRuntimeConfig } from "./engine-runtime-protocol";

/** Transport-neutral facade used by UI features to communicate with the engine. */
export const engineRuntime = {
  worker: null as Worker | null,
  config: null as EngineRuntimeConfig | null,
  isRunning: false,

  /**
   * Discards session-scoped state and requests a full snapshot plus catalogs
   * from the backend. Runs when a connection opens and when the backend
   * replaces its world behind an existing connection.
   */
  requestBackendSessionState() {
    cancelPendingSelectionFlattenConfirmation(
      BACKEND_SESSION_CHANGED_CONFIRMATION_CANCEL_REASON,
    );
    markResyncPending();
    this.sendCommand({
      module: "EngineCommand",
      command: {
        type: "ResyncState",
      } as types.EngineCommand,
    });
    // Native backends and the embedded demo both serve fixture profiles.
    this.sendCommand({
      module: "FixtureLibraryCommand",
      command: {
        type: "ListAvailableFixtures",
      } satisfies types.FixtureLibraryCommand,
    });
    if (this.config?.mode === "remote") {
      // Request native-only catalog state from the remote backend.
      this.sendCommand({
        module: "ObjectLibraryCommand",
        command: {
          type: "ListAvailableObjects",
        } as any,
      });
      this.sendCommand({
        module: "FxModuleCommand",
        command: {
          type: "ListAvailableFxModules",
        } as any,
      });
    }
    scheduleWebsocketPull();
  },

  /** Starts a fresh engine connection using the selected runtime adapter. */
  start(config: EngineRuntimeConfig) {
    if (this.isRunning) this.stop();
    this.config = config;
    this.isRunning = true;
    configureActiveShowfileUrl(
      config.mode === "embedded-demo"
        ? config.showfileUrl
        : resolveCurrentNativeShowfileUrl(),
    );
    if (config.mode === "embedded-demo") {
      const showfileDirectory = new URL(".", config.showfileUrl).pathname
        .split("/")
        .filter(Boolean)
        .pop();
      currentShowfileName.set(
        decodeURIComponent(showfileDirectory ?? "nightfall-demo").replace(
          /\.nightfall-show$/,
          "",
        ),
      );
    }
    browserDemoAudioHost.beginSession();
    websocketBacklogSnapshot = createInitialWebsocketBacklogSnapshot();
    cancelWebsocketPull();
    resetReactiveParameterStateQueue();
    setStoreAction(
      browserDemoRuntimeInfo,
      "Reset Browser Demo Runtime Info",
      null,
    );

    this.worker = new EngineRuntimeWorker();
    const activeWorker = this.worker;
    let lastWorkerError: string | null = null;
    this.worker.onmessage = (event: MessageEvent) => {
      if (this.worker !== activeWorker) return;
      const msg = event.data;

      switch (msg.type) {
        case "status":
          log.trace(`Connection status change: ${msg.status}`);
          setConnectionStatus(msg.status);
          if (msg.status !== EngineRuntimeStatus.Connected) {
            parameterStateDecoder.reset();
          }
          if (msg.status === EngineRuntimeStatus.Disconnected) {
            rejectPendingCommandWaiters(
              new EngineRuntimeCommandDisconnectedError(),
            );
            cancelPendingSelectionFlattenConfirmation(
              BACKEND_SESSION_CHANGED_CONFIRMATION_CANCEL_REASON,
            );
          }
          break;

        case "connected":
          log.trace("Engine runtime connected, requesting resync");
          this.requestBackendSessionState();
          break;

        case "message":
          recordWorkerDeliveryLag(msg.postedAtMs);
          if (typeof msg.deliveryMessageId === "number") {
            lastSeenDeliveryMessageId = msg.deliveryMessageId;
          }
          queueWorkerMessage(msg.data as AnyWsMessage);
          break;

        case "messageBatch":
          applyWorkerMessageBatch(msg.messages);
          break;

        case "commandResultReady":
          requestUrgentWebsocketPull();
          break;

        case "resyncRequired":
          log.warn(
            "WebSocket worker requested resync:",
            msg.reason ?? "unspecified reason",
          );
          markResyncPending();
          this.sendCommand({
            module: "EngineCommand",
            command: {
              type: "ResyncState",
            } as types.EngineCommand,
          });
          this.worker?.postMessage({ type: "resumeAfterResyncRequest" });
          break;

        case "latency":
          recordExternalPerformanceMeasure(
            "nightfall:websocket.transport-rtt",
            msg.latency,
          );
          // Latency measured in the worker (more accurate)
          setStoreAction(wsLatency, "Receive WebSocket Latency", msg.latency);
          break;

        case "performanceMeasure":
          recordExternalPerformanceMeasure(msg.data.name, msg.data.durationMs);
          break;

        case "runtimeInfo":
          setStoreAction(
            browserDemoRuntimeInfo,
            "Receive Browser Demo Runtime Info",
            msg.data,
          );
          break;

        case "stats": {
          const workerStats = msg.data as WorkerStatsData;
          websocketBacklogSnapshot = refreshWebsocketBacklogSnapshot(
            websocketBacklogSnapshot,
            absolutePerformanceNowMs(),
          );
          // Merge worker 'dropped' counts into cumulative totals so UI shows
          // a monotonic, cumulative dropped count per type instead of the
          // worker-local windowed counters that reset on reconnect.
          const mergedByType: typeof workerStats.byType = {};
          for (const [type, metrics] of Object.entries(workerStats.byType)) {
            const workerDropped = metrics?.dropped ?? 0;
            const last = lastWorkerDroppedByType[type] ?? 0;
            const delta = workerDropped - last;
            if (delta > 0) {
              cumulativeDroppedByType[type] =
                (cumulativeDroppedByType[type] ?? 0) + delta;
            }
            lastWorkerDroppedByType[type] = workerDropped;

            mergedByType[type] = {
              ...metrics,
              // expose cumulative dropped count to UI consumers
              dropped: cumulativeDroppedByType[type] ?? 0,
            };
          }

          const statsTimestamp = performance.now();
          setStoreAction(wsStats, "Receive WebSocket Stats", {
            worker: workerStats.aggregate,
            main: {
              processedCount,
              droppedCount: droppedOnMain,
              lastDeliveryLagMs: websocketBacklogSnapshot.lastDeliveryLagMs,
              avgDeliveryLagMs: websocketBacklogSnapshot.avgDeliveryLagMs,
              maxDeliveryLagMs: websocketBacklogSnapshot.maxDeliveryLagMs,
              backlogLagging: websocketBacklogSnapshot.lagging,
              lastSeenDeliveryMessageId,
              pull: snapshotWebsocketPullStats(statsTimestamp),
            },
            byType: mergedByType,
            timestamp: statsTimestamp,
          });
          break;
        }

        case "error":
          lastWorkerError = msg.error;
          log.error("Worker error:", msg.error);
          break;
      }
    };

    watchWorkerUncaughtErrors(activeWorker, "engine runtime", (failure) => {
      // A rejection leaves the worker running; a thrown exception may have lost the command.
      if (failure.kind !== "error" || this.worker !== activeWorker) return;
      const reported = lastWorkerError
        ? ` (last reported worker error: ${lastWorkerError})`
        : "";
      rejectPendingCommandWaiters(
        new Error(
          `WebSocket worker failed before the command completed: ${failure.name}: ${failure.message}${reported}`,
        ),
      );
    });

    // Tell worker to connect
    this.worker.postMessage({ type: "start", config });
    scheduleWebsocketPull();
  },

  /** Stops the active adapter and rejects all pending command waiters. */
  stop() {
    log.trace("Stopping engine runtime");
    this.isRunning = false;
    configureActiveShowfileUrl(null);
    browserDemoAudioHost.beginSession();
    websocketBacklogSnapshot = createInitialWebsocketBacklogSnapshot();
    cancelWebsocketPull();
    resetReactiveParameterStateQueue();
    setStoreAction(
      browserDemoRuntimeInfo,
      "Reset Browser Demo Runtime Info",
      null,
    );
    rejectPendingCommandWaiters(new EngineRuntimeCommandDisconnectedError());
    if (this.worker) {
      this.worker.postMessage({ type: "stop" });
      this.worker.terminate();
      this.worker = null;
    }
    this.config = null;
    setConnectionStatus(EngineRuntimeStatus.Disconnected);
  },

  /**
   * Sends one lifecycle-tracked command without waiting for its result. Failures still surface
   * through the shared result handler. Returns the command id, or null when the runtime is
   * disconnected or the payload cannot be serialized.
   */
  sendCommand(data: object, consoleCommandText?: string): string | null {
    try {
      return this.postCommand(data, consoleCommandText);
    } catch {
      return null;
    }
  },

  /**
   * Stamps command and undo identity onto a command envelope, registers the optional result
   * waiter, and posts the envelope to the worker. Console scrollback tracks the operator text,
   * or the statement of a desk `Eval` command when no text is given. Throws when the runtime
   * is disconnected or the payload cannot be serialized, after recording a console send error.
   */
  postCommand(
    data: object,
    consoleCommandText?: string,
    waiter?: CommandResultWaiter,
  ): string {
    const consoleText = consoleCommandText ?? evalStatementOf(data);
    if (!this.worker || !this.isRunning) {
      log.warn("Tried to send but worker is not running");
      if (consoleText) {
        addConsoleSendError(
          consoleText,
          "Failed to send command: disconnected",
        );
      }
      throw new Error("WebSocket worker is not running");
    }

    const commandId = uuidv4();
    const commandKey = normalizeCorrelationId(commandId);
    const envelope = data as Record<string, unknown>;
    envelope.command_id = commandId;
    envelope.undo_id ??= commandId;
    registerPendingCurrentShowfileName(commandId, data);
    if (waiter) {
      registerCommandResultWaiter(commandKey, waiter);
    }

    try {
      const payload = sanitizeWebsocketPayload(data);
      log.debug("Sending:", payload);
      this.worker.postMessage({ type: "submit", data: payload });
    } catch (error) {
      abandonCommandCorrelation(commandKey);
      log.error("Failed to send command:", error);
      throw error;
    }
    // Results arrive in a later task, so console rendering can follow the send.
    if (consoleText) {
      addPendingConsoleCommand(consoleText, commandId, "UI");
    }
    return commandId;
  },

  /** Submits an operator-approved retry and associates its result with the rejected command. */
  resubmitAfterConfirmation(
    retry: import("../state/appStores").SelectionFlattenRetry,
    rejectedCorrelationId?: string,
  ): string | null {
    const commandId = this.sendCommand(retry);
    if (commandId && rejectedCorrelationId) {
      aliasCommandResult(commandId, rejectedCorrelationId);
    }
    return commandId;
  },

  /** Sends an untracked domain update without command or undo identity. */
  sendUpdate(module: string, update: object, shouldLog = true): boolean {
    if (!this.worker || !this.isRunning) {
      log.warn("Tried to send update but worker is not running");
      return false;
    }

    try {
      const payload = sanitizeWebsocketPayload({ module, update });
      if (shouldLog) {
        log.debug("Sending update:", payload);
      }
      this.worker.postMessage({ type: "submit", data: payload });
      return true;
    } catch (error) {
      log.error("Failed to sanitize update payload:", error);
      return false;
    }
  },

  /**
   * Send a command and wait for the CommandResult response.
   * Returns a promise that resolves with the CommandResult.
   * @param data The command payload (will have its command identity added automatically)
   * @param consoleCommandText Optional operator text to track in console scrollback
   */
  sendCommandAndAwait(
    data: object,
    consoleCommandText?: string,
  ): Promise<types.CommandResult> {
    let originalCommandKey: string | undefined;
    const pendingResult = new Promise<types.CommandResult>(
      (resolve, reject) => {
        const commandId = this.postCommand(data, consoleCommandText, {
          resolve,
          reject,
        });
        originalCommandKey = normalizeCorrelationId(commandId);
      },
    );
    return pendingResult.then(async (result) => {
      const retry = selectionFlattenRetryFromResult(result);
      if (!retry) {
        return result;
      }

      const confirmed = await waitForSelectionFlattenConfirmation(
        retry,
        originalCommandKey,
      );
      if (!confirmed) {
        if (originalCommandKey) {
          applyConsoleCommandResult(originalCommandKey, result.outcome);
        }
        return result;
      }

      const retryResult = await this.sendCommandAndAwait(retry);
      if (originalCommandKey) {
        applyConsoleCommandResult(originalCommandKey, retryResult.outcome);
      }
      return retryResult;
    });
  },
};

/**
 * Tells the backend which universes' channel values this client wants, replacing what it asked
 * for before. An empty list stops the values.
 */
function sendDmxUniverseWatch(
  universes: readonly types.DmxUniverseKey[],
): void {
  if (!engineRuntime.isRunning) return;
  const watch: types.DmxUniverseWatch = { universes: [...universes] };
  engineRuntime.sendUpdate("DmxUniverseWatch", watch, false);
}

const stopDmxUniverseWatchSync = dmxUniverseWatch.listen(sendDmxUniverseWatch);

/**
 * Tells the backend whether this client wants the full reference list, which it then keeps
 * current with an update after every change. Stopping the watch also drops the list this client
 * holds.
 */
function sendReferenceListWatch(references: boolean): void {
  if (!references && referenceList.get().size > 0) {
    setStoreAction(referenceList, "Stop watching references", new Map());
  }
  if (!engineRuntime.isRunning) return;
  const watch: types.ReferenceWatch = { references };
  engineRuntime.sendUpdate("ReferenceWatch", watch, false);
}

const stopReferenceListWatchSync = referenceListWatch.listen(
  sendReferenceListWatch,
);

export {
  backendAppState,
  connectionStatus,
  EngineRuntimeStatus,
  markResyncPending,
  resyncComplete,
  resyncGeneration,
};

// Properly clean up WebSocket connection when this module is hot-reloaded.
// Without this, old workers continue running and cause page hangs.

if (import.meta.hot) {
  // Store connection state and signals before disposal
  import.meta.hot.dispose((data) => {
    data.wasConnected = engineRuntime.isRunning;
    data.config = engineRuntime.config;
    // Preserve signals across HMR so components keep working
    data.connectionStatus = connectionStatus;
    data.setConnectionStatus = setConnectionStatus;
    data.resyncComplete = resyncComplete;
    data.setResyncComplete = setResyncComplete;
    data.resyncGeneration = resyncGeneration;
    data.setResyncGeneration = setResyncGeneration;
    data.backendAppState = backendAppState;
    data.setBackendAppState = setBackendAppState;
    stopDmxUniverseWatchSync();
    stopReferenceListWatchSync();
    log.info("HMR dispose: disconnecting WebSocket");
    engineRuntime.stop();
  });

  import.meta.hot.accept();

  // Reconnect if we were previously connected
  const hmrData = import.meta.hot.data;
  if (hmrData?.wasConnected && hmrData?.config) {
    log.info("HMR: reconnecting WebSocket");
    engineRuntime.start(hmrData.config);
  }
}
