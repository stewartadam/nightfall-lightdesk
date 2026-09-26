// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createSignal } from "solid-js";
import type {
  ElementParameterRow,
  ElementProgrammerRow,
  ParameterRow,
  PerformanceMeasureStats,
} from "../state/appStores";
import { browserDemoAudioHost } from "./browser-demo-audio";
import { normalizeDmxUniverseData } from "./dmx-universe-data";
import { backendLogConfigToUi } from "./log-config-bridge";
import {
  configure as configureUiLogging,
  createLogger,
  getLogger,
} from "./logger";
import { setStoreAction, setStoreKeyAction } from "./nanostore-action";
import { outputValuesConflict } from "./parameter-conflicts";
import {
  abandonPendingCommand,
  settlePendingCommand,
} from "./pending-command-lifecycle";
import {
  measureNextAnimationFrame,
  measurePerformanceScope,
} from "./performance-marks";
import { recordExternalPerformanceMeasure } from "./performance-measure-collector";
import {
  applyConfirmedShowfileChange,
  currentShowfileName,
  normalizedShowfileName,
  persistCurrentShowfileName,
} from "./showfile-loading";
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
const flowLog = createLogger("flow");
const WEBSOCKET_WORKER_DELIVERY_MEASURE = "nightfall:websocket.worker-to-main";
const REACTIVE_PARAMETER_STATE_INTERVAL_MS = 50;
const mainThreadMessageHandlers = createMainThreadMessageHandlerRegistry();

import EngineRuntimeWorker from "#engine-runtime-worker?worker";
import {
  addConsoleSendError,
  addExternalConsoleCommand,
  addPendingConsoleCommand,
  applyConsoleCommandResult,
  availableFxModules,
  bindings,
  bindingValidationSettings,
  blueprintDependencies,
  blueprints,
  browserDemoRuntimeInfo,
  clearSelectionFlattenConfirmation,
  clips,
  colorPathDefaults,
  colorPaths,
  cueDefinitionsLoaded,
  cueDurationProfiles,
  cues,
  dmxUniverseData,
  fixtureGeometries,
  fixtures,
  flowDefinitionsRevision,
  flowNodeTemplates,
  flowPortValues,
  flows,
  flowTriggerTicks,
  fx,
  fxModules,
  groups,
  inputContributionTrace,
  layerStack,
  masters,
  type ParameterOutputMap,
  parameters,
  parameterUpdateTimestamp,
  programmerResolvedSelection,
  programmerSelection,
  programmerSpatialSelection,
  programmerState,
  pushToast,
  requestSelectionFlattenConfirmation,
  runtimeCapabilities,
  sceneObjects,
  selectionFlattenConfirmation,
  sequenceDefinitionsLoaded,
  sequenceLookaheadStates,
  sequences,
  serverVersion,
  setParametersImmediate,
  stepFx,
  timecodes,
  timelineBeatgridDetectionStatus,
  timelineBeatgridPreview,
  timelineBeatgridProposals,
  timelineDefinitionsLoaded,
  timelineLookaheadActionStatuses,
  timelineRecordingPreviews,
  timelineRecordingStates,
  timelineStopEvent,
  timelines,
  type WsPullStats,
  waitForSelectionFlattenConfirmation,
  wsLatency,
  wsStats,
} from "../state/appStores";
import type * as types from "../types";
import type * as flowTypes from "../types/index";
import { setAttributeMetadata } from "./attribute-metadata";
import {
  decodeCorrelationId,
  normalizeCorrelationId,
} from "./console-scrollback";
import type { EngineRuntimeConfig } from "./engine-runtime-protocol";
import { applyFlowDeltaToDefinition } from "./flow-delta";
import {
  carriesParameterState,
  queuedWorkerMessageData,
  type WorkerQueuedMessage,
} from "./parameter-state-transfer";
import { valueSourceToProcessedParameterValue } from "./value-source";
import { createMainThreadMessageHandlerRegistry } from "./ws/main-thread-handlers";
import type { AnyWsMessage } from "./ws/types";

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
  processing?: PerformanceMeasureStats;
}

/** Combined worker stats message */
interface WorkerStatsData {
  aggregate: WorkerAggregateStats;
  byType: Record<string, WorkerTypeStats>;
}

/** Indexes cue duration profile messages by cue UID. */
function cueDurationProfileArrayToMap(
  profiles: types.CueDurationProfileMessage[],
) {
  return Object.fromEntries(
    profiles.map((profile) => [profile.cue_uid, profile]),
  );
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

/** Applies one pulled websocket payload from the worker. */
function applyWorkerQueuedMessage(message: WorkerQueuedMessage): void {
  recordWorkerDeliveryLag(message.postedAtMs);
  if (typeof message.deliveryMessageId === "number") {
    lastSeenDeliveryMessageId = message.deliveryMessageId;
  }
  const data = queuedWorkerMessageData(message);
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

// The WebSocket worker handles connection, CBOR decode, and payload staging.
// Main thread pulls already-decoded messages once per frame and dispatches them
// in batch order.
/**
 * Extract and update the immediate parameter output map synchronously.
 * Called when ParameterState arrives so visualizer has fresh DMX data.
 */
function updateImmediateParams(rawData: types.OutboundParameterState[]) {
  const outputMap: ParameterOutputMap = new Map();
  for (const item of rawData) {
    // Preserve per-element output arrays for multi-element fixtures
    const elementOutputs = item.parameters.map((ps) =>
      visualizerOutputForElement(ps),
    );
    outputMap.set(item.fixture_uid, elementOutputs);
  }
  setParametersImmediate(outputMap);
}

/**
 * Builds the visualizer-facing output for one element.
 *
 * Pan and tilt output defaults are always present in backend ParameterState even
 * when no object asserts movement. The visualizer needs absence to mean neutral
 * load pose, so only forward pan/tilt when absolute or relative state asserts it.
 */
function visualizerOutputForElement(
  state: types.ParameterState,
): Record<string, number> {
  if (!("Pan" in state.output) && !("Tilt" in state.output)) {
    return state.output;
  }

  const output = { ...state.output };
  if (!("Pan" in state.absolute) && !("Pan" in state.relative)) {
    delete output.Pan;
  }
  if (!("Tilt" in state.absolute) && !("Tilt" in state.relative)) {
    delete output.Tilt;
  }
  return output;
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
      () => updateImmediateParams(raw.data as types.OutboundParameterState[]),
      { fixtureCount: (raw.data as types.OutboundParameterState[]).length },
    );
  }

  // Dispatch immediately
  measurePerformanceScope(
    `websocket-main.dispatch.${raw.type}`,
    () => dispatchMessage(raw),
    { messageType: raw.type },
  );
}

/** Helper to convert array to UID-keyed map */
function arrayToUidMap<T extends { identifiers: { uid: string } }>(
  array: T[],
): Record<string, T> {
  const map: Record<string, T> = {};
  for (const item of array) {
    map[item.identifiers.uid] = item;
  }
  return map;
}

/** Measures one named sub-step inside a websocket message dispatch. */
function measureDispatchStep<T>(
  messageType: string,
  stepName: string,
  callback: () => T,
  detail?: unknown,
): T {
  return measurePerformanceScope(
    `websocket-main.dispatch.${messageType}.${stepName}`,
    callback,
    detail,
  );
}

/** Normalizes direct backend UUID fields into the compact UID keys used by stores. */
function normalizeBackendUid(rawUid: unknown): string {
  const decoded = decodeCorrelationId(rawUid);
  if (decoded) return decoded;
  return typeof rawUid === "string" ? rawUid : String(rawUid);
}

/** Normalizes backend-authored sequence Lookahead projection state for UI store lookups. */
function normalizeSequenceLookaheadState(
  state: types.SequenceLookaheadStateMessage,
): types.SequenceLookaheadStateMessage {
  return {
    ...state,
    sequence_uid: normalizeBackendUid(state.sequence_uid),
    rows: state.rows.map((row) => ({
      ...row,
      cue_uid: normalizeBackendUid(row.cue_uid),
    })),
  };
}

/**
 * Dispatch a single message to the appropriate handler.
 * This contains all the actual processing logic.
 */
function dispatchMessage(raw: AnyWsMessage) {
  // Track that main thread processed a message
  // NOTE: transport heartbeat latency is measured in the worker for timing accuracy
  processedCount++;
  if (mainThreadMessageHandlers.dispatch(raw)) {
    return;
  }

  switch (raw.type) {
    case "FixtureDefinitions": {
      setStoreAction(
        fixtures,
        "Receive FixtureDefinitions",
        arrayToUidMap(raw.data),
      );
      break;
    }

    case "AttributeMetadata": {
      setAttributeMetadata(raw.data);
      break;
    }

    case "SceneObjectDefinitions": {
      setStoreAction(
        sceneObjects,
        "Receive SceneObjectDefinitions",
        arrayToUidMap(raw.data as types.SceneObject[]),
      );
      break;
    }

    case "SceneObjectCommand": {
      handleSceneObjectCommand(raw.data as unknown as types.SceneObjectCommand);
      break;
    }

    case "FixtureGeometries": {
      // Store geometry data in dedicated store (keyed by fixture UID)
      setStoreAction(fixtureGeometries, "Receive FixtureGeometries", raw.data);
      break;
    }

    case "ObjectLibraryCommand": {
      handleObjectLibraryCommand(
        raw.data as unknown as types.ObjectLibraryCommand,
      );
      break;
    }

    case "GroupDefinitions": {
      setStoreAction(
        groups,
        "Receive GroupDefinitions",
        arrayToUidMap(raw.data),
      );
      break;
    }

    case "MasterDefinitions": {
      setStoreAction(
        masters,
        "Receive MasterDefinitions",
        arrayToUidMap(raw.data as types.Master[]),
      );
      break;
    }

    case "CueDefinitions": {
      const cueList = raw.data as types.Cue[];
      const cueMap = measureDispatchStep(
        raw.type,
        "array-to-uid-map",
        () => arrayToUidMap(cueList),
        { itemCount: cueList.length },
      );
      measureDispatchStep(
        raw.type,
        "store.cues.set",
        () => setStoreAction(cues, "Receive CueDefinitions", cueMap),
        { itemCount: cueList.length },
      );
      setStoreAction(cueDefinitionsLoaded, "Receive CueDefinitions", true);
      break;
    }

    case "CueDefinitionUpdated": {
      const cue = raw.data as types.Cue;
      setStoreKeyAction(
        cues,
        "Receive CueDefinitionUpdated",
        cue.identifiers.uid,
        cue,
      );
      setStoreAction(
        cueDefinitionsLoaded,
        "Receive CueDefinitionUpdated",
        true,
      );
      break;
    }

    case "CueDefinitionRemoved": {
      const removed = raw.data as types.RemovedCueDefinition;
      const updated = measureDispatchStep(
        raw.type,
        "clone-without-removed",
        () => {
          const next = { ...cues.get() };
          delete next[removed.uid];
          return next;
        },
        { uid: removed.uid },
      );
      measureDispatchStep(
        raw.type,
        "store.cues.set",
        () => setStoreAction(cues, "Receive CueDefinitionRemoved", updated),
        { uid: removed.uid },
      );
      break;
    }

    case "CueDurationProfiles": {
      const profiles = raw.data as types.CueDurationProfileMessage[];
      const profileMap = measureDispatchStep(
        raw.type,
        "array-to-profile-map",
        () => cueDurationProfileArrayToMap(profiles),
        { itemCount: profiles.length },
      );
      measureDispatchStep(
        raw.type,
        "store.cue-duration-profiles.set",
        () =>
          setStoreAction(
            cueDurationProfiles,
            "Receive CueDurationProfiles",
            profileMap,
          ),
        { itemCount: profiles.length },
      );
      break;
    }

    case "CueDurationProfileUpdated": {
      const profile = raw.data as types.CueDurationProfileMessage;
      setStoreKeyAction(
        cueDurationProfiles,
        "Receive CueDurationProfileUpdated",
        profile.cue_uid,
        profile,
      );
      break;
    }

    case "CueDurationProfileRemoved": {
      const removed = raw.data as types.RemovedCueDefinition;
      const updated = measureDispatchStep(
        raw.type,
        "clone-without-removed",
        () => {
          const next = { ...cueDurationProfiles.get() };
          delete next[removed.uid];
          return next;
        },
        { uid: removed.uid },
      );
      measureDispatchStep(
        raw.type,
        "store.cue-duration-profiles.set",
        () =>
          setStoreAction(
            cueDurationProfiles,
            "Receive CueDurationProfileRemoved",
            updated,
          ),
        { uid: removed.uid },
      );
      break;
    }

    case "SequenceLookaheadStates": {
      const rawStates = raw.data as types.SequenceLookaheadStateMessage[];
      const states = measureDispatchStep(
        raw.type,
        "normalize-states",
        () => rawStates.map(normalizeSequenceLookaheadState),
        { itemCount: rawStates.length },
      );
      const stateMap = measureDispatchStep(
        raw.type,
        "array-to-state-map",
        () =>
          Object.fromEntries(
            states.map((state) => [state.sequence_uid, state]),
          ),
        { itemCount: states.length },
      );
      measureDispatchStep(
        raw.type,
        "store.sequence-lookahead-states.set",
        () =>
          setStoreAction(
            sequenceLookaheadStates,
            "Receive SequenceLookaheadStates",
            stateMap,
          ),
        { itemCount: states.length },
      );
      break;
    }

    case "SequenceDefinitions": {
      const sequenceList = raw.data as types.Sequence[];
      const sequenceMap = measureDispatchStep(
        raw.type,
        "array-to-uid-map",
        () => arrayToUidMap(sequenceList),
        { itemCount: sequenceList.length },
      );
      measureDispatchStep(
        raw.type,
        "store.sequences.set",
        () =>
          setStoreAction(sequences, "Receive SequenceDefinitions", sequenceMap),
        { itemCount: sequenceList.length },
      );
      setStoreAction(
        sequenceDefinitionsLoaded,
        "Receive SequenceDefinitions",
        true,
      );
      break;
    }

    case "SequenceDefinitionUpdated": {
      const sequence = raw.data as types.Sequence;
      setStoreKeyAction(
        sequences,
        "Receive SequenceDefinitionUpdated",
        sequence.identifiers.uid,
        sequence,
      );
      setStoreAction(
        sequenceDefinitionsLoaded,
        "Receive SequenceDefinitionUpdated",
        true,
      );
      break;
    }

    case "SequenceDefinitionRemoved": {
      const removed = raw.data as types.RemovedSequenceDefinition;
      const updated = measureDispatchStep(
        raw.type,
        "clone-without-removed",
        () => {
          const next = { ...sequences.get() };
          delete next[removed.uid];
          return next;
        },
        { uid: removed.uid },
      );
      measureDispatchStep(
        raw.type,
        "store.sequences.set",
        () =>
          setStoreAction(
            sequences,
            "Receive SequenceDefinitionRemoved",
            updated,
          ),
        { uid: removed.uid },
      );
      break;
    }

    case "ColorPathDefinitions": {
      setStoreAction(
        colorPaths,
        "Receive ColorPathDefinitions",
        arrayToUidMap(raw.data as types.ColorPath[]),
      );
      break;
    }

    case "ColorPathDefaults": {
      setStoreAction(
        colorPathDefaults,
        "Receive ColorPathDefaults",
        raw.data as types.ColorPathDefault[],
      );
      break;
    }

    case "FxDefinitions": {
      setStoreAction(fx, "Receive FxDefinitions", arrayToUidMap(raw.data));
      break;
    }

    case "StepFxDefinitions": {
      setStoreAction(
        stepFx,
        "Receive StepFxDefinitions",
        arrayToUidMap(raw.data),
      );
      break;
    }

    case "FxModuleDefinitions": {
      setStoreAction(
        fxModules,
        "Receive FxModuleDefinitions",
        arrayToUidMap(raw.data),
      );
      break;
    }

    case "ListAvailableFxModulesResponse": {
      setStoreAction(
        availableFxModules,
        "Receive ListAvailableFxModulesResponse",
        raw.data.modules,
      );
      break;
    }

    case "FlowDefinitions": {
      setStoreAction(flows, "Receive FlowDefinitions", arrayToUidMap(raw.data));
      setStoreAction(
        flowDefinitionsRevision,
        "Advance Flow Definitions Revision",
        flowDefinitionsRevision.get() + 1,
      );
      break;
    }

    case "FlowNodeTemplates": {
      setStoreAction(flowNodeTemplates, "Receive FlowNodeTemplates", raw.data);
      break;
    }

    case "BlueprintDefinitions": {
      setStoreAction(
        blueprints,
        "Receive BlueprintDefinitions",
        arrayToUidMap(raw.data),
      );
      break;
    }

    case "BlueprintDependencies": {
      setStoreAction(
        blueprintDependencies,
        "Receive BlueprintDependencies",
        Object.fromEntries(
          raw.data.map((entry) => [entry.blueprint_uid, entry.dependents]),
        ),
      );
      break;
    }

    case "ClipDefinitions": {
      const clipMap: Record<string, [types.Clip, boolean]> = {};
      for (const { clip, is_active } of raw.data) {
        clipMap[clip.identifiers.uid] = [clip, is_active];
      }
      setStoreAction(clips, "Receive ClipDefinitions", clipMap);
      break;
    }

    case "TimecodeDefinitions": {
      const timecodeMap: Record<string, [types.Timecode, types.TimecodeState]> =
        {};
      for (const { timecode, state } of raw.data) {
        timecodeMap[timecode.identifiers.uid] = [timecode, state];
      }
      setStoreAction(timecodes, "Receive TimecodeDefinitions", timecodeMap);
      break;
    }

    case "TimelineDefinitions": {
      setStoreAction(
        timelines,
        "Receive TimelineDefinitions",
        arrayToUidMap(raw.data),
      );
      setStoreAction(
        timelineDefinitionsLoaded,
        "Receive TimelineDefinitions",
        true,
      );
      break;
    }

    case "TimelineAudioDirective": {
      const session = browserDemoAudioHost.currentSession();
      void browserDemoAudioHost
        .applyDirective(raw.data as types.TimelineAudioDirective, session)
        .catch((error: unknown) => {
          log.error("Unable to apply browser demo timeline audio", error);
          pushToast(
            "error",
            "Browser audio could not start. Select Play again to retry.",
          );
        });
      break;
    }

    case "TimelineRecordingStates": {
      const recordingStateMap: Record<string, types.TimelineRecordingState> =
        {};
      for (const state of raw.data as types.TimelineRecordingState[]) {
        recordingStateMap[String(state.timeline_id)] = state;
      }
      setStoreAction(
        timelineRecordingStates,
        "Receive TimelineRecordingStates",
        recordingStateMap,
      );
      break;
    }

    case "TimelineRecordingPreviews": {
      const recordingPreviewMap: Record<
        string,
        types.TimelineRecordingPreview
      > = {};
      for (const preview of raw.data as types.TimelineRecordingPreview[]) {
        recordingPreviewMap[String(preview.timeline_id)] = preview;
      }
      setStoreAction(
        timelineRecordingPreviews,
        "Receive TimelineRecordingPreviews",
        recordingPreviewMap,
      );
      break;
    }

    case "TimelineLookaheadActionStatuses": {
      const statusMap: Record<
        string,
        Record<string, types.TimelineLookaheadActionStatus>
      > = {};
      for (const status of raw.data as types.TimelineLookaheadActionStatus[]) {
        statusMap[status.timeline_uid] ??= {};
        statusMap[status.timeline_uid][
          JSON.stringify([status.track_id, status.action_id])
        ] = status;
      }
      setStoreAction(
        timelineLookaheadActionStatuses,
        "Receive TimelineLookaheadActionStatuses",
        statusMap,
      );
      break;
    }

    case "BeatgridDetectionStarted": {
      const started = raw.data as types.BeatgridDetectionStarted;
      setStoreKeyAction(
        timelineBeatgridDetectionStatus,
        "Receive BeatgridDetectionStarted",
        started.timeline_uid,
        {
          phase: "detecting",
          requestId: started.request_id,
        },
      );
      const nextPreview = { ...timelineBeatgridPreview.get() };
      delete nextPreview[started.timeline_uid];
      setStoreAction(
        timelineBeatgridPreview,
        "Clear Beatgrid Detection Preview",
        nextPreview,
      );
      break;
    }

    case "BeatgridDetectionReady": {
      const ready = raw.data as types.BeatgridDetectionReady;
      setStoreKeyAction(
        timelineBeatgridProposals,
        "Receive BeatgridDetectionReady",
        ready.timeline_uid,
        ready.proposal,
      );
      setStoreKeyAction(
        timelineBeatgridDetectionStatus,
        "Receive BeatgridDetectionReady",
        ready.timeline_uid,
        {
          phase: "ready",
          requestId: ready.proposal.request_id,
        },
      );
      break;
    }

    case "BeatgridDetectionFailed": {
      const failed = raw.data as types.BeatgridDetectionFailed;
      setStoreKeyAction(
        timelineBeatgridDetectionStatus,
        "Receive BeatgridDetectionFailed",
        failed.timeline_uid,
        {
          phase: "failed",
          requestId: failed.request_id,
          error: failed.error,
        },
      );
      const nextPreview = { ...timelineBeatgridPreview.get() };
      delete nextPreview[failed.timeline_uid];
      setStoreAction(
        timelineBeatgridPreview,
        "Clear Beatgrid Detection Preview",
        nextPreview,
      );
      pushToast("warning", `Beatgrid detection failed: ${failed.error}`);
      break;
    }

    case "Bindings": {
      setStoreAction(
        bindings,
        "Receive Bindings",
        raw.data as types.BindingsSnapshot,
      );
      break;
    }

    case "BindingValidationSettings": {
      setStoreAction(
        bindingValidationSettings,
        "Receive BindingValidationSettings",
        raw.data as types.BindingValidationSettings,
      );
      break;
    }

    case "ParameterState": {
      const rawData = raw.data as types.OutboundParameterState[];
      // Note: immediate output map already updated in queueMessage().
      // The reactive panel store is throttled to keep Solid subscribers responsive.
      queueReactiveParameterState(rawData);
      break;
    }

    case "ProgrammerState": {
      const processedProgrammerState = Object.values(raw.data).map((item) => {
        // Track conflicts: attribute -> Set of unique formatted values
        const conflictTracker: Record<string, Set<string>> = {};
        const mergedParams: Record<
          string,
          {
            value?: number;
            isPercentage: boolean;
            isRelative: boolean;
            marker?: "release" | "block" | "hold";
          }
        > = {};
        const elements: ElementProgrammerRow[] = [];

        // Process per-element data with conflict tracking
        for (
          let elementIdx = 0;
          elementIdx < item.parameters.length;
          elementIdx++
        ) {
          const elementParams = item.parameters[elementIdx];
          const elementAttrs: Record<
            string,
            {
              value?: number;
              isPercentage: boolean;
              isRelative: boolean;
              marker?: "release" | "block" | "hold";
            }
          > = {};

          for (const [attr, value] of Object.entries(
            elementParams.parameters,
          )) {
            const attrValue = valueSourceToProcessedParameterValue(
              value as types.ValueSource,
            );
            if (!attrValue) continue;
            attrValue.blueprintSource = elementParams.blueprint_sources[attr];
            elementAttrs[attr] = attrValue;

            // Track conflict using stringified value (to compare objects)
            const valueKey = JSON.stringify(attrValue);
            if (!conflictTracker[attr]) conflictTracker[attr] = new Set();
            conflictTracker[attr].add(valueKey);

            // Aggregated value (last element wins)
            mergedParams[attr] = attrValue;
          }

          elements.push({
            elementIndex: elementIdx + 1, // 1-based
            attributes: elementAttrs,
          });
        }

        // Identify conflicts (attributes with >1 unique value)
        const conflicts = new Set<string>();
        for (const [attr, values] of Object.entries(conflictTracker)) {
          if (values.size > 1) {
            conflicts.add(attr);
          }
        }

        const row: import("../state/appStores").ProgrammerRow = {
          fixtureUid: item.fixture_uid,
          attributes: mergedParams,
          elements: elements.length > 1 ? elements : undefined,
          conflicts: conflicts.size > 0 ? conflicts : undefined,
        };

        return row;
      });
      setStoreAction(
        programmerState,
        "Receive ProgrammerState",
        processedProgrammerState,
      );
      break;
    }

    case "ProgrammerSelection": {
      setStoreAction(
        programmerSelection,
        "Receive ProgrammerSelection",
        raw.data,
      );
      break;
    }

    case "ProgrammerSpatialSelection": {
      setStoreAction(
        programmerSpatialSelection,
        "Receive ProgrammerSpatialSelection",
        raw.data.selection,
      );
      setStoreAction(
        programmerResolvedSelection,
        "Receive ProgrammerSpatialSelection",
        raw.data.resolved,
      );
      break;
    }

    case "LayerStack": {
      const data = raw.data as types.OutboundLayerState[];
      measurePerformanceScope(
        "websocket-main.layer-stack.store-set",
        () => setStoreAction(layerStack, "Receive LayerStack", data),
        { layerCount: data.length },
      );
      measureNextAnimationFrame("websocket-main.layer-stack.next-frame", {
        layerCount: data.length,
      });
      break;
    }

    case "DmxUniverseData": {
      setStoreAction(
        dmxUniverseData,
        "Receive DmxUniverseData",
        normalizeDmxUniverseData(raw.data as types.OutboundDmxUniverse[]),
      );
      break;
    }

    case "InputContributionTrace": {
      setStoreAction(
        inputContributionTrace,
        "Receive InputContributionTrace",
        raw.data as types.OutboundInputContribution[],
      );
      break;
    }

    case "UiNotification": {
      handleUiNotification(raw.data as unknown as types.UiNotification);
      break;
    }

    case "CueCommand": {
      handleCueCommand(raw.data as unknown as types.CueCommand);
      break;
    }

    case "GroupCommand": {
      handleGroupCommand(raw.data as unknown as types.GroupCommand);
      break;
    }

    case "ClipCommand": {
      handleClipCommand(raw.data as unknown as types.ClipCommand);
      break;
    }

    case "DeskCommand": {
      handleDeskCommand(raw.data as unknown as types.DeskCommand);
      break;
    }

    case "TimelineCommand": {
      handleTimelineCommand(raw.data as unknown as types.TimelineCommand);
      break;
    }

    case "FixtureCommand": {
      handleFixtureCommand(raw.data as unknown as types.FixtureCommand);
      break;
    }

    case "FixtureLibraryCommand": {
      handleFixtureLibraryCommand(
        raw.data as unknown as types.FixtureLibraryCommand,
      );
      break;
    }

    case "BlueprintCommand": {
      handleBlueprintCommand(raw.data as unknown as types.BlueprintCommand);
      break;
    }

    case "FxCommand": {
      handleFxCommand(raw.data as unknown as types.FxCommand);
      break;
    }

    case "FxModuleCommand": {
      handleFxModuleCommand(raw.data as unknown as types.FxModuleCommand);
      break;
    }

    case "FlowCommand": {
      handleFlowCommand(raw.data as unknown as flowTypes.FlowCommand);
      break;
    }

    case "FlowDelta": {
      handleFlowDelta(raw.data as unknown as flowTypes.FlowDelta);
      break;
    }

    case "FlowAck": {
      handleFlowAck(raw.data as unknown as flowTypes.FlowAck);
      break;
    }

    case "FlowSnapshot": {
      handleFlowSnapshot(raw.data as unknown as flowTypes.FlowSnapshot);
      break;
    }

    case "FlowPortValueDelta": {
      handleFlowPortValueDelta(
        raw.data as unknown as flowTypes.FlowPortValueDelta,
      );
      break;
    }

    case "FlowTriggerDelta": {
      handleFlowTriggerDelta(raw.data as unknown as flowTypes.FlowTriggerDelta);
      break;
    }

    case "ServerVersion": {
      log.info(`Server version: ${raw.data}`);
      setStoreAction(
        serverVersion,
        "Receive ServerVersion",
        raw.data as string,
      );
      break;
    }

    case "AppState": {
      log.debug("Backend app state:", raw.data);
      setBackendAppState(raw.data as types.AppState);
      break;
    }

    case "RuntimeCapabilities": {
      setStoreAction(
        runtimeCapabilities,
        "Receive RuntimeCapabilities",
        raw.data as types.RuntimeCapabilities,
      );
      break;
    }

    case "ResyncComplete": {
      setResyncComplete(true);
      setResyncGeneration(resyncGeneration() + 1);
      break;
    }

    case "CommandResult": {
      log.debug("CommandResult received:", raw.data);
      const result = raw.data as types.CommandResult;

      // Resolve any pending promise for this command_id.
      const correlationKey = decodeCorrelationId(result.command_id as unknown);

      const settledCommand = correlationKey
        ? settlePendingCommand(pendingCommandLifecycle, correlationKey)
        : {};
      const hadWaiter = Boolean(settledCommand.waiter);
      settledCommand.waiter?.resolve(result);

      const flattenRetry = selectionFlattenRetryFromResult(result);
      if (correlationKey) {
        const showfileUpdate = settledCommand.resultMetadata;
        if (showfileUpdate && result.outcome.type === "Succeeded") {
          persistCurrentShowfileName(showfileUpdate.name);
        }
        if (!flattenRetry) {
          const displayCorrelationKey =
            commandResultAliases.get(correlationKey) ?? correlationKey;
          commandResultAliases.delete(correlationKey);
          applyConsoleCommandResult(displayCorrelationKey, result.outcome);
        }
      }

      if (result.outcome.type === "Failed") {
        if (flattenRetry) {
          if (!hadWaiter) {
            requestSelectionFlattenConfirmation(
              flattenRetry,
              correlationKey ?? undefined,
              result.outcome,
            );
          }
        } else {
          pushToast("error", result.outcome.data.message);
        }
      }
      break;
    }

    case "CommandNotice": {
      const notice = raw.data as types.CommandNotice;
      pushToast(
        notice.level === "Warning" ? "warning" : "info",
        notice.message,
      );
      break;
    }

    case "OscExternalEval": {
      const data = raw.data as types.OscExternalEval;
      const correlationId = decodeCorrelationId(data.correlation_id);
      if (!correlationId) {
        log.warn(
          "Ignoring OscExternalEval with invalid correlation_id",
          data.correlation_id,
        );
        break;
      }
      addExternalConsoleCommand(data.command, correlationId, data.source);
      break;
    }

    default:
      log.warn(`Unknown WsOutbound type: ${raw.type}`, raw);
  }
}

/**
 * Handles cue commands that arrive before the corresponding provider snapshot.
 *
 * Cue and sequence mutations are intentionally ignored here because committed
 * definition updates arrive through backend websocket messages.
 */
function handleCueCommand(command: types.CueCommand) {
  log.trace("Handling CueCommand:", command);

  // CRUD commands (StoreCue, RenameCue, DeleteCue, StoreSequence,
  // RenameSequence, DeleteSequence) are not processed here.
  // Instead, we receive CueDefinitionUpdated/CueDefinitionRemoved and
  // SequenceDefinitionUpdated/SequenceDefinitionRemoved messages, or full
  // snapshots during resync.
  // This prevents optimistic updates that show stale data when commands fail.
  switch (command.type) {
    default:
      log.trace(
        "Ignoring CueCommand (handled via CueDefinitions/SequenceDefinitions):",
        command.type,
      );
  }
}

/** Ignores optimistic group mutations in favor of backend provider snapshots. */
function handleGroupCommand(command: types.GroupCommand) {
  log.trace("Handling GroupCommand:", command);

  // CRUD commands (StoreGroup, RenameGroup, DeleteGroup) are not processed here.
  // Instead, we receive full GroupDefinitions when the backend DataProvider changes.
  // This prevents optimistic updates that show stale data when commands fail.
  switch (command.type) {
    default:
      log.trace(
        "Ignoring GroupCommand (handled via GroupDefinitions):",
        command.type,
      );
  }
}

/** Ignores optimistic blueprint mutations in favor of backend provider snapshots. */
function handleBlueprintCommand(command: types.BlueprintCommand) {
  log.trace("Handling BlueprintCommand:", command);

  // CRUD commands (StoreBlueprint, RenameBlueprint, DeleteBlueprint) are not processed here.
  // Instead, we receive full BlueprintDefinitions when the backend DataProvider changes.
  // This prevents optimistic updates that show stale data when commands fail.
  switch (command.type) {
    default:
      log.trace(
        "Ignoring BlueprintCommand (handled via BlueprintDefinitions):",
        command.type,
      );
  }
}

/** Ignores optimistic FX mutations in favor of backend provider snapshots. */
function handleFxCommand(command: types.FxCommand) {
  log.trace("Handling FxCommand:", command);

  // CRUD commands (StoreFx, RenameFx, DeleteFx) are not processed here.
  // Instead, we receive full FxDefinitions when the backend DataProvider changes.
  // This prevents optimistic updates that show stale data when commands fail.
  switch (command.type) {
    default:
      log.trace(
        "Ignoring FxCommand (handled via FxDefinitions):",
        command.type,
      );
  }
}

/** Ignores stored FX module mutations in favor of backend provider snapshots. */
function handleFxModuleCommand(command: types.FxModuleCommand) {
  log.trace("Handling FxModuleCommand:", command);

  // Stored fx module updates are reflected through full FxModuleDefinitions
  // snapshots rather than optimistic local mutation.
  switch (command.type) {
    default:
      log.trace(
        "Ignoring FxModuleCommand (handled via FxModuleDefinitions):",
        command.type,
      );
  }
}

/** Ignores optimistic flow CRUD commands in favor of backend provider snapshots. */
function handleFlowCommand(command: flowTypes.FlowCommand) {
  log.trace("Handling FlowCommand:", command);

  // CRUD commands (StoreFlow, RenameFlow, DeleteFlow) are not processed here.
  // Instead, we receive full FlowDefinitions when the backend DataProvider changes.
  // This prevents optimistic updates that show stale data when commands fail.
  switch (command.type) {
    default:
      log.trace(
        "Ignoring FlowCommand (handled via FlowDefinitions):",
        command.type,
      );
  }
}

/**
 * Applies a backend flow delta when it matches the local base version.
 *
 * Deltas with stale or future base versions are skipped so the UI does not
 * apply edits onto the wrong graph revision.
 */
function handleFlowDelta(delta: flowTypes.FlowDelta) {
  const flowMap = flows.get();
  const flowEntry = Object.entries(flowMap).find(
    ([, flow]) => flow.identifiers.id === delta.flow_id,
  );
  if (!flowEntry) {
    log.warn(`Flow ${delta.flow_id} not found for delta`);
    return;
  }
  const [flowUid, flow] = flowEntry;
  if (flow.flow_version !== delta.base_version) {
    return;
  }
  const result = applyFlowDeltaToDefinition(flow, delta);
  if (result.errors.length > 0) {
    result.errors.forEach((message) => {
      pushToast("error", message);
    });
  }
  if (result.applied) {
    setStoreKeyAction(flows, "Apply Backend Flow Delta", flowUid, result.flow);
  }
}

/**
 * Reports backend flow acknowledgement errors and repairs the local version marker.
 */
function handleFlowAck(ack: flowTypes.FlowAck) {
  if (ack.errors.length > 0) {
    flowLog.warn("Flow ack errors", ack);
    ack.errors.forEach((err) => {
      pushToast("error", err.message);
    });
    // On error, sync version from backend to recover.
    // Note: local data may be out of sync - a page refresh may be needed.
    const flowMap = flows.get();
    const flowEntry = Object.entries(flowMap).find(
      ([, flow]) => flow.identifiers.id === ack.flow_id,
    );
    if (flowEntry) {
      const localVersion = flowEntry[1].flow_version;
      if (ack.applied_version !== localVersion) {
        flowLog.warn(
          `Version desync detected (local=${localVersion} backend=${ack.applied_version}). ` +
            "Syncing version, but data may be stale. Refresh if issues persist.",
        );
        setStoreKeyAction(
          flows,
          "Repair Flow Ack Version",
          `${flowEntry[0]}.flow_version`,
          ack.applied_version,
        );
      }
    }
  }
  // On success: do nothing - optimistic update already set the version correctly.
  // Updating here could cause version to go backwards if ACKs arrive out of order.
}

/** Stores the latest runtime value for a single flow node port. */
function updateFlowPortValue(
  flowId: number,
  nodeId: number,
  portId: number,
  value: flowTypes.FlowValue,
) {
  const current = flowPortValues.get();
  const flowValues = current[flowId] ?? {};
  const portKey = `${nodeId}:${portId}`;
  setStoreAction(flowPortValues, "Receive Flow Port Value", {
    ...current,
    [flowId]: {
      ...flowValues,
      [portKey]: value,
    },
  });
}

/** Replaces all known runtime port values for one flow from a backend snapshot. */
function handleFlowSnapshot(snapshot: flowTypes.FlowSnapshot) {
  const flowValues: Record<string, flowTypes.FlowValue> = {};
  for (const port of snapshot.ports) {
    flowValues[`${port.node_id}:${port.port_id}`] = port.value;
  }
  const current = flowPortValues.get();
  setStoreAction(flowPortValues, "Receive FlowSnapshot", {
    ...current,
    [snapshot.flow_id]: flowValues,
  });
}

/** Applies one backend runtime value update for a flow node port. */
function handleFlowPortValueDelta(delta: flowTypes.FlowPortValueDelta) {
  updateFlowPortValue(delta.flow_id, delta.node_id, delta.port_id, delta.value);
}

/** Records the timestamp of a flow trigger pulse so the UI can animate it. */
function handleFlowTriggerDelta(delta: flowTypes.FlowTriggerDelta) {
  const current = flowTriggerTicks.get();
  const flowTicks = current[delta.flow_id] ?? {};
  setStoreAction(flowTriggerTicks, "Receive FlowTriggerDelta", {
    ...current,
    [delta.flow_id]: {
      ...flowTicks,
      [delta.node_id]: Date.now(),
    },
  });
}

/** Expands a backend id expression into ordered numeric ids, honoring ranges and subtraction. */
function expandIdExpr(idExpr: types.IdExpr): number[] {
  switch (idExpr.type) {
    case "Single":
      return [idExpr.data];
    case "Range": {
      const { start, end } = idExpr.data;
      if (start <= end) {
        return Array.from({ length: end - start + 1 }, (_, i) => start + i);
      }
      return Array.from({ length: start - end + 1 }, (_, i) => start - i);
    }
    case "Add":
      return [
        ...expandIdExpr(idExpr.data.lhs),
        ...expandIdExpr(idExpr.data.rhs),
      ];
    case "Sub": {
      const lhs = expandIdExpr(idExpr.data.lhs);
      const toRemove = new Set(expandIdExpr(idExpr.data.rhs));
      return lhs.filter((id) => !toRemove.has(id));
    }
    case "Span":
      return expandIdExpr(idExpr.data);
  }
  return [];
}

/** Applies clip start/stop/delete commands to the local clip store. */
function handleClipCommand(command: types.ClipCommand) {
  log.trace("Handling ClipCommand:", command);

  switch (command.type) {
    case "StartClip": {
      const clipIds = new Set(expandIdExpr(command.data));
      log.trace("Starting clips from command", [...clipIds]);
      const execMap = clips.get();
      for (const [uid, [clip, _isActive]] of Object.entries(execMap)) {
        if (clipIds.has(clip.identifiers.id)) {
          setStoreKeyAction(clips, "Start Clip", uid, [clip, true]);
        }
      }
      break;
    }
    case "StopClip": {
      const clipIds = new Set(expandIdExpr(command.data));
      log.trace("Stopping clips from command", [...clipIds]);
      const execMap = clips.get();
      for (const [uid, [clip, _isActive]] of Object.entries(execMap)) {
        if (clipIds.has(clip.identifiers.id)) {
          setStoreKeyAction(clips, "Stop Clip", uid, [clip, false]);
        }
      }
      break;
    }
    case "DeleteClip": {
      const clipId = command.data as number;
      log.trace(`Deleting clip ${clipId}`);
      // Find the clip by ID and remove it from the map
      const clipMap = clips.get();
      for (const [uid, [clip]] of Object.entries(clipMap)) {
        if (clip.identifiers.id === clipId) {
          const updatedMap = { ...clipMap };
          delete updatedMap[uid];
          setStoreAction(clips, "Delete Clip", updatedMap);
          break;
        }
      }
      break;
    }
    default:
      log.warn(`Unhandled ClipCommand: ${command.type}`);
  }
}

/** Keeps UI-side logging configuration synchronized with desk commands from the backend. */
function handleDeskCommand(command: types.DeskCommand) {
  log.trace("Handling DeskCommand:", command);

  switch (command.type) {
    case "SetLogLevel": {
      // Keep UI logging in sync with backend `log level ...` commands.
      configureUiLogging(backendLogConfigToUi(command.data), false);
      break;
    }
    default:
      log.warn(`Unhandled DeskCommand: ${command.type}`);
  }
}

/** Applies backend UI notifications such as toast presentation requests. */
function handleUiNotification(notification: types.UiNotification) {
  log.trace("Handling UiNotification:", notification);

  switch (notification.type) {
    case "ShowToast": {
      const level = notification.data.level.toLowerCase();
      pushToast(
        level === "error" || level === "warning" || level === "success"
          ? level
          : "info",
        notification.data.message,
      );
      break;
    }
    case "CurrentShowfileChanged": {
      const changeId = decodeCorrelationId(notification.data.change_id);
      if (!changeId) {
        log.error("Current showfile notification has an invalid change ID");
        break;
      }
      applyConfirmedShowfileChange(notification.data.name, changeId);
      break;
    }
  }
}

/** Ignores optimistic timeline mutations in favor of backend component snapshots. */
function handleTimelineCommand(command: types.TimelineCommand) {
  log.trace("Handling TimelineCommand:", command);

  // CRUD commands (StoreTimeline, RenameTimeline, DeleteTimeline) are not processed here.
  // Instead, we receive full TimelineDefinitions when the backend components change.
  // This prevents optimistic updates that show stale data when commands fail.
  switch (command.type) {
    case "StopTimeline": {
      const previous = timelineStopEvent.get();
      setStoreAction(timelineStopEvent, "Receive StopTimeline", {
        timelineId: command.data,
        revision: (previous?.revision ?? 0) + 1,
      });
      break;
    }
    default:
      log.trace(
        "Ignoring TimelineCommand (handled via TimelineDefinitions):",
        command.type,
      );
  }
}

/** Logs fixture-library command acknowledgements whose data arrives in later messages. */
function handleFixtureLibraryCommand(command: types.FixtureLibraryCommand) {
  log.trace("Handling FixtureLibraryCommand:", command);

  switch (command.type) {
    case "CreateFixtureFromLibrary": {
      // Server echoes this back after processing - no action needed on client
      // The fixture will be sent via FixtureCommand/StoreFixture
      log.trace(
        `CreateFixtureFromLibrary acknowledged for ${command.data.make} ${command.data.model}`,
      );
      break;
    }

    case "GetFixtureProfile": {
      // Server echoes this back - response comes via separate message
      log.trace("GetFixtureProfile acknowledged");
      break;
    }

    default:
      log.warn(`Unhandled FixtureLibraryCommand: ${command.type}`);
  }
}

/** Logs object-library command acknowledgements whose data arrives in later messages. */
function handleObjectLibraryCommand(command: types.ObjectLibraryCommand) {
  log.trace("Handling ObjectLibraryCommand:", command);

  switch (command.type) {
    case "CreateSceneObjectFromLibrary": {
      // Server echoes this back after processing - no action needed on client
      // The scene object will be sent via SceneObjectCommand/StoreSceneObject
      log.trace(
        `CreateSceneObjectFromLibrary acknowledged for ${command.data.object_name}`,
      );
      break;
    }

    case "GetObjectProfile": {
      // Server echoes this back - response comes via separate message
      log.trace("GetObjectProfile acknowledged");
      break;
    }

    case "UpdateSceneObjectsFromLibrary": {
      log.trace("UpdateSceneObjectsFromLibrary acknowledged");
      break;
    }

    default:
      log.warn(`Unhandled ObjectLibraryCommand: ${(command as any).type}`);
  }
}

/** Applies fixture placement deltas while leaving fixture CRUD to provider snapshots. */
function handleFixtureCommand(command: types.FixtureCommand) {
  log.trace("Handling FixtureCommand:", command);

  // Most fixture commands are handled via FixtureDefinitions/Bindings snapshots.
  // Placement updates are handled directly as deltas to avoid full fixture re-sync churn.
  switch (command.type) {
    case "UpdateFixturePlacements": {
      const startMs = performance.now();
      const requestedUpdates = command.data.updates.length;
      const fixtureMap = fixtures.get();
      const fixtureUidById = new Map<number, string>();
      for (const [uid, fixture] of Object.entries(fixtureMap)) {
        fixtureUidById.set(fixture.identifiers.id, uid);
      }

      let nextFixtureMap: typeof fixtureMap | null = null;
      let changedFixtureCount = 0;

      for (const update of command.data.updates) {
        const { id, position, rotation } = update;
        const uid = fixtureUidById.get(id);
        if (!uid) {
          log.warn(`Fixture ${id} not found for placement update`);
          continue;
        }

        const sourceFixtureMap = nextFixtureMap ?? fixtureMap;
        const fixture = sourceFixtureMap[uid];
        if (!fixture) {
          log.warn(`Fixture ${id} (${uid}) not found for placement update`);
          continue;
        }

        const currentPlacement: types.FixturePlacement = fixture.placement ?? {
          position: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0 },
        };
        const updatedPlacement: types.FixturePlacement = {
          ...currentPlacement,
          position: { ...currentPlacement.position },
          rotation: { ...currentPlacement.rotation },
        };
        let hasChanges = false;

        if (position) {
          switch (position.type) {
            case "All": {
              const next = position.data;
              if (
                updatedPlacement.position.x !== next.x ||
                updatedPlacement.position.y !== next.y ||
                updatedPlacement.position.z !== next.z
              ) {
                updatedPlacement.position = next;
                hasChanges = true;
              }
              break;
            }
            case "X":
              if (updatedPlacement.position.x !== position.data) {
                updatedPlacement.position.x = position.data;
                hasChanges = true;
              }
              break;
            case "Y":
              if (updatedPlacement.position.y !== position.data) {
                updatedPlacement.position.y = position.data;
                hasChanges = true;
              }
              break;
            case "Z":
              if (updatedPlacement.position.z !== position.data) {
                updatedPlacement.position.z = position.data;
                hasChanges = true;
              }
              break;
          }
        }

        if (rotation) {
          switch (rotation.type) {
            case "All": {
              const next = rotation.data;
              if (
                updatedPlacement.rotation.x !== next.x ||
                updatedPlacement.rotation.y !== next.y ||
                updatedPlacement.rotation.z !== next.z
              ) {
                updatedPlacement.rotation = next;
                hasChanges = true;
              }
              break;
            }
            case "X":
              if (updatedPlacement.rotation.x !== rotation.data) {
                updatedPlacement.rotation.x = rotation.data;
                hasChanges = true;
              }
              break;
            case "Y":
              if (updatedPlacement.rotation.y !== rotation.data) {
                updatedPlacement.rotation.y = rotation.data;
                hasChanges = true;
              }
              break;
            case "Z":
              if (updatedPlacement.rotation.z !== rotation.data) {
                updatedPlacement.rotation.z = rotation.data;
                hasChanges = true;
              }
              break;
          }
        }

        if (hasChanges) {
          if (!nextFixtureMap) {
            nextFixtureMap = { ...fixtureMap };
          }
          nextFixtureMap[uid] = {
            ...fixture,
            placement: updatedPlacement,
          };
          changedFixtureCount += 1;
        }
      }

      if (nextFixtureMap) {
        const storeMutationStartMs = performance.now();
        setStoreAction(fixtures, "Update Fixture Placements", nextFixtureMap);
        const storeMutationMs = performance.now() - storeMutationStartMs;
        const totalMs = performance.now() - startMs;
        log.trace(
          `UpdateFixturePlacements requested=${requestedUpdates} changed=${changedFixtureCount} storeMutationMs=${storeMutationMs.toFixed(2)} totalMs=${totalMs.toFixed(2)}`,
        );
      } else {
        const totalMs = performance.now() - startMs;
        log.trace(
          `UpdateFixturePlacements requested=${requestedUpdates} changed=0 totalMs=${totalMs.toFixed(2)}`,
        );
      }

      break;
    }

    case "UpdateFixturePatch": {
      const { id } = command.data;
      log.trace(
        `Patch update for fixture ${id} - waiting for Bindings message`,
      );
      // Patch updates are handled via the "Bindings" message sent by send_bindings_on_change
      // Don't try to manually update here - the backend will send the complete binding state
      break;
    }

    case "SetDmxChannels": {
      // DMX channel commands don't affect fixture state directly
      // They update parameter outputs which are handled via ParameterState messages
      log.trace("SetDmxChannels command received (handled via ParameterState)");
      break;
    }

    default:
      log.trace(
        "Ignoring FixtureCommand (handled via FixtureDefinitions):",
        command.type,
      );
  }
}

/** Applies scene object store, delete, placement, and property updates to the local store. */
function handleSceneObjectCommand(command: types.SceneObjectCommand) {
  log.trace("Handling SceneObjectCommand:", command);

  switch (command.type) {
    case "StoreSceneObject": {
      log.trace(`Storing scene object ${command.data.identifiers.id}`);
      setStoreAction(sceneObjects, "Store Scene Object", {
        ...sceneObjects.get(),
        [command.data.identifiers.uid]: command.data,
      });
      break;
    }
    case "DeleteSceneObject": {
      const sceneObjectId = command.data as number;
      log.trace(`Deleting scene object ${sceneObjectId}`);
      // Find the scene object by ID and remove it from the map
      const sceneObjectMap = sceneObjects.get();
      for (const [uid, sceneObject] of Object.entries(sceneObjectMap)) {
        if (sceneObject.identifiers.id === sceneObjectId) {
          const updatedMap = { ...sceneObjectMap };
          delete updatedMap[uid];
          setStoreAction(sceneObjects, "Delete Scene Object", updatedMap);
          break;
        }
      }
      break;
    }
    case "UpdateSceneObjectPlacement": {
      const { id, position, rotation } = command.data;
      log.trace(`Updating placement for scene object ${id}`);

      // Find the scene object by ID
      const sceneObjectMap = sceneObjects.get();
      const sceneObjectEntry = Object.entries(sceneObjectMap).find(
        ([, obj]) => obj.identifiers.id === id,
      );
      if (!sceneObjectEntry) {
        log.warn(`Scene object ${id} not found for placement update`);
        return;
      }

      const [uid, sceneObject] = sceneObjectEntry;

      // Create deep copy with nested placement object
      const updatedSceneObject = {
        ...sceneObject,
        placement: {
          ...sceneObject.placement,
          position: { ...sceneObject.placement.position },
          rotation: { ...sceneObject.placement.rotation },
        },
      };

      // Apply position updates
      if (position) {
        switch (position.type) {
          case "All":
            updatedSceneObject.placement.position = position.data;
            break;
          case "X":
            updatedSceneObject.placement.position.x = position.data;
            break;
          case "Y":
            updatedSceneObject.placement.position.y = position.data;
            break;
          case "Z":
            updatedSceneObject.placement.position.z = position.data;
            break;
        }
      }

      // Apply rotation updates
      if (rotation) {
        switch (rotation.type) {
          case "All":
            updatedSceneObject.placement.rotation = rotation.data;
            break;
          case "X":
            updatedSceneObject.placement.rotation.x = rotation.data;
            break;
          case "Y":
            updatedSceneObject.placement.rotation.y = rotation.data;
            break;
          case "Z":
            updatedSceneObject.placement.rotation.z = rotation.data;
            break;
        }
      }

      setStoreAction(sceneObjects, "Update Scene Object Placement", {
        ...sceneObjectMap,
        [uid]: updatedSceneObject,
      });
      break;
    }
    case "UpdateSceneObjectProperties": {
      const { id, properties } = command.data;
      log.trace(`Updating properties for scene object ${id}`);

      // Find the scene object by ID
      const sceneObjectMap = sceneObjects.get();
      const sceneObjectEntry = Object.entries(sceneObjectMap).find(
        ([, obj]) => obj.identifiers.id === id,
      );
      if (!sceneObjectEntry) {
        log.warn(`Scene object ${id} not found for properties update`);
        return;
      }

      const [uid, sceneObject] = sceneObjectEntry;

      // Map properties.type (PascalCase) to objectType (camelCase)
      const typeMap: Record<string, string> = {
        Truss: "truss",
        Audience: "audience",
        StageElement: "stageElement",
        Custom: "custom",
      };

      const updatedSceneObject: types.SceneObject = {
        ...sceneObject,
        properties,
        objectType: typeMap[properties.type] as types.SceneObjectType,
      };

      setStoreAction(sceneObjects, "Update Scene Object Properties", {
        ...sceneObjectMap,
        [uid]: updatedSceneObject,
      });
      break;
    }
    default:
      log.warn(`Unhandled SceneObjectCommand: ${(command as any).type}`);
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
let pendingReactiveParameterState: types.OutboundParameterState[] | null = null;
let reactiveParameterStateTimer: ReturnType<typeof setTimeout> | null = null;
let lastReactiveParameterStateFlushMs = 0;
let previousParameterRows = new Map<string, ParameterRow>();

/** Clears pending reactive parameter state without publishing it to UI stores. */
function resetReactiveParameterStateQueue(): void {
  if (reactiveParameterStateTimer !== null) {
    clearTimeout(reactiveParameterStateTimer);
    reactiveParameterStateTimer = null;
  }
  pendingReactiveParameterState = null;
  lastReactiveParameterStateFlushMs = 0;
  previousParameterRows = new Map<string, ParameterRow>();
}

/** Marks the current websocket state as waiting for a fresh backend resync. */
function markResyncPending(): void {
  resetReactiveParameterStateQueue();
  setResyncComplete(false);
  setStoreAction(cueDefinitionsLoaded, "Start Resync", false);
  setStoreAction(sequenceDefinitionsLoaded, "Start Resync", false);
  setStoreAction(timelineDefinitionsLoaded, "Start Resync", false);
  setStoreAction(runtimeCapabilities, "Start Resync", null);
}

/** Publishes the latest queued parameter state to reactive UI stores. */
function flushReactiveParameterState(): void {
  if (reactiveParameterStateTimer !== null) {
    clearTimeout(reactiveParameterStateTimer);
    reactiveParameterStateTimer = null;
  }

  const rawData = pendingReactiveParameterState;
  pendingReactiveParameterState = null;
  if (!rawData) return;

  lastReactiveParameterStateFlushMs = performance.now();
  setStoreAction(
    parameterUpdateTimestamp,
    "Receive ParameterState Timestamp",
    Date.now(),
  );
  const paramMap = measurePerformanceScope(
    "websocket-main.parameter-state.process",
    () => processParameterState(rawData),
    { fixtureCount: rawData.length },
  );
  measurePerformanceScope(
    "websocket-main.parameter-state.store-set",
    () => setStoreAction(parameters, "Receive ParameterState", paramMap),
    { fixtureCount: rawData.length },
  );
  measureNextAnimationFrame("websocket-main.parameter-state.next-frame", {
    fixtureCount: rawData.length,
  });
}

/** Schedules the next reactive parameter state flush after the throttle window. */
function scheduleReactiveParameterStateFlush(delayMs: number): void {
  if (reactiveParameterStateTimer !== null) return;
  reactiveParameterStateTimer = setTimeout(
    flushReactiveParameterState,
    Math.max(0, delayMs),
  );
}

/** Queues the newest parameter state and throttles reactive store notification. */
function queueReactiveParameterState(
  rawData: types.OutboundParameterState[],
): void {
  pendingReactiveParameterState = rawData;
  const nowMs = performance.now();
  const elapsedMs = nowMs - lastReactiveParameterStateFlushMs;
  if (elapsedMs >= REACTIVE_PARAMETER_STATE_INTERVAL_MS) {
    flushReactiveParameterState();
    return;
  }
  scheduleReactiveParameterStateFlush(
    REACTIVE_PARAMETER_STATE_INTERVAL_MS - elapsedMs,
  );
}

/** Returns whether two optional record objects expose the same key/value pairs. */
function recordsEqual<T>(
  left: Record<string, T> | undefined,
  right: Record<string, T> | undefined,
  valueEqual: (leftValue: T, rightValue: T) => boolean,
): boolean {
  if (left === right) return true;
  const leftRecord = left ?? {};
  const rightRecord = right ?? {};
  const leftKeys = Object.keys(leftRecord);
  if (leftKeys.length !== Object.keys(rightRecord).length) return false;

  for (const key of leftKeys) {
    if (!(key in rightRecord)) return false;
    if (!valueEqual(leftRecord[key]!, rightRecord[key]!)) return false;
  }
  return true;
}

/** Returns whether two parameter values resolve to the same serialized payload. */
function parameterValuesEqual(
  left: types.ParameterValue,
  right: types.ParameterValue,
): boolean {
  if (left === right) return true;
  if (left.type !== right.type) return false;

  switch (left.type) {
    case "Absolute":
      return right.type === "Absolute" && left.data.value === right.data.value;
    case "AbsolutePercent":
      return (
        right.type === "AbsolutePercent" && left.data.value === right.data.value
      );
    case "Relative":
      return (
        right.type === "Relative" && left.data.offset === right.data.offset
      );
    case "RelativePercent":
      return (
        right.type === "RelativePercent" &&
        left.data.offset === right.data.offset
      );
  }
}

/** Returns whether two optional conflict sets contain the same attributes. */
function conflictSetsEqual(
  left: Set<string> | undefined,
  right: Set<string> | undefined,
): boolean {
  if (left === right) return true;
  if ((left?.size ?? 0) !== (right?.size ?? 0)) return false;
  for (const value of left ?? []) {
    if (!right?.has(value)) return false;
  }
  return true;
}

/** Returns whether two processed element rows have identical display data. */
function elementParameterRowsEqual(
  left: ElementParameterRow,
  right: ElementParameterRow,
): boolean {
  return (
    left.elementIndex === right.elementIndex &&
    left.color === right.color &&
    recordsEqual(left.raw, right.raw, Object.is) &&
    recordsEqual(left.absolute, right.absolute, parameterValuesEqual) &&
    recordsEqual(left.relative, right.relative, parameterValuesEqual)
  );
}

/** Returns whether two processed fixture parameter rows have identical display data. */
function parameterRowsEqual(left: ParameterRow, right: ParameterRow): boolean {
  if (
    left.uid !== right.uid ||
    left.color !== right.color ||
    !recordsEqual(left.raw, right.raw, Object.is) ||
    !recordsEqual(left.absolute, right.absolute, parameterValuesEqual) ||
    !recordsEqual(left.relative, right.relative, parameterValuesEqual) ||
    !conflictSetsEqual(left.conflicts, right.conflicts)
  ) {
    return false;
  }

  const leftElements = left.elements ?? [];
  const rightElements = right.elements ?? [];
  return (
    leftElements.length === rightElements.length &&
    leftElements.every((element, index) =>
      elementParameterRowsEqual(element, rightElements[index]!),
    )
  );
}

/**
 * Process raw parameter state into a Map for reactive UI panels.
 * Aggregates per-element data and detects conflicts.
 */
function processParameterState(
  rawData: types.OutboundParameterState[],
): Map<string, ParameterRow> {
  const paramMap = new Map<string, ParameterRow>();
  for (const item of rawData) {
    const uid = item.fixture_uid;
    const elementStates = item.parameters;

    // Track conflicts: attribute -> element output values
    const conflictTracker: Record<string, number[]> = {};
    const mergedOutput: Record<string, number> = {};
    const mergedAbsolute: Record<string, types.ParameterValue> = {};
    const mergedRelative: Record<string, types.ParameterValue> = {};

    // Build per-element data
    const elements: ElementParameterRow[] = elementStates.map(
      (elementState, idx) => {
        // Track conflicts for output values
        for (const [attr, value] of Object.entries(elementState.output)) {
          conflictTracker[attr] ??= [];
          conflictTracker[attr].push(value);
        }

        // Calculate element color
        const red = Math.round(elementState.output.Red ?? 0);
        const green = Math.round(elementState.output.Green ?? 0);
        const blue = Math.round(elementState.output.Blue ?? 0);

        return {
          elementIndex: idx + 1, // 1-based
          color: `rgb(${red}, ${green}, ${blue})`,
          raw: elementState.output,
          absolute: elementState.absolute,
          relative: elementState.relative,
        };
      },
    );

    // Aggregate: use last element's value for conflicts (Object.assign behavior)
    for (const elementState of elementStates) {
      Object.assign(mergedOutput, elementState.output);
      Object.assign(mergedAbsolute, elementState.absolute);
      Object.assign(mergedRelative, elementState.relative);
    }

    // Identify conflicts whose element outputs differ beyond display tolerance.
    const conflicts = new Set<string>();
    for (const [attr, values] of Object.entries(conflictTracker)) {
      if (outputValuesConflict(values)) {
        conflicts.add(attr);
      }
    }

    // Calculate aggregated color
    const red = Math.round(mergedOutput.Red ?? 0);
    const green = Math.round(mergedOutput.Green ?? 0);
    const blue = Math.round(mergedOutput.Blue ?? 0);

    const nextRow: ParameterRow = {
      uid,
      color: `rgb(${red}, ${green}, ${blue})`,
      raw: mergedOutput,
      absolute: mergedAbsolute,
      relative: mergedRelative,
      elements: elements.length > 1 ? elements : undefined,
      conflicts: conflicts.size > 0 ? conflicts : undefined,
    };
    const previousRow = previousParameterRows.get(uid);
    paramMap.set(
      uid,
      previousRow && parameterRowsEqual(previousRow, nextRow)
        ? previousRow
        : nextRow,
    );
  }
  previousParameterRows = paramMap;
  return paramMap;
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

/** Pending terminal-result resolvers, keyed by command ID. */
const commandWaiters = new Map<
  string,
  {
    resolve: (result: types.CommandResult) => void;
    reject: (error: Error) => void;
  }
>();

/** Retry results can resolve the console entry created for the rejected command. */
const commandResultAliases = new Map<string, string>();

/** Extracts a validated selection-flatten retry from a structured command failure. */
function selectionFlattenRetryFromResult(
  result: types.CommandResult,
): import("../state/appStores").SelectionFlattenRetry | null {
  if (
    result.outcome.type !== "Failed" ||
    result.outcome.data.code !==
      "programmer.selection_flatten_confirmation_required"
  ) {
    return null;
  }
  const details = result.outcome.data.details;
  if (!details || typeof details !== "object") {
    return null;
  }
  const retry = details as {
    module?: unknown;
    command?: {
      type?: unknown;
      data?: {
        allow_selection_flatten?: unknown;
        selection_flatten_approval?: unknown;
      };
    };
  };
  const hasApproval =
    typeof retry.command?.data?.selection_flatten_approval === "string" &&
    retry.command.data.selection_flatten_approval.length > 0;
  const isApprovedProgrammerRelease =
    retry.module === "ProgrammerCommand" &&
    retry.command?.type === "ReleaseProgrammerValues" &&
    retry.command.data?.allow_selection_flatten === true &&
    hasApproval;
  const isApprovedUserCommand =
    retry.module === "UserCommand" &&
    (retry.command?.type === "Clear" || retry.command?.type === "Release") &&
    retry.command.data?.allow_selection_flatten === true &&
    hasApproval;
  if (!isApprovedProgrammerRelease && !isApprovedUserCommand) {
    return null;
  }
  return retry as import("../state/appStores").SelectionFlattenRetry;
}

/** Identifies a command whose result was interrupted when its runtime stopped. */
export class EngineRuntimeCommandDisconnectedError extends Error {
  /** Creates the stable transport error used by world-swap command handling. */
  constructor() {
    super("Engine runtime stopped before the command completed");
    this.name = "EngineRuntimeCommandDisconnectedError";
  }
}

/** Rejects terminal-result waiters when their transport session ends. */
function rejectPendingCommandWaiters(error: Error): void {
  const waiters = [...commandWaiters.values()];
  commandWaiters.clear();
  commandResultAliases.clear();
  pendingCurrentShowfileNames.clear();
  for (const waiter of waiters) {
    waiter.reject(error);
  }
}

interface PendingCurrentShowfileName {
  name: string;
}

const pendingCurrentShowfileNames = new Map<
  string,
  PendingCurrentShowfileName
>();

const pendingCommandLifecycle = {
  waiters: commandWaiters,
  resultMetadata: pendingCurrentShowfileNames,
};

/** Extracts the current showfile name implied by a successful desk command. */
function currentShowfileNameFromCommand(
  data: object,
): PendingCurrentShowfileName | null {
  const envelope = data as {
    module?: unknown;
    command?: { type?: unknown; data?: unknown };
  };
  if (envelope.module !== "DeskCommand") {
    return null;
  }

  const command = envelope.command;
  switch (command?.type) {
    case "NewShowfile":
    case "LoadShowfile":
      return { name: "default" };
    case "NewNamedShowfile":
      return command.data &&
        typeof command.data === "object" &&
        "name" in command.data &&
        typeof command.data.name === "string"
        ? {
            name: normalizedShowfileName(command.data.name),
          }
        : null;
    case "LoadNamedShowfile":
    case "LoadDraftShowfile":
      return typeof command.data === "string"
        ? {
            name: normalizedShowfileName(command.data),
          }
        : null;
    case "LoadShowfileRevision":
      return command.data &&
        typeof command.data === "object" &&
        "showfileName" in command.data &&
        typeof command.data.showfileName === "string"
        ? {
            name: normalizedShowfileName(command.data.showfileName),
          }
        : null;
    case "SaveNamedShowfile":
      return command.data &&
        typeof command.data === "object" &&
        "name" in command.data &&
        typeof command.data.name === "string"
        ? {
            name: normalizedShowfileName(command.data.name),
          }
        : null;
    default:
      return null;
  }
}

/** Defers a showfile-name update until the correlated command succeeds. */
function registerPendingCurrentShowfileName(
  correlationId: string,
  data: object,
): void {
  const showfileUpdate = currentShowfileNameFromCommand(data);
  if (showfileUpdate) {
    pendingCurrentShowfileNames.set(
      normalizeCorrelationId(correlationId),
      showfileUpdate,
    );
  }
}

export type { EngineRuntimeConfig } from "./engine-runtime-protocol";

/** Transport-neutral facade used by UI features to communicate with the engine. */
export const engineRuntime = {
  worker: null as Worker | null,
  config: null as EngineRuntimeConfig | null,
  isRunning: false,

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
          cancelPendingSelectionFlattenConfirmation(
            BACKEND_SESSION_CHANGED_CONFIRMATION_CANCEL_REASON,
          );
          // Worker connected, reset resync flag and send resync request
          markResyncPending();
          this.sendCommand({
            module: "EngineCommand",
            command: {
              type: "ResyncState",
            } as types.EngineCommand,
          });
          if (this.config?.mode === "remote") {
            // Request native-only catalog state from the remote backend.
            this.sendCommand({
              module: "FixtureLibraryCommand",
              command: {
                type: "ListAvailableFixtures",
              } as any,
            });
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
          lastWorkerError ??= msg.error;
          log.error("Worker error:", msg.error);
          break;
      }
    };

    this.worker.onerror = (event) => {
      log.error("Worker error:", event);
      rejectPendingCommandWaiters(
        new Error(
          `WebSocket worker failed before the command completed: ${lastWorkerError ?? event.message ?? "unknown worker error"}`,
        ),
      );
    };

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

  /** Sends one lifecycle-tracked command through the active adapter. */
  sendCommand(
    data: string | object,
    shouldLog = true,
    consoleCommandText?: string,
  ): string | null {
    if (!this.worker || !this.isRunning) {
      log.warn("Tried to send but worker is not running");
      if (consoleCommandText) {
        addConsoleSendError(
          consoleCommandText,
          "Failed to send command: disconnected",
        );
      } else if (typeof data === "object" && "command" in data) {
        const command = (
          data as { command?: { type?: unknown; data?: unknown } }
        ).command;
        if (command?.type === "Eval" && typeof command.data === "string") {
          addConsoleSendError(
            command.data,
            "Failed to send command: disconnected",
          );
        }
      }
      return null;
    }

    let payload: string | object = data;
    let commandId: string | null = null;
    if (typeof data === "object") {
      commandId = crypto.randomUUID();
      (data as Record<string, unknown>).command_id = commandId;
      (data as Record<string, unknown>).undo_id ??= commandId;
      registerPendingCurrentShowfileName(commandId, data);
      try {
        payload = sanitizeWebsocketPayload(data);
      } catch (error) {
        abandonPendingCommand(
          pendingCommandLifecycle,
          normalizeCorrelationId(commandId),
        );
        log.error("Failed to sanitize payload:", error);
        return null;
      }
    }

    if (consoleCommandText && commandId) {
      addPendingConsoleCommand(consoleCommandText, commandId, "UI");
    } else if (
      typeof data === "object" &&
      "command" in data &&
      commandId &&
      (data as { command?: { type?: unknown; data?: unknown } }).command
        ?.type === "Eval" &&
      typeof (data as { command?: { type?: unknown; data?: unknown } }).command
        ?.data === "string"
    ) {
      addPendingConsoleCommand(
        (data as { command: { data: string } }).command.data,
        commandId,
        "UI",
      );
    }

    if (shouldLog) {
      log.debug("Sending:", payload);
    }
    this.worker.postMessage({ type: "submit", data: payload });
    return commandId;
  },

  /** Submits an operator-approved retry and associates its result with the rejected command. */
  resubmitAfterConfirmation(
    retry: import("../state/appStores").SelectionFlattenRetry,
    rejectedCorrelationId?: string,
  ): string | null {
    const commandId = this.sendCommand(retry);
    if (commandId && rejectedCorrelationId) {
      commandResultAliases.set(
        normalizeCorrelationId(commandId),
        normalizeCorrelationId(rejectedCorrelationId),
      );
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
        if (!this.worker || !this.isRunning) {
          if (consoleCommandText) {
            addConsoleSendError(
              consoleCommandText,
              "Failed to send command: disconnected",
            );
          }
          reject(new Error("WebSocket worker is not running"));
          return;
        }

        const commandId = crypto.randomUUID();
        const commandKey = normalizeCorrelationId(commandId);
        originalCommandKey = commandKey;
        (data as Record<string, unknown>).command_id = commandId;
        (data as Record<string, unknown>).undo_id ??= commandId;
        registerPendingCurrentShowfileName(commandId, data);
        if (consoleCommandText) {
          addPendingConsoleCommand(consoleCommandText, commandId, "UI");
        }

        commandWaiters.set(commandKey, {
          resolve: (result) => {
            resolve(result);
          },
          reject: (error) => {
            reject(error);
          },
        });

        // Serialize and send
        try {
          const payload = sanitizeWebsocketPayload(data);
          log.debug("Sending (awaited):", payload);
          this.worker.postMessage({ type: "submit", data: payload });
        } catch (error) {
          abandonPendingCommand(pendingCommandLifecycle, commandKey);
          reject(error);
        }
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
