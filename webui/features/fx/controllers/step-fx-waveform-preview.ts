// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { Accessor } from "solid-js";
import {
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
} from "solid-js";
import { reducedMotion } from "../../../state/reduced-motion";
import { FxDirection } from "../../../types";
import {
  stepFxPhaseMarkerBeat,
  stepFxPlayheadCycleOffset,
  stepFxPreviewOrStartBeats,
} from "../model/step-fx-preview-clock";
import {
  type StepFxWaveformModel,
  sampleStepFxWaveformAtPosition,
} from "../model/step-fx-waveform-model";
import type { StepFxPlayheadSample } from "../model/step-fx-waveform-plot";
import {
  CYCLE_WIDTH_PERCENT,
  easeOutCubic,
  interpolateOptionalNumber,
  limitPlayheadDensity,
  PLOT_WIDTH,
  VIEW_WIDTH,
  waveformPlotX,
  waveformViewportCycleOffset,
} from "../model/step-fx-waveform-plot";
import type { StepFxWaveformProps } from "../model/step-fx-waveform-types";

const PREVIEW_TRANSITION_DURATION_MS = 240;
type StepFxWaveformPreviewOptions = Pick<
  StepFxWaveformProps,
  | "attribute"
  | "beatDurationSeconds"
  | "centerSelectedFixture"
  | "cycleScale"
  | "direction"
  | "onLiveStepChange"
  | "previewActive"
  | "previewIndex"
  | "previewStatus"
  | "selectionLabels"
  | "selectionPhaseOffset"
  | "selectionPhaseOffsets"
  | "selectionPhaseWrapsCycle"
  | "showAllPlayheads"
  | "trackKind"
>;

/** Samples the backend clock and owns animation, density, and repeated-cycle placement. */
export function createStepFxWaveformPreview(
  props: StepFxWaveformPreviewOptions,
  model: Accessor<StepFxWaveformModel | null>,
  plotWidthPx: Accessor<number>,
) {
  const [previewEpochMs, setPreviewEpochMs] = createSignal(Date.now());
  const [centerModeBlend, setCenterModeBlend] = createSignal(
    props.centerSelectedFixture ? 1 : 0,
  );
  const [centerModeTransitioning, setCenterModeTransitioning] =
    createSignal(false);
  const [directionFrom, setDirectionFrom] = createSignal(props.direction);
  const [directionTo, setDirectionTo] = createSignal(props.direction);
  const [directionBlend, setDirectionBlend] = createSignal(1);
  const [directionTransitioning, setDirectionTransitioning] =
    createSignal(false);
  let previewFrame: number | undefined;
  let centerModeFrame: number | undefined;
  let directionFrame: number | undefined;
  /** Refreshes browser time while the backend-owned preview clock is available. */
  const animatePreview = (): void => {
    setPreviewEpochMs(Date.now());
    previewFrame = requestAnimationFrame(animatePreview);
  };

  /** Runs interpolation only after this session has an authoritative backend anchor. */
  createEffect(() => {
    if (!props.previewActive || !props.previewStatus) {
      if (previewFrame !== undefined) cancelAnimationFrame(previewFrame);
      previewFrame = undefined;
      return;
    }
    setPreviewEpochMs(Date.now());
    if (previewFrame === undefined)
      previewFrame = requestAnimationFrame(animatePreview);
  });

  /** Eases mode changes without making the continuously moving waveform trail its playhead. */
  createEffect(
    on(
      () => props.centerSelectedFixture,
      (centerFixture, previousCenterFixture) => {
        if (centerModeFrame !== undefined)
          cancelAnimationFrame(centerModeFrame);
        centerModeFrame = undefined;
        const targetBlend = centerFixture ? 1 : 0;
        if (previousCenterFixture === undefined || reducedMotion.get()) {
          setCenterModeBlend(targetBlend);
          setCenterModeTransitioning(false);
          return;
        }

        const initialBlend = centerModeBlend();
        const startedAt = performance.now();
        setCenterModeTransitioning(true);

        /** Advances the eased interpolation while live beat sampling continues independently. */
        const animateModeTransition = (now: number): void => {
          const progress = Math.min(
            1,
            (now - startedAt) / PREVIEW_TRANSITION_DURATION_MS,
          );
          const easedProgress = easeOutCubic(progress);
          setCenterModeBlend(
            initialBlend + (targetBlend - initialBlend) * easedProgress,
          );
          if (progress < 1) {
            centerModeFrame = requestAnimationFrame(animateModeTransition);
            return;
          }
          centerModeFrame = undefined;
          setCenterModeTransitioning(false);
        };

        centerModeFrame = requestAnimationFrame(animateModeTransition);
      },
    ),
  );

  /** Blends old and new direction mappings so the live preview does not jump. */
  createEffect(
    on(
      () => props.direction,
      (direction, previousDirection) => {
        if (directionFrame !== undefined) cancelAnimationFrame(directionFrame);
        directionFrame = undefined;
        if (previousDirection === undefined || reducedMotion.get()) {
          setDirectionFrom(direction);
          setDirectionTo(direction);
          setDirectionBlend(1);
          setDirectionTransitioning(false);
          return;
        }

        setDirectionFrom(directionTo());
        setDirectionTo(direction);
        setDirectionBlend(0);
        setDirectionTransitioning(true);
        const startedAt = performance.now();

        /** Advances the direction remap while both endpoint samples continue moving. */
        const animateDirectionTransition = (now: number): void => {
          const progress = Math.min(
            1,
            (now - startedAt) / PREVIEW_TRANSITION_DURATION_MS,
          );
          setDirectionBlend(easeOutCubic(progress));
          if (progress < 1) {
            directionFrame = requestAnimationFrame(animateDirectionTransition);
            return;
          }
          directionFrame = undefined;
          setDirectionFrom(direction);
          setDirectionTransitioning(false);
        };

        directionFrame = requestAnimationFrame(animateDirectionTransition);
      },
    ),
  );

  /** Samples every requested phase index from one interpolated backend clock instant. */
  const rawPlayheadSamples = createMemo<StepFxPlayheadSample[]>(() => {
    const waveform = model();
    if (!waveform) return [];
    const indexes =
      props.showAllPlayheads && props.selectionPhaseOffsets.length > 0
        ? props.selectionPhaseOffsets.map((_, index) => index)
        : [props.previewIndex];
    const offsets = indexes.map((index) =>
      index === props.previewIndex
        ? props.selectionPhaseOffset
        : (props.selectionPhaseOffsets[index] ?? 0),
    );
    const activePreviewStatus = props.previewActive
      ? props.previewStatus
      : undefined;
    const fromBeats = stepFxPreviewOrStartBeats(
      activePreviewStatus,
      props.attribute,
      props.trackKind,
      waveform.totalBeats,
      props.beatDurationSeconds,
      previewEpochMs(),
      offsets,
      directionFrom(),
      props.cycleScale,
    );
    const toBeats =
      directionFrom() === directionTo()
        ? fromBeats
        : stepFxPreviewOrStartBeats(
            activePreviewStatus,
            props.attribute,
            props.trackKind,
            waveform.totalBeats,
            props.beatDurationSeconds,
            previewEpochMs(),
            offsets,
            directionTo(),
            props.cycleScale,
          );
    const beats = indexes.map((_, index) =>
      interpolateOptionalNumber(
        fromBeats[index],
        toBeats[index],
        directionBlend(),
      ),
    );
    const selectedBeat = beats[indexes.indexOf(props.previewIndex)];
    const samples = indexes
      .map((previewIndex, index): StepFxPlayheadSample | null => {
        const beat = beats[index];
        if (beat === undefined) return null;
        const sample = sampleStepFxWaveformAtPosition(waveform, beat);
        if (!sample) return null;
        return {
          cycleOffset:
            selectedBeat === undefined
              ? 0
              : stepFxPlayheadCycleOffset(
                  beat,
                  selectedBeat,
                  offsets[index] ?? 0,
                  props.selectionPhaseOffset,
                  waveform.totalBeats,
                  props.direction,
                  props.selectionPhaseWrapsCycle,
                ),
          previewIndex,
          label: props.selectionLabels[previewIndex],
          selected: previewIndex === props.previewIndex,
          sample,
        };
      })
      .filter((entry): entry is StepFxPlayheadSample => entry !== null)
      .sort((left, right) => Number(left.selected) - Number(right.selected));
    return samples;
  });

  /** Limits visible playheads to the responsive plot capacity when Show all is active. */
  const playheadSamples = createMemo(() =>
    props.showAllPlayheads
      ? limitPlayheadDensity(
          rawPlayheadSamples(),
          plotWidthPx() * (PLOT_WIDTH / VIEW_WIDTH),
        )
      : rawPlayheadSamples(),
  );

  /** Describes density sampling while keeping identical frame-to-frame content stable. */
  const samplingWarningMessage = createMemo(() => {
    const total = rawPlayheadSamples().length;
    const shown = playheadSamples().length;
    return props.showAllPlayheads && shown < total
      ? `Showing ${shown} of ${total} playheads to reduce visual clutter. The selected index is always shown.`
      : null;
  });

  /** Returns the selected playhead retained through responsive density limiting. */
  const selectedPlayhead = createMemo(
    () => playheadSamples().find((entry) => entry.selected) ?? null,
  );

  /** Returns the selected sample only while an authoritative live preview exists. */
  const previewSample = createMemo(() =>
    props.previewActive && props.previewStatus
      ? (selectedPlayhead()?.sample ?? null)
      : null,
  );

  /** Repeats adjacent authored cycles only while the waveform scrolls under the fixture. */
  const waveformCycleOffsets = createMemo(() =>
    centerModeBlend() > Number.EPSILON && props.direction !== FxDirection.Bounce
      ? [-1, 0, 1]
      : [0],
  );

  /** Centers the active fixture while blending smoothly between scroll modes. */
  const waveformViewportTranslationPercent = (
    waveform: StepFxWaveformModel,
  ): number => {
    const selectedBeat = selectedPlayhead()?.sample.beat;
    return selectedBeat === undefined
      ? 0
      : (50 - (waveformPlotX(waveform, selectedBeat) / VIEW_WIDTH) * 100) *
          centerModeBlend();
  };

  /** Chooses the repeated cycle that keeps one playhead in the shared viewport. */
  const playheadCycleOffset = (playhead: StepFxPlayheadSample): number => {
    const waveform = model();
    if (!waveform) return 0;
    const viewportTranslation = waveformViewportTranslationPercent(waveform);
    if (centerModeBlend() > Number.EPSILON) {
      const selected = selectedPlayhead();
      const selectedCycleOffset = selected
        ? waveformViewportCycleOffset(
            waveform,
            selected.sample.beat,
            viewportTranslation,
          )
        : 0;
      return playhead.cycleOffset + selectedCycleOffset;
    }
    return 0;
  };

  /** Returns each playhead only in the waveform cycle preserving its spread position. */
  const playheadSamplesForCycle = (
    cycleOffset: number,
  ): StepFxPlayheadSample[] =>
    playheadSamples().filter(
      (playhead) => playheadCycleOffset(playhead) === cycleOffset,
    );

  /** Returns the selected playhead only for the cycle that visibly owns it. */
  const selectedPlayheadForCycle = (
    cycleOffset: number,
  ): StepFxPlayheadSample | null => {
    const selected = selectedPlayhead();
    return selected && playheadCycleOffset(selected) === cycleOffset
      ? selected
      : null;
  };

  /** Applies the shared viewport offset and positions one repeated authored cycle. */
  const waveformCycleTranslation = (
    waveform: StepFxWaveformModel,
    cycleOffset: number,
  ): string =>
    `translateX(${cycleOffset * CYCLE_WIDTH_PERCENT + waveformViewportTranslationPercent(waveform)}%)`;

  /** Evaluates the selected index's stable assigned offset on the authored graph. */
  const phaseMarkerSample = createMemo(() => {
    const waveform = model();
    if (!waveform) return null;
    const beat = interpolateOptionalNumber(
      stepFxPhaseMarkerBeat(
        props.selectionPhaseOffset,
        waveform.totalBeats,
        directionFrom(),
      ),
      stepFxPhaseMarkerBeat(
        props.selectionPhaseOffset,
        waveform.totalBeats,
        directionTo(),
      ),
      directionBlend(),
    );
    return beat === undefined
      ? null
      : sampleStepFxWaveformAtPosition(waveform, beat);
  });

  /** Chooses the one repeated cycle that owns the visible start annotation. */
  const phaseMarkerCycleOffset = createMemo(() => {
    const waveform = model();
    const sample = phaseMarkerSample();
    return waveform && sample
      ? waveformViewportCycleOffset(
          waveform,
          sample.beat,
          waveformViewportTranslationPercent(waveform),
        )
      : 0;
  });

  /** Publishes the sampled authored step so sibling editor views stay synchronized. */
  createEffect(() => {
    props.onLiveStepChange?.(previewSample()?.segment.stepUid);
  });

  /** Cancels animation frames and clears the published live step on unmount. */
  onCleanup(() => {
    if (previewFrame !== undefined) cancelAnimationFrame(previewFrame);
    if (centerModeFrame !== undefined) cancelAnimationFrame(centerModeFrame);
    if (directionFrame !== undefined) cancelAnimationFrame(directionFrame);
    props.onLiveStepChange?.(undefined);
  });
  return {
    samplingWarningMessage,
    previewSample,
    waveformCycleOffsets,
    waveformCycleTranslation,
    phaseMarkerSample,
    phaseMarkerCycleOffset,
    playheadSamplesForCycle,
    selectedPlayheadForCycle,
    centerModeTransitioning,
    directionTransitioning,
  };
}

/** Reactive preview accessors consumed by waveform presentation. */
export type StepFxWaveformPreview = ReturnType<
  typeof createStepFxWaveformPreview
>;
