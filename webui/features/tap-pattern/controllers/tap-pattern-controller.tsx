// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { createEffect, createMemo, createSignal } from "solid-js";
import { sendCueUpdate, sendSequenceUpdate } from "../../../lib/cue-service";
import { getLogger } from "../../../lib/logger";
import type { BasePanelComponentProps } from "../../../lib/panel-registry";
import { useShallowStore } from "../../../lib/use-shallow-store";
import { cues, dockApi, pushToast, sequences } from "../../../state/appStores";
import type * as types from "../../../types";
import { TapAnalysisTables } from "../components/tap-analysis-tables";
import { TapPatternMetrics } from "../components/tap-pattern-metrics";
import { TapPatternSettings } from "../components/tap-pattern-settings";
import { TapPatternToolbar } from "../components/tap-pattern-toolbar";
import {
  GroupedTapTimeline,
  TapCaptureTimeline,
} from "../components/tap-timelines";
import {
  assignmentsByRepeat,
  beatScaleMarkers,
  captureOriginForTaps,
  isEditableKeyTarget,
  oneShotSequencePatternFromPulse,
  oneShotSequencePatternFromTaps,
  sortedClusters,
  type TapPatternSequencePattern,
} from "../model/panel-model";
import {
  analyzeTapPattern,
  bpmFromInterval,
  normalizeTapPatternDetectionOptions,
  type TapEvent,
  type TapPatternDetectionOptions,
} from "../model/tap-pattern-analysis";
import {
  canCreateTapPatternSequence,
  createTapPatternSequence,
  type TapPatternSequenceGenerationResult,
} from "../model/tap-pattern-sequence-generation";
import { tapPatternState } from "../state/tap-pattern-state";
import { useTapPatternKeyboard } from "./use-tap-pattern-keyboard";

export interface TapPatternPanelProps extends BasePanelComponentProps {
  initialPanelId?: string;
}

const log = getLogger(import.meta.url);

/** Coordinates tap capture, analysis, persistence, and sequence creation. */
export function TapPatternController(_props: TapPatternPanelProps) {
  let panelElement: HTMLDivElement | undefined;
  let segmentTimelineElement: HTMLButtonElement | undefined;
  const $dockApi = useStore(dockApi);
  const $sequences = useShallowStore(sequences);
  const $cues = useShallowStore(cues);
  const storedState = tapPatternState.get();
  const [taps, setTaps] = createSignal<TapEvent[]>(storedState.taps);
  const [captureOriginMs, setCaptureOriginMs] = createSignal(
    captureOriginForTaps(storedState.taps, performance.now()),
  );
  const [beatsPerLoop, setBeatsPerLoop] = createSignal(4);
  const [detectionOptions, setDetectionOptions] =
    createSignal<TapPatternDetectionOptions>(storedState.detectionOptions);
  const [highlightedClusterId, setHighlightedClusterId] = createSignal<
    number | null
  >(null);
  const [isCaptureArmed, setIsCaptureArmed] = createSignal(false);
  const [isPanelKeyboardActive, setIsPanelKeyboardActive] = createSignal(false);
  const [pendingGeneratedSequence, setPendingGeneratedSequence] =
    createSignal<TapPatternSequenceGenerationResult | null>(null);

  const analysis = createMemo(() =>
    analyzeTapPattern(taps(), detectionOptions()),
  );
  const groupedBeatMarkers = createMemo(() => beatScaleMarkers(beatsPerLoop()));
  const detectedPattern = createMemo(() => analysis().pattern);
  /** Resolves the pattern data used for sequence creation. */
  const sequencePattern = createMemo<TapPatternSequencePattern | null>(() => {
    const pattern = detectedPattern();
    if (pattern) {
      return pattern;
    }

    if (analysis().status === "pulse") {
      return oneShotSequencePatternFromPulse(
        taps(),
        analysis().intervalStats.medianMs,
      );
    }

    return oneShotSequencePatternFromTaps(
      taps(),
      analysis().intervalStats.medianMs,
    );
  });
  const loopBpm = createMemo(() => {
    const pattern = detectedPattern();
    if (!pattern) {
      return null;
    }

    return bpmFromInterval(pattern.loopLengthMs / beatsPerLoop());
  });
  const visibleSpanMs = createMemo(() => {
    const relativeTaps = analysis().relativeTapsMs;
    const lastTap = relativeTaps[relativeTaps.length - 1] ?? 0;

    return Math.max(lastTap, analysis().intervalStats.medianMs ?? 500, 1);
  });
  const segmentSpanMs = createMemo(() => {
    const pattern = detectedPattern();
    if (!pattern) {
      return visibleSpanMs();
    }

    return Math.max(
      visibleSpanMs(),
      pattern.loopLengthMs * pattern.repeatCount,
    );
  });
  const elapsedLoopCount = createMemo(() => {
    const pattern = detectedPattern();
    if (!pattern || pattern.loopLengthMs <= 0) {
      return null;
    }

    return Math.max(1, Math.ceil(segmentSpanMs() / pattern.loopLengthMs));
  });
  const clusterRows = createMemo(() =>
    detectedPattern() ? sortedClusters(detectedPattern()?.clusters ?? []) : [],
  );
  const repeatRows = createMemo(() =>
    detectedPattern()
      ? assignmentsByRepeat(detectedPattern()?.assignments ?? [])
      : [],
  );
  const assignmentByTapId = createMemo(() => {
    const assignments = detectedPattern()?.assignments ?? [];
    return new Map(
      assignments.map((assignment) => [assignment.tapId, assignment]),
    );
  });
  const loopBoundaryPositions = createMemo(() => {
    const pattern = detectedPattern();
    if (!pattern) {
      return [];
    }

    const boundaries: number[] = [];
    for (
      let boundaryMs = pattern.loopLengthMs;
      boundaryMs < segmentSpanMs();
      boundaryMs += pattern.loopLengthMs
    ) {
      boundaries.push(boundaryMs);
    }

    return boundaries;
  });
  const canGenerateSequence = createMemo(
    () =>
      pendingGeneratedSequence() == null &&
      canCreateTapPatternSequence(sequencePattern()),
  );

  /** Opens the generated sequence in a dockview sequence editor panel. */
  const openSequenceEditor = (sequence: types.Sequence) => {
    const api = $dockApi();
    if (!api) {
      return;
    }

    const panelId = `sequence-editor-panel-${sequence.identifiers.uid}`;
    const panel = api.getPanel(panelId);
    if (panel) {
      panel.focus();
      return;
    }

    api.addPanel({
      id: panelId,
      component: "SequenceEditor",
      title: sequence.identifiers.label.trim()
        ? `Sequence ${sequence.identifiers.id}: ${sequence.identifiers.label}`
        : `Sequence ${sequence.identifiers.id}`,
      params: { initialSequenceUid: sequence.identifiers.uid },
    });
  };

  /** Opens generated sequences once the backend acknowledges every cue. */
  createEffect(() => {
    const pending = pendingGeneratedSequence();
    if (!pending) {
      return;
    }

    const storedSequence = $sequences()[pending.sequence.identifiers.uid];
    if (!storedSequence) {
      return;
    }

    const storedCues = $cues();
    if (pending.cues.some((cue) => !storedCues[cue.identifiers.uid])) {
      return;
    }

    const stepLabel = pending.cues.length === 1 ? "step" : "steps";
    pushToast(
      "success",
      `Created sequence ${storedSequence.identifiers.id} with ${pending.cues.length} ${stepLabel}`,
    );
    setPendingGeneratedSequence(null);
    setTimeout(() => openSequenceEditor(storedSequence), 0);
  });

  /** Creates a wrapped empty cue sequence from the detected tap pattern. */
  const createSequenceFromPattern = () => {
    const pattern = sequencePattern();
    if (!pattern || !canCreateTapPatternSequence(pattern)) {
      pushToast(
        "warning",
        "Detect a repeated tap pattern before creating a sequence.",
      );
      return;
    }

    const generated = createTapPatternSequence({
      clusters: pattern.clusters,
      loopLengthMs: pattern.loopLengthMs,
      existingSequences: Object.values($sequences()),
    });
    const batchId = crypto.randomUUID().replace(/-/g, "");
    const stepLabel = generated.cues.length === 1 ? "step" : "steps";

    setPendingGeneratedSequence(generated);
    pushToast(
      "info",
      `Creating sequence ${generated.sequence.identifiers.id} with ${generated.cues.length} ${stepLabel}...`,
    );
    sendSequenceUpdate(generated.sequence, batchId);
    for (const cue of generated.cues) {
      sendCueUpdate(cue, batchId);
    }
  };

  /** Appends a tap using the browser monotonic clock. */
  const recordTap = (key?: string) => {
    if (!isCaptureArmed()) {
      return;
    }

    const nowMs = performance.now();
    setTaps((current) => {
      const nextOriginMs = current.length === 0 ? nowMs : captureOriginMs();
      setCaptureOriginMs(nextOriginMs);

      return [
        ...current,
        {
          id: current.length + 1,
          timeMs: Math.max(0, nowMs - nextOriginMs),
          ...(key ? { key } : {}),
        },
      ];
    });
  };

  /** Gives the taps timeline focus so armed keyboard input records taps directly. */
  const focusTapsTimeline = () => {
    setIsPanelKeyboardActive(true);
    queueMicrotask(() =>
      segmentTimelineElement?.focus({ preventScroll: true }),
    );
  };

  /** Toggles whether the next key or timeline click can append captured taps. */
  const toggleCaptureArmed = () => {
    setIsCaptureArmed((current) => !current);
  };

  /** Arms capture from the taps surface or records when already armed. */
  const handleTapsTimelineClick = () => {
    if (!isCaptureArmed()) {
      setIsCaptureArmed(true);
      return;
    }

    recordTap();
  };

  /** Activates panel keyboard capture from non-control panel surfaces. */
  const activatePanelKeyboard = (target: EventTarget | null) => {
    setIsPanelKeyboardActive(true);
    if (!isEditableKeyTarget(target)) {
      queueMicrotask(() => panelElement?.focus({ preventScroll: true }));
    }
  };

  /** Deletes the most recent tap from the active capture. */
  const deleteLastTap = () => {
    setTaps((current) => current.slice(0, -1));
    if (isCaptureArmed()) {
      focusTapsTimeline();
    }
  };

  /** Clears all captured taps and returns the panel to its empty state. */
  const clearTaps = () => {
    setCaptureOriginMs(performance.now());
    setTaps([]);
    if (isCaptureArmed()) {
      focusTapsTimeline();
    }
  };

  /** Copies captured tap timings, or full persisted state when requested. */
  const copyTapTimings = async (includeStoredState = false) => {
    if (!navigator?.clipboard?.writeText) {
      pushToast("error", "Clipboard access unavailable");
      return;
    }

    try {
      const payload = includeStoredState
        ? { taps: taps(), detectionOptions: detectionOptions() }
        : analysis().relativeTapsMs;
      await navigator.clipboard.writeText(JSON.stringify(payload));
      pushToast(
        "success",
        includeStoredState
          ? "Copied captured tap state"
          : "Copied captured tap timings",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pushToast("error", `Failed to copy tap data: ${message}`);
      log.error("Failed to copy tap data:", { error });
    }
  };

  /** Updates the assumed beat count used for loop BPM conversion. */
  const updateBeatsPerLoop = (value: string) => {
    const parsed = Number.parseFloat(value);
    if (!Number.isFinite(parsed)) {
      return;
    }

    setBeatsPerLoop(Math.min(16, Math.max(1, parsed)));
  };

  /** Updates one tap detection slider while keeping option bounds normalized. */
  const updateDetectionOption = (
    option: keyof TapPatternDetectionOptions,
    value: string,
  ) => {
    const parsed = Number.parseFloat(value);
    if (!Number.isFinite(parsed)) {
      return;
    }

    setDetectionOptions((current) =>
      normalizeTapPatternDetectionOptions({
        ...current,
        [option]: parsed,
      }),
    );
  };

  useTapPatternKeyboard({
    clearTaps,
    focusTapsTimeline,
    isCaptureArmed,
    isPanelKeyboardActive,
    panelElement: () => panelElement,
    recordTap,
    setIsCaptureArmed,
    setIsPanelKeyboardActive,
    timelineElement: () => segmentTimelineElement,
  });

  /** Persists tap capture changes so refreshes keep the current timing state. */
  createEffect(() => {
    tapPatternState.set({ taps: taps(), detectionOptions: detectionOptions() });
  });

  return (
    <div
      aria-label="Tap Pattern panel"
      class="flex h-full min-h-0 flex-col bg-neutral-900 text-neutral-100"
      ref={panelElement}
      role="region"
      tabIndex={-1}
      onFocusIn={() => setIsPanelKeyboardActive(true)}
      onPointerDown={(event) => activatePanelKeyboard(event.target)}
    >
      <TapPatternToolbar
        canCreateSequence={canGenerateSequence()}
        hasTaps={taps().length > 0}
        isCaptureArmed={isCaptureArmed()}
        onClear={clearTaps}
        onCreateSequence={createSequenceFromPattern}
        onDeleteLast={deleteLastTap}
        onToggleCapture={toggleCaptureArmed}
      />

      <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-3">
        <TapPatternSettings
          beatsPerLoop={beatsPerLoop()}
          detectionOptions={detectionOptions()}
          onBeatsPerLoopChange={updateBeatsPerLoop}
          onDetectionOptionChange={updateDetectionOption}
        />

        <TapPatternMetrics
          analysis={analysis()}
          beatsPerLoop={beatsPerLoop()}
          elapsedLoopCount={elapsedLoopCount()}
          loopBpm={loopBpm()}
          tapCount={taps().length}
        />

        <TapCaptureTimeline
          assignmentByTapId={assignmentByTapId()}
          elapsedLoopCount={elapsedLoopCount()}
          highlightedClusterId={highlightedClusterId()}
          isCaptureArmed={isCaptureArmed()}
          loopBoundaryPositions={loopBoundaryPositions()}
          relativeTapsMs={analysis().relativeTapsMs}
          segmentSpanMs={segmentSpanMs()}
          taps={taps()}
          onRecordTap={handleTapsTimelineClick}
          onSetHighlightedClusterId={setHighlightedClusterId}
          onSetTimelineElement={(element) => {
            segmentTimelineElement = element;
          }}
        />

        <GroupedTapTimeline
          beatsPerLoop={beatsPerLoop()}
          groupedBeatMarkers={groupedBeatMarkers()}
          highlightedClusterId={highlightedClusterId()}
          pattern={detectedPattern()}
          repeatRows={repeatRows()}
          onSetHighlightedClusterId={setHighlightedClusterId}
        />

        <TapAnalysisTables
          analysis={analysis()}
          clusterRows={clusterRows()}
          highlightedClusterId={highlightedClusterId()}
          onCopyTapTimings={(includeStoredState) =>
            void copyTapTimings(includeStoredState)
          }
          onSetHighlightedClusterId={setHighlightedClusterId}
          taps={taps()}
        />
      </div>
    </div>
  );
}
