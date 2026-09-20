// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/// <reference types="vite/client" />

import { deepMap } from "@nanostores/deepmap";
import type { DockviewApi } from "dockview";
import { atom } from "nanostores";
import {
  appendConsoleScrollbackEntry,
  type ConsoleScrollbackEntry,
  createImmediateErrorConsoleScrollbackEntry,
  createPendingConsoleScrollbackEntry,
  DEFAULT_CONSOLE_SCROLLBACK_LIMIT,
  resolveConsoleScrollbackEntryByCorrelation,
  upsertPendingConsoleScrollbackEntry,
} from "../lib/console-scrollback";
import type { BrowserDemoRuntimeInfo } from "../lib/engine-runtime-protocol";
import { setStoreAction } from "../lib/nanostore-action";
import { registerPanelTabStatus } from "../lib/panel-tab-status";
import type { SelectionTarget } from "../lib/selection-targets";
import type * as types from "../types";
import type * as flowTypes from "../types/index";
import {
  clearNotificationHistory,
  notificationHistory,
  pushToast,
} from "./notifications";
import {
  $availableNetworkInterfaces,
  $availableUsbDmxDevices,
  $externalControlState,
  $ioSettings,
  $networkInterfaceStatus,
  $settings,
} from "./settings";

// Local type definitions for types not yet exported from backend
// TODO: Move these to typeshare once backend implements them
export interface EngineMetrics {
  fps?: number;
  frame_time_ms?: number;
  entity_count?: number;
  framepace_time_ms?: number;
  framepace_oversleep_ms?: number;
  active_layers: number;
  active_universes: number;
  artnet_send_time_ms?: number;
  artnet_universe_count: number;
  sacn_send_time_ms?: number;
  sacn_universe_count: number;
  parameter_state_build_ms?: number;
  parameter_state_broadcast_ms?: number;
  layer_stack_build_ms?: number;
  layer_stack_transition_build_ms?: number;
  layer_stack_broadcast_ms?: number;
  timeline_layer_generation_ms?: number;
  timeline_update_ms?: number;
  timeline_audio_ms?: number;
  timeline_lookahead_sources_ms?: number;
  timeline_lookahead_assertions_ms?: number;
  timeline_lookahead_layers_ms?: number;
  timeline_actions_ms?: number;
  timeline_parameters_ms?: number;
  timeline_seek_ms?: number;
  network_output_send_failures: types.NetworkOutputSendFailure[];
}

export interface UndoState {
  can_undo: boolean;
  can_redo: boolean;
  undo_description: string | null;
  redo_description: string | null;
  undo_depth: number;
  redo_depth: number;
  undo_stack: types.UndoStackEntryMessage[];
  redo_stack: types.UndoStackEntryMessage[];
}

export type ElementParameterRow = {
  elementIndex: number; // 1-based element number (e.g., 1, 2, 3)
  color: string;
  raw: Record<string, number>; // output values for this element
  absolute?: Record<string, types.ParameterValue>; // absolute values for this element
  relative?: Record<string, types.ParameterValue>; // relative values for this element
};

export type ParameterRow = {
  uid: string;
  color: string;
  raw: Record<string, number>; // aggregated output values (uses last element's value for conflicts)
  absolute?: Record<string, types.ParameterValue>; // aggregated absolute values
  relative?: Record<string, types.ParameterValue>; // aggregated relative values
  elements?: ElementParameterRow[]; // per-element data (only present if fixture has >1 element)
  conflicts?: Set<string>; // attributes with conflicting values across elements
};

/** Map of fixture UID to parameter row for O(1) lookups */
export type ParameterMap = Map<string, ParameterRow>;

type ProgrammerAttributeValue = {
  value?: number;
  isPercentage: boolean;
  isRelative: boolean;
  marker?: "release" | "block" | "hold";
  blueprintSource?: types.OutboundBlueprintValueSource;
};

export type ElementProgrammerRow = {
  elementIndex: number; // 1-based element number (e.g., 1, 2, 3)
  attributes: Record<string, ProgrammerAttributeValue>;
};

export type ProgrammerRow = {
  fixtureUid: string;
  attributes: Record<string, ProgrammerAttributeValue>; // aggregated attributes (uses last element's value for conflicts)
  elements?: ElementProgrammerRow[]; // per-element data (only present if fixture has >1 element)
  conflicts?: Set<string>; // attributes with conflicting values across elements
};

// Map types for efficient UID-based lookups
export interface TimelineMap {
  [id: string]: types.Timeline;
}
export interface TimelineRecordingStateMap {
  [timelineId: string]: types.TimelineRecordingState;
}
export interface TimelineRecordingPreviewMap {
  [timelineId: string]: types.TimelineRecordingPreview;
}
export interface TimelineStopEvent {
  timelineId: number;
  revision: number;
}
export interface TimelineLookaheadActionStatusMap {
  [timelineUid: string]: Record<string, types.TimelineLookaheadActionStatus>;
}
export interface TimelineBeatgridProposalMap {
  [timelineUid: string]: types.BeatgridProposal;
}
type TimelineBeatgridDetectionPhase = "idle" | "detecting" | "ready" | "failed";
interface TimelineBeatgridDetectionState {
  phase: TimelineBeatgridDetectionPhase;
  requestId?: string;
  error?: string;
}
export interface TimelineBeatgridDetectionMap {
  [timelineUid: string]: TimelineBeatgridDetectionState;
}
interface TimelineBeatgridPreviewState {
  mode?: "proposal" | "shift";
  requestId?: string;
  beatsPerBar: number;
  downbeatOffset: number;
  markers: types.BeatMarker[];
}
export interface TimelineBeatgridPreviewMap {
  [timelineUid: string]: TimelineBeatgridPreviewState;
}
interface TimelineBeatgridShiftState {
  active: boolean;
}
interface TimelineBeatgridShiftMap {
  [timelineUid: string]: TimelineBeatgridShiftState;
}
export type CueMap = { [uid: string]: types.Cue };
export type CueDurationProfileMap = {
  [uid: string]: types.CueDurationProfileMessage;
};
export type SequenceLookaheadStateMap = {
  [uid: string]: types.SequenceLookaheadStateMessage;
};
export type SequenceMap = { [uid: string]: types.Sequence };
export type ColorPathMap = { [uid: string]: types.ColorPath };
export type ColorPathDefaultList = types.ColorPathDefault[];
export type ClipMap = {
  [uid: string]: [types.Clip, boolean];
};
export type FixtureMap = { [uid: string]: types.Fixture };
export type SceneObjectMap = { [uid: string]: types.SceneObject };
export type GroupMap = { [uid: string]: types.Group };
export type MasterMap = { [uid: string]: types.Master };
export type FxMap = { [uid: string]: types.Fx };
export type StepFxMap = { [uid: string]: types.StepFx };
export type FxModuleMap = { [uid: string]: types.StoredFxModule };
export type FlowMap = { [uid: string]: flowTypes.FlowDefinition };
export type TimecodeMap = {
  [id: string]: [types.Timecode, types.TimecodeState];
};
export type FlowPortValueMap = {
  [flowId: number]: { [portRef: string]: flowTypes.FlowValue };
};
export type FlowTriggerTickMap = {
  [flowId: number]: { [nodeId: number]: number };
};
export type BlueprintMap = { [uid: string]: types.Blueprint };
export type BlueprintDependencyMap = { [uid: string]: string[] };

/** Active instances indexed by instance_id (UUID string) */
export type ActiveInstancesMap = { [instanceId: string]: types.InstanceInfo };
export type ControlState = types.ControlSnapshot;
export interface LayerNavigationRequest {
  layerIndex: number;
  fixtureUid: string;
  elementIndex?: number;
  requestId: number;
}
export interface LayerObjectNavigationRequest {
  layerIndex: number;
  requestId: number;
}
export interface PatchBindingNavigationRequest {
  bindingId: string;
  requestId: number;
}
export interface SequenceNavigationRequest {
  sequenceUid: string;
  requestId: number;
}
export interface SceneObjectNavigationRequest {
  sceneObjectUid: string;
  requestId: number;
}

// Application
export const dockApi = atom<DockviewApi | undefined>(undefined);

// Toolbar
export const serverVersion = atom<string>("");
export const wsLatency = atom<number>(0);
export const parameterUpdateTimestamp = atom<number>(0);
/** Observable browser media state used by diagnostics. */
export interface BrowserDemoAudioState {
  session: number;
  status: "unloaded" | "ready" | "playing" | "paused";
  positionMs: number;
}

/** Current effects-host state for the active embedded engine session. */
export const browserDemoAudioState = atom<BrowserDemoAudioState>({
  session: 0,
  status: "unloaded",
  positionMs: 0,
});

/** Latest worker-local runtime measurements when the embedded demo adapter is active. */
export const browserDemoRuntimeInfo = atom<BrowserDemoRuntimeInfo | null>(null);
/** Capabilities published by the authoritative runtime during each resync. */
export const runtimeCapabilities = atom<types.RuntimeCapabilities | null>(null);

/** Indicates that the current backend session has sent a cue definition snapshot. */
export const cueDefinitionsLoaded = atom<boolean>(false);
/** Indicates that the current backend session has sent a sequence definition snapshot. */
export const sequenceDefinitionsLoaded = atom<boolean>(false);
/** Indicates that the current backend session has sent a timeline definition snapshot. */
export const timelineDefinitionsLoaded = atom<boolean>(false);
export const cues = deepMap<CueMap>({});
export const cueDurationProfiles = deepMap<CueDurationProfileMap>({});
export const sequenceLookaheadStates = deepMap<SequenceLookaheadStateMap>({});
export const sequences = deepMap<SequenceMap>({});
export const colorPaths = deepMap<ColorPathMap>({});
export const colorPathDefaults = atom<ColorPathDefaultList>([]);
export const clips = deepMap<ClipMap>({});
export const fixtures = deepMap<FixtureMap>({});

/** Scene objects (trusses, audience, stage elements, etc.) keyed by UID */
export const sceneObjects = deepMap<SceneObjectMap>({});

/** Geometry data for fixtures, keyed by fixture UID */
export type FixtureGeometryMap = { [uid: string]: types.FixtureGeometry };
export const fixtureGeometries = deepMap<FixtureGeometryMap>({});
export const fixtureLibrary = atom<types.AvailableFixtureInfo[]>([]);

/** Canonical backend-provided attribute presentation metadata. */
export const attributeMetadata = atom<types.AttributeMetadata[]>([]);

/**
 * Latest fixture profile response (for fixture library preview).
 * Updated when GetFixtureProfile command returns.
 */
export const fixtureProfile = atom<types.GetFixtureProfileResponse | null>(
  null,
);

/** Available objects in the object library */
export const objectLibrary = atom<types.AvailableObjectInfo[]>([]);

/**
 * Latest object profile response (for object library preview).
 * Updated when GetObjectProfile command returns.
 */
export const objectProfile = atom<types.GetObjectProfileResponse | null>(null);
export const groups = deepMap<GroupMap>({});
export const masters = deepMap<MasterMap>({});
export const fx = deepMap<FxMap>({});
export const stepFx = deepMap<StepFxMap>({});
export const fxModules = deepMap<FxModuleMap>({});
export const availableFxModules = atom<types.AvailableFxModuleInfo[]>([]);
export const flows = deepMap<FlowMap>({});
export const flowDefinitionsRevision = atom<number>(0);
export const blueprints = deepMap<BlueprintMap>({});
export const blueprintDependencies = deepMap<BlueprintDependencyMap>({});
export const flowPortValues = atom<FlowPortValueMap>({});
export const flowTriggerTicks = atom<FlowTriggerTickMap>({});
export const flowNodeTemplates = atom<flowTypes.FlowNodeDescriptor[]>([]);

/**
 * Parameter state store (throttled).
 * For reactive UI components that subscribe via useStore().
 * Updates are throttled to ~20fps to avoid overwhelming UI panels.
 */
export const parameters = atom<ParameterMap>(new Map());

/** Get parameters for a specific fixture by ID */
function getFixtureById(id: number): types.Fixture | undefined {
  const fixtureMap = fixtures.get();
  for (const fixture of Object.values(fixtureMap)) {
    if (fixture.identifiers.id === id) {
      return fixture;
    }
  }
  return undefined;
}

/** Per-element output map for visualizer: uid -> array of element outputs (index = element number) */
export type ParameterOutputMap = Map<string, Record<string, number>[]>;
/**
 * Immediate parameter output for non-reactive hot paths.
 * Updated synchronously on every WebSocket message with minimal processing.
 * Use `getParametersImmediate()` in animation loops for the latest output data.
 * Only contains output values (not absolute/relative/color) for performance.
 */
const parametersImmediateHolder = {
  current: new Map<string, Record<string, number>[]>(),
};

/** Returns the latest parameter output map without subscribing to nanostore updates. */
export function getParametersImmediate(): ParameterOutputMap {
  return parametersImmediateHolder.current;
}

/** Replaces the non-reactive parameter output snapshot used by render hot paths. */
export function setParametersImmediate(map: ParameterOutputMap): void {
  parametersImmediateHolder.current = map;
}
export const bindings = atom<types.BindingsSnapshot>({
  input: [],
  output: [],
  disabled: [],
});
export const bindingValidationSettings = atom<types.BindingValidationSettings>({
  mode: "Strict" as types.BindingValidationMode,
});
export const patchBindingNavigationRequest =
  atom<PatchBindingNavigationRequest | null>(null);
export const programmerState = atom<ProgrammerRow[]>([]);

/** Active fixture selection in the programmer (resolved UIDs) */
export const programmerSelection = atom<string[]>([]);

/** Active scene-object selection owned by visualizer workflows. */
export const visualizerSceneObjectSelection = atom<string[]>([]);

/** Rows currently targeted for editing in patch or scene-object panels. */
export const visualizerEditSelection = atom<string[]>([]);

/** Active spatial selection definition in the programmer. */
export const programmerSpatialSelection = atom<types.SpatialSelection | null>(
  null,
);

/** Resolved runtime view of the active programmer spatial selection. */
export const programmerResolvedSelection = atom<types.ResolvedSelection | null>(
  null,
);
/** Active spatial-selection span targets highlighted in the visualizer. */
export const activeSelectionSpanTargets = atom<SelectionTarget[]>([]);
export const timecodes = deepMap<TimecodeMap>({});
export const timelines = deepMap<TimelineMap>({});
export const timelineStopEvent = atom<TimelineStopEvent | undefined>();
export const timelineRecordingStates = deepMap<TimelineRecordingStateMap>({});
export const timelineRecordingPreviews = deepMap<TimelineRecordingPreviewMap>(
  {},
);
export const timelineLookaheadActionStatuses =
  deepMap<TimelineLookaheadActionStatusMap>({});
export const timelineBeatgridProposals = deepMap<TimelineBeatgridProposalMap>(
  {},
);
export const timelineBeatgridDetectionStatus =
  deepMap<TimelineBeatgridDetectionMap>({});
export const timelineBeatgridPreview = deepMap<TimelineBeatgridPreviewMap>({});
const timelineBeatgridShiftState = deepMap<TimelineBeatgridShiftMap>({});
export const layerStack = atom<types.OutboundLayerState[]>([]);
export const layerNavigationRequest = atom<LayerNavigationRequest | null>(null);
export const layerObjectNavigationRequest =
  atom<LayerObjectNavigationRequest | null>(null);
export const sequenceNavigationRequest = atom<SequenceNavigationRequest | null>(
  null,
);
export const sceneObjectNavigationRequest =
  atom<SceneObjectNavigationRequest | null>(null);

/** Active instances map (instance_id -> InstanceInfo) */
export const activeInstances = deepMap<ActiveInstancesMap>({});
export const controls = atom<ControlState[]>([]);
export const engineMetrics = atom<EngineMetrics | null>(null);

// MIDI input state
export const midiDevices = atom<types.MidiDevice[]>([]);
export const midiMappings = atom<types.MidiMapping[]>([]);
export const midiLastEvent = atom<types.MidiLastEvent | null>(null);
export const oscSources = atom<types.OscSource[]>([]);
export const oscMappings = atom<types.OscMapping[]>([]);
export const oscLastEvent = atom<types.OscLastEvent | null>(null);
export const oscListenerStatus = atom<types.OscListenerStatus | null>(null);

// DMX Universe data for raw channel visualization (input + output)
export type DmxUniverseMap = types.OutboundDmxUniverse[];
export const dmxUniverseData = atom<DmxUniverseMap>([]);
export const inputContributionTrace = atom<types.OutboundInputContribution[]>(
  [],
);

// Undo/Redo state
export const undoState = atom<UndoState>({
  can_undo: false,
  can_redo: false,
  undo_description: null,
  redo_description: null,
  undo_depth: 0,
  redo_depth: 0,
  undo_stack: [],
  redo_stack: [],
});

// Smoothed engine metrics (EMA over ~1 second for stable display)
export interface SmoothedEngineMetrics {
  fps: number;
  frameTimeMs: number;
  framepaceTimeMs: number;
  framepaceOversleepMs: number;
  artnetSendTimeMs: number;
  sacnSendTimeMs: number;
  parameterStateBuildMs: number;
  parameterStateBroadcastMs: number;
  layerStackBuildMs: number;
  layerStackTransitionBuildMs: number;
  layerStackBroadcastMs: number;
}

const EMA_ALPHA = 0.05; // ~20 samples to stabilize at 44Hz = ~0.5s response time
let smoothedValues: SmoothedEngineMetrics = {
  fps: 0,
  frameTimeMs: 0,
  framepaceTimeMs: 0,
  framepaceOversleepMs: 0,
  artnetSendTimeMs: 0,
  sacnSendTimeMs: 0,
  parameterStateBuildMs: 0,
  parameterStateBroadcastMs: 0,
  layerStackBuildMs: 0,
  layerStackTransitionBuildMs: 0,
  layerStackBroadcastMs: 0,
};

export const smoothedEngineMetrics =
  atom<SmoothedEngineMetrics>(smoothedValues);

// Subscribe to raw metrics and apply EMA smoothing
engineMetrics.subscribe((raw) => {
  if (!raw) return;

  const applyEma = (
    current: number,
    newVal: number | undefined | null,
  ): number => {
    if (newVal === undefined || newVal === null) return current;
    if (current === 0) return newVal; // Initialize on first value
    return EMA_ALPHA * newVal + (1 - EMA_ALPHA) * current;
  };

  smoothedValues = {
    fps: applyEma(smoothedValues.fps, raw.fps),
    frameTimeMs: applyEma(smoothedValues.frameTimeMs, raw.frame_time_ms),
    framepaceTimeMs: applyEma(
      smoothedValues.framepaceTimeMs,
      raw.framepace_time_ms,
    ),
    framepaceOversleepMs: applyEma(
      smoothedValues.framepaceOversleepMs,
      raw.framepace_oversleep_ms,
    ),
    artnetSendTimeMs: applyEma(
      smoothedValues.artnetSendTimeMs,
      raw.artnet_send_time_ms,
    ),
    sacnSendTimeMs: applyEma(
      smoothedValues.sacnSendTimeMs,
      raw.sacn_send_time_ms,
    ),
    parameterStateBuildMs: applyEma(
      smoothedValues.parameterStateBuildMs,
      raw.parameter_state_build_ms,
    ),
    parameterStateBroadcastMs: applyEma(
      smoothedValues.parameterStateBroadcastMs,
      raw.parameter_state_broadcast_ms,
    ),
    layerStackBuildMs: applyEma(
      smoothedValues.layerStackBuildMs,
      raw.layer_stack_build_ms,
    ),
    layerStackTransitionBuildMs: applyEma(
      smoothedValues.layerStackTransitionBuildMs,
      raw.layer_stack_transition_build_ms,
    ),
    layerStackBroadcastMs: applyEma(
      smoothedValues.layerStackBroadcastMs,
      raw.layer_stack_broadcast_ms,
    ),
  };

  setStoreAction(
    smoothedEngineMetrics,
    "Update Smoothed Engine Metrics",
    smoothedValues,
  );
});

// WebSocket statistics
interface WsTypeStats {
  count: number;
  dropped: number;
  avgDecodeMs: number;
  avgProcessMs?: number;
  ratePerSec: number;
}

export interface WsStats {
  worker: {
    totalMessages: number;
    droppedMessages: number;
    avgDecodeMs: number;
    queueDepth: number;
    lastStagedDeliveryMessageId: number;
    processing?: PerformanceMeasureStats;
  };
  main: {
    processedCount: number;
    droppedCount: number;
    lastDeliveryLagMs: number;
    avgDeliveryLagMs: number;
    maxDeliveryLagMs: number;
    backlogLagging: boolean;
    lastSeenDeliveryMessageId: number;
    pull: WsPullStats;
  };
  byType: Record<string, WsTypeStats>;
  timestamp: number;
}

export interface WsPullStats {
  pullsPerSec: number;
  responsesPerSec: number;
  nonEmptyResponsesPerSec: number;
  messagesPerSec: number;
  parameterStatesPerSec: number;
  lastBatchSize: number;
  cadenceAvgMs: number | null;
  cadenceMinMs: number | null;
  cadenceMaxMs: number | null;
  inFlight: boolean;
}

export const wsStats = atom<WsStats | null>(null);

// Frame timing statistics
export interface FrameStats {
  fps: number;
  avgFrameTimeMs: number;
  droppedFrames: number;
}

export const frameStats = atom<FrameStats | null>(null);

// Long animation frame statistics
export interface LongAnimationFrameStats {
  framesPerSec: number;
  avgDurationMs: number;
  avgBlockingDurationMs: number;
  maxDurationMs: number;
  totalFrames: number;
  totalDurationMs: number;
  totalBlockingDurationMs: number;
  lastDurationMs: number;
  lastBlockingDurationMs: number;
}

export const longAnimationFrameStats = atom<LongAnimationFrameStats | null>(
  null,
);

// Visualizer render statistics
export interface VisualizerStats {
  fps: number;
  updateFixturesMs: number;
  postProcessMs: number;
  totalRenderMs: number;
  frameToFrameMs: number; // Wall clock time between actual renders
  gpuMs: number; // GPU execution time (from CPU render end to next frame start)
  scenePassMs: number;
  volumetricPassMs: number;
  gaussianBlurMs: number;
  bloomMs: number;
  renderMode?: "worker" | "main-thread"; // Which rendering mode is active
}

export const visualizerStats = atom<VisualizerStats | null>(null);

export type PerformanceMeasureUnit = "count" | "ms";

export interface PerformanceMeasureStats {
  name: string;
  unit: PerformanceMeasureUnit;
  count: number;
  avgMs: number;
  p90Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  lastMs: number;
}

export const performanceMeasureStats = atom<
  Record<string, PerformanceMeasureStats>
>({});

// Historical metrics for sparklines (60-second rolling window)
export interface MetricsHistory {
  fps: number[];
  latency: number[];
  frameTime: number[];
  uiFps: number[];
}

export const metricsHistory = atom<MetricsHistory>({
  fps: [],
  latency: [],
  frameTime: [],
  uiFps: [],
});

// Console scrollback
export const consoleScrollback = atom<ConsoleScrollbackEntry[]>([]);

/** Adds a UI-originated command to scrollback while it waits for backend completion. */
export function addPendingConsoleCommand(
  command: string,
  correlationId: string,
  source = "UI",
): void {
  setStoreAction(
    consoleScrollback,
    "Add Pending Console Command",
    appendConsoleScrollbackEntry(
      consoleScrollback.get(),
      createPendingConsoleScrollbackEntry(
        command,
        correlationId,
        Date.now(),
        source,
      ),
      DEFAULT_CONSOLE_SCROLLBACK_LIMIT,
    ),
  );
}

/** Adds or updates a pending command that originated outside the command-line UI. */
export function addExternalConsoleCommand(
  command: string,
  correlationId: string,
  source: string,
): void {
  setStoreAction(
    consoleScrollback,
    "Add External Console Command",
    upsertPendingConsoleScrollbackEntry(
      consoleScrollback.get(),
      command,
      correlationId,
      source,
      DEFAULT_CONSOLE_SCROLLBACK_LIMIT,
    ),
  );
}

/** Adds an immediate scrollback error for a command that could not be sent. */
export function addConsoleSendError(
  command: string,
  errorMessage: string,
): void {
  setStoreAction(
    consoleScrollback,
    "Add Console Send Error",
    appendConsoleScrollbackEntry(
      consoleScrollback.get(),
      createImmediateErrorConsoleScrollbackEntry(command, errorMessage),
      DEFAULT_CONSOLE_SCROLLBACK_LIMIT,
    ),
  );
}

/** Resolves a pending scrollback entry with the backend result for its correlation id. */
export function applyConsoleCommandResult(
  correlationId: string,
  outcome: types.CommandOutcome,
): void {
  setStoreAction(
    consoleScrollback,
    "Apply Console Command Result",
    resolveConsoleScrollbackEntryByCorrelation(
      consoleScrollback.get(),
      correlationId,
      outcome,
    ),
  );
}

/** Removes all command scrollback entries. */
export function clearConsoleScrollback(): void {
  setStoreAction(consoleScrollback, "Clear Console Scrollback", []);
}

export interface SelectionFlattenRetry {
  module: "ProgrammerCommand" | "UserCommand";
  command: object;
}

export interface SelectionFlattenConfirmation {
  retry: SelectionFlattenRetry;
  correlationId?: string;
  rejectedOutcome?: types.CommandOutcome;
  mode: "await" | "resubmit";
}

export const selectionFlattenConfirmation =
  atom<SelectionFlattenConfirmation | null>(null);

let selectionFlattenDecisionResolver:
  | ((confirmed: boolean) => void)
  | undefined;

/** Settles the rejected console result when a resubmit prompt is displaced. */
function settleDisplacedSelectionFlattenConfirmation(): void {
  const previous = selectionFlattenConfirmation.get();
  if (
    previous?.mode === "resubmit" &&
    previous.correlationId &&
    previous.rejectedOutcome
  ) {
    applyConsoleCommandResult(previous.correlationId, previous.rejectedOutcome);
  }
}

/** Replaces any active confirmation with a fire-and-forget retry prompt. */
export function requestSelectionFlattenConfirmation(
  retry: SelectionFlattenRetry,
  correlationId?: string,
  rejectedOutcome?: types.CommandOutcome,
): void {
  settleDisplacedSelectionFlattenConfirmation();
  selectionFlattenDecisionResolver?.(false);
  selectionFlattenDecisionResolver = undefined;
  setStoreAction(selectionFlattenConfirmation, "Request Selection Flatten", {
    retry,
    correlationId,
    rejectedOutcome,
    mode: "resubmit",
  });
}

/** Prompts for an awaited command retry and resolves with the operator's decision. */
export function waitForSelectionFlattenConfirmation(
  retry: SelectionFlattenRetry,
  correlationId?: string,
): Promise<boolean> {
  settleDisplacedSelectionFlattenConfirmation();
  selectionFlattenDecisionResolver?.(false);
  setStoreAction(selectionFlattenConfirmation, "Await Selection Flatten", {
    retry,
    correlationId,
    mode: "await",
  });
  return new Promise((resolve) => {
    selectionFlattenDecisionResolver = resolve;
  });
}

/** Completes the active prompt and returns a fire-and-forget retry when approved. */
export function decideSelectionFlattenConfirmation(
  confirmed: boolean,
): SelectionFlattenConfirmation | null {
  const confirmation = selectionFlattenConfirmation.get();
  const resolver = selectionFlattenDecisionResolver;
  selectionFlattenDecisionResolver = undefined;
  setStoreAction(
    selectionFlattenConfirmation,
    "Decide Selection Flatten Request",
    null,
  );
  resolver?.(confirmed);
  if (
    !confirmed &&
    !resolver &&
    confirmation?.correlationId &&
    confirmation.rejectedOutcome
  ) {
    applyConsoleCommandResult(
      confirmation.correlationId,
      confirmation.rejectedOutcome,
    );
  }
  return confirmed && !resolver ? confirmation : null;
}

/** Clears any active prompt and rejects an awaited retry decision. */
export function clearSelectionFlattenConfirmation(): void {
  selectionFlattenDecisionResolver?.(false);
  selectionFlattenDecisionResolver = undefined;
  setStoreAction(
    selectionFlattenConfirmation,
    "Clear Selection Flatten Request",
    null,
  );
}

let nextLayerNavigationRequestId = 1;
let nextPatchBindingNavigationRequestId = 1;
let nextSequenceNavigationRequestId = 1;
let nextSceneObjectNavigationRequestId = 1;

/** Requests one-shot navigation to a layer, fixture, or layer element. */
export function requestLayerNavigation(
  target: Omit<LayerNavigationRequest, "requestId">,
): number {
  const requestId = nextLayerNavigationRequestId++;
  setStoreAction(layerNavigationRequest, "Request Layer Navigation", {
    ...target,
    requestId,
  });
  return requestId;
}

/** Clears the layer navigation request only if the caller owns the current request id. */
export function clearLayerNavigationRequest(requestId: number): void {
  const current = layerNavigationRequest.get();
  if (current?.requestId === requestId) {
    setStoreAction(layerNavigationRequest, "Clear Layer Navigation", null);
  }
}

/** Clears the layer object navigation request only if the id still matches. */
export function clearLayerObjectNavigationRequest(requestId: number): void {
  const current = layerObjectNavigationRequest.get();
  if (current?.requestId === requestId) {
    setStoreAction(
      layerObjectNavigationRequest,
      "Clear Layer Object Navigation",
      null,
    );
  }
}

/** Requests one-shot navigation to a patch binding. */
export function requestPatchBindingNavigation(bindingId: string): number {
  const requestId = nextPatchBindingNavigationRequestId++;
  setStoreAction(patchBindingNavigationRequest, "Request Patch Binding", {
    bindingId,
    requestId,
  });
  return requestId;
}

/** Clears the patch binding navigation request only if the id still matches. */
export function clearPatchBindingNavigationRequest(requestId: number): void {
  const current = patchBindingNavigationRequest.get();
  if (current?.requestId === requestId) {
    setStoreAction(
      patchBindingNavigationRequest,
      "Clear Patch Binding Navigation",
      null,
    );
  }
}

/** Requests one-shot navigation to a sequence. */
export function requestSequenceNavigation(sequenceUid: string): number {
  const requestId = nextSequenceNavigationRequestId++;
  setStoreAction(sequenceNavigationRequest, "Request Sequence Navigation", {
    sequenceUid,
    requestId,
  });
  return requestId;
}

/** Clears the sequence navigation request only if the id still matches. */
export function clearSequenceNavigationRequest(requestId: number): void {
  const current = sequenceNavigationRequest.get();
  if (current?.requestId === requestId) {
    setStoreAction(
      sequenceNavigationRequest,
      "Clear Sequence Navigation",
      null,
    );
  }
}

/** Requests one-shot navigation to a scene object row. */
export function requestSceneObjectNavigation(sceneObjectUid: string): number {
  const requestId = nextSceneObjectNavigationRequestId++;
  setStoreAction(sceneObjectNavigationRequest, "Request Scene Object", {
    sceneObjectUid,
    requestId,
  });
  return requestId;
}

/** Clears the scene-object navigation request only if the id still matches. */
export function clearSceneObjectNavigationRequest(requestId: number): void {
  const current = sceneObjectNavigationRequest.get();
  if (current?.requestId === requestId) {
    setStoreAction(
      sceneObjectNavigationRequest,
      "Clear Scene Object Navigation",
      null,
    );
  }
}

export type {
  NotificationHistoryEntry,
  ToastAction,
  ToastLevel,
  ToastPresentation,
} from "./notifications";
export {
  clearNotificationHistory,
  notificationHistory,
  pushToast,
} from "./notifications";

const exposesDebugStores =
  import.meta.env?.DEV ||
  (import.meta.env?.MODE === "browser-demo" &&
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("e2e") === "1");

// 🔍 Expose for debugging in development and explicit browser-demo test sessions.
if (typeof window !== "undefined" && exposesDebugStores) {
  // @ts-expect-error we are defining the appStores global on window
  window.appStores = {
    dockApi,
    settings: $settings,
    ioSettings: $ioSettings,
    availableNetworkInterfaces: $availableNetworkInterfaces,
    externalControlState: $externalControlState,
    availableUsbDmxDevices: $availableUsbDmxDevices,
    networkInterfaceStatus: $networkInterfaceStatus,
    serverVersion,
    browserDemoRuntimeInfo,
    browserDemoAudioState,
    runtimeCapabilities,
    wsLatency,
    parameterUpdateTimestamp,
    cueDefinitionsLoaded,
    sequenceDefinitionsLoaded,
    timelineDefinitionsLoaded,
    cues,
    cueDurationProfiles,
    sequenceLookaheadStates,
    sequences,
    colorPaths,
    colorPathDefaults,
    clips,
    fixtures,
    sceneObjects,
    fixtureLibrary,
    attributeMetadata,
    fixtureGeometries,
    objectLibrary,
    objectProfile,
    groups,
    masters,
    fx,
    stepFx,
    fxModules,
    availableFxModules,
    flows,
    blueprints,
    blueprintDependencies,
    parameters,
    getFixtureById,
    getParametersImmediate,
    bindings,
    bindingValidationSettings,
    patchBindingNavigationRequest,
    programmerState,
    selectionFlattenConfirmation,
    requestSelectionFlattenConfirmation,
    waitForSelectionFlattenConfirmation,
    programmerSelection,
    visualizerSceneObjectSelection,
    visualizerEditSelection,
    programmerSpatialSelection,
    programmerResolvedSelection,
    activeSelectionSpanTargets,
    timecodes,
    timelines,
    timelineStopEvent,
    timelineRecordingStates,
    timelineRecordingPreviews,
    timelineLookaheadActionStatuses,
    timelineBeatgridProposals,
    timelineBeatgridDetectionStatus,
    timelineBeatgridPreview,
    timelineBeatgridShiftState,
    layerStack,
    layerNavigationRequest,
    layerObjectNavigationRequest,
    sequenceNavigationRequest,
    sceneObjectNavigationRequest,
    dmxUniverseData,
    inputContributionTrace,
    activeInstances,
    controls,
    undoState,
    engineMetrics,
    smoothedEngineMetrics,
    wsStats,
    frameStats,
    longAnimationFrameStats,
    visualizerStats,
    performanceMeasureStats,
    metricsHistory,
    flowDefinitionsRevision,
    flowPortValues,
    flowTriggerTicks,
    midiDevices,
    midiMappings,
    midiLastEvent,
    oscSources,
    oscMappings,
    oscLastEvent,
    oscListenerStatus,
    consoleScrollback,
    clearConsoleScrollback,
    notificationHistory,
    clearNotificationHistory,
    pushToast,
    /** Publishes transient panel tab state through the development bridge. */
    registerPanelTabStatus,
    /** Send a command to the backend via WebSocket */
    send: async (data: object) => {
      const { engineRuntime } = await import("../lib/engine-runtime");
      engineRuntime.sendCommand(data);
    },
    /** Send a command to the backend and wait for its CommandResult response. */
    sendAndAwait: async (data: object) => {
      const { engineRuntime } = await import("../lib/engine-runtime");
      return engineRuntime.sendCommandAndAwait(data);
    },
  };
}
