// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { FxDirection } from "../../../types";
import {
  type StepFxPositionUnit,
  stepFxPositionUnitScale,
  stepFxPositionUnitSuffix,
} from "./step-fx-editor-model";
import {
  type StepFxWaveformModel,
  type StepFxWaveformSegment,
  type sampleStepFxWaveformAtPosition,
  stepFxWaveformX,
  stepFxWaveformY,
} from "./step-fx-waveform-model";

export const VIEW_WIDTH = 1_000;
export const VIEW_HEIGHT = 120;
export const PLOT_TOP = 8;
export const PLOT_HEIGHT = 104;
export const PLOT_LEFT = (PLOT_TOP / VIEW_HEIGHT) * VIEW_WIDTH;
export const PLOT_WIDTH = VIEW_WIDTH - PLOT_LEFT * 2;
export const CYCLE_WIDTH_PERCENT = (PLOT_WIDTH / VIEW_WIDTH) * 100;
export const PLOT_INSET_PERCENT = (PLOT_LEFT / VIEW_WIDTH) * 100;
const PLAYHEAD_MIN_SPACING_PX = 20;
const START_MARKER_INSET_PX = 4;
const STEP_DIVIDER_LABEL_MIN_SPACING_PX = 36;

export interface StepFxPlayheadSample {
  cycleOffset: number;
  previewIndex: number;
  label?: string;
  selected: boolean;
  sample: NonNullable<ReturnType<typeof sampleStepFxWaveformAtPosition>>;
}

/** Applies the shared ease-out curve used by finite preview control transitions. */
export function easeOutCubic(progress: number): number {
  return 1 - (1 - progress) ** 3;
}

/** Interpolates two optional live values only when both endpoint samples exist. */
export function interpolateOptionalNumber(
  from: number | undefined,
  to: number | undefined,
  progress: number,
): number | undefined {
  if (from === undefined || to === undefined) return undefined;
  return from + (to - from) * progress;
}

/** Evenly samples playheads to the plot's pixel capacity while retaining selection. */
export function limitPlayheadDensity(
  samples: StepFxPlayheadSample[],
  plotWidthPx: number,
): StepFxPlayheadSample[] {
  const selected = samples.find((sample) => sample.selected);
  const capacity = Math.max(
    1,
    Math.floor(plotWidthPx / PLAYHEAD_MIN_SPACING_PX),
  );
  if (samples.length <= capacity) return samples;
  if (capacity === 1) return selected ? [selected] : samples.slice(0, 1);

  const candidates = samples.filter((sample) => sample !== selected);
  const availableSlots = capacity - Number(Boolean(selected));
  const retained = Array.from(
    { length: availableSlots },
    (_, slot) =>
      candidates[Math.floor((slot * candidates.length) / availableSlots)],
  ).filter((sample): sample is StepFxPlayheadSample => sample !== undefined);
  return selected ? [...retained, selected] : retained;
}

/** Maps one authored beat into the horizontally inset plot coordinate. */
export function waveformPlotX(
  model: StepFxWaveformModel,
  beat: number,
): number {
  return PLOT_LEFT + stepFxWaveformX(model, beat, PLOT_WIDTH);
}

/** Insets the semantic cycle-start marker by a fixed rendered-pixel distance. */
export function phaseMarkerPlotX(
  model: StepFxWaveformModel,
  beat: number,
  plotWidthPx: number,
): number {
  const semanticX = waveformPlotX(model, beat);
  if (Math.abs(beat) > Number.EPSILON) return semanticX;
  const viewUnitsPerPixel = plotWidthPx > 0 ? VIEW_WIDTH / plotWidthPx : 1;
  return Math.min(
    PLOT_LEFT + PLOT_WIDTH,
    semanticX + START_MARKER_INSET_PX * viewUnitsPerPixel,
  );
}

/** Clips the path at an inset cycle-start marker without changing authored geometry. */
export function waveformPathClipX(
  model: StepFxWaveformModel,
  phaseMarkerBeat: number | undefined,
  plotWidthPx: number,
): number {
  return phaseMarkerBeat !== undefined &&
    Math.abs(phaseMarkerBeat) <= Number.EPSILON
    ? phaseMarkerPlotX(model, phaseMarkerBeat, plotWidthPx)
    : PLOT_LEFT;
}

/** Filters step-divider labels to the spacing available in the rendered graph. */
export function stepDividerLabelSegments(
  model: StepFxWaveformModel,
  plotWidthPx: number,
): StepFxWaveformSegment[] {
  const graphWidthPx = plotWidthPx * (PLOT_WIDTH / VIEW_WIDTH);
  if (graphWidthPx <= 0) return model.segments;
  let previousLabelX = Number.NEGATIVE_INFINITY;
  return model.segments.filter((segment) => {
    const labelX = stepFxWaveformX(model, segment.startBeat, graphWidthPx);
    if (labelX - previousLabelX < STEP_DIVIDER_LABEL_MIN_SPACING_PX) {
      return false;
    }
    previousLabelX = labelX;
    return true;
  });
}

/** Maps a beat duration into the inset plot's horizontal width. */
export function waveformPlotWidth(
  model: StepFxWaveformModel,
  beats: number,
): number {
  return stepFxWaveformX(model, beats, PLOT_WIDTH);
}

/** Maps one parameter value into the vertically padded plot coordinate. */
export function waveformPlotY(
  model: StepFxWaveformModel,
  value: number,
): number {
  return PLOT_TOP + stepFxWaveformY(model, value, PLOT_HEIGHT);
}

/** Returns the semantic scale rectangle inside the model's padded value domain. */
export function waveformGraphVerticalBounds(model: StepFxWaveformModel): {
  top: number;
  bottom: number;
  height: number;
} {
  const top = waveformPlotY(model, model.scaleMaximumValue);
  const bottom = waveformPlotY(model, model.scaleMinimumValue);
  return { top, bottom, height: bottom - top };
}

/** Right-aligns one scale label inside the gutter preceding the waveform graph. */
export function waveformScaleLabelStyle(
  model: StepFxWaveformModel,
  value: number,
): Record<string, string> {
  return {
    left: "0",
    width: `${(PLOT_LEFT / VIEW_WIDTH) * 100}%`,
    top: `${(waveformPlotY(model, value) / VIEW_HEIGHT) * 100}%`,
  };
}

/** Positions one accessible segment hit target over its SVG interval. */
export function segmentButtonStyle(
  model: StepFxWaveformModel,
  segment: StepFxWaveformSegment,
): Record<string, string> {
  const graphBounds = waveformGraphVerticalBounds(model);
  return {
    left: `${(waveformPlotX(model, segment.startBeat) / VIEW_WIDTH) * 100}%`,
    width: `${(waveformPlotWidth(model, segment.endBeat - segment.startBeat) / VIEW_WIDTH) * 100}%`,
    top: `${(graphBounds.top / VIEW_HEIGHT) * 100}%`,
    height: `${(graphBounds.height / VIEW_HEIGHT) * 100}%`,
  };
}

/** Positions one ramp endpoint at its authored time and value. */
export function controlPointStyle(
  model: StepFxWaveformModel,
  segment: StepFxWaveformSegment,
  point: "ramp-start" | "ramp-end",
): Record<string, string> {
  const isStart = point === "ramp-start";
  return {
    left: `${(waveformPlotX(model, isStart ? segment.transitionStartBeat : segment.transitionEndBeat) / VIEW_WIDTH) * 100}%`,
    top: `${(waveformPlotY(model, isStart ? segment.fromValue : segment.targetValue) / VIEW_HEIGHT) * 100}%`,
  };
}

/** Positions the pointer hit target over one internal step boundary. */
export function boundaryHandleStyle(
  model: StepFxWaveformModel,
  trailingSegment: StepFxWaveformSegment,
): Record<string, string> {
  const graphBounds = waveformGraphVerticalBounds(model);
  return {
    left: `${(waveformPlotX(model, trailingSegment.startBeat) / VIEW_WIDTH) * 100}%`,
    top: `${(graphBounds.top / VIEW_HEIGHT) * 100}%`,
    height: `${(graphBounds.height / VIEW_HEIGHT) * 100}%`,
  };
}

/** Clamps a finite drag value to an inclusive range. */
export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

/** Chooses the repeated cycle that keeps one translated playhead in the viewport. */
export function waveformViewportCycleOffset(
  model: StepFxWaveformModel,
  beat: number,
  translationPercent: number,
): number {
  const translatedPosition =
    (waveformPlotX(model, beat) / VIEW_WIDTH) * 100 + translationPercent;
  const graphLeft = (PLOT_LEFT / VIEW_WIDTH) * 100;
  const graphRight = ((PLOT_LEFT + PLOT_WIDTH) / VIEW_WIDTH) * 100;
  if (translatedPosition >= graphLeft && translatedPosition <= graphRight)
    return 0;
  return Math.round((50 - translatedPosition) / CYCLE_WIDTH_PERCENT);
}

/** Maps an authored marker position back to the nearest directional phase offset. */
export function draggedPhaseOffset(
  authoredPosition: number,
  currentOffset: number,
  direction: FxDirection,
): number {
  const period = direction === FxDirection.Bounce ? 2 : 1;
  const currentWithinPeriod = ((currentOffset % period) + period) % period;
  const base =
    direction === FxDirection.Reverse
      ? 1 - authoredPosition
      : direction === FxDirection.Bounce && currentWithinPeriod > 1
        ? 2 - authoredPosition
        : authoredPosition;
  return base + Math.round((currentOffset - base) / period) * period;
}

/** Maps horizontal pointer movement to the signed phase delta visible in one direction. */
export function directionalPhaseDelta(
  pointerDelta: number,
  currentOffset: number,
  direction: FxDirection,
): number {
  if (direction === FxDirection.Reverse) return -pointerDelta;
  if (direction !== FxDirection.Bounce) return pointerDelta;
  const currentWithinPeriod = ((currentOffset % 2) + 2) % 2;
  return currentWithinPeriod > 1 ? -pointerDelta : pointerDelta;
}

/** Finds one stable step's authored index for operator-facing drag labels. */
export function leadingSegmentIndex(
  model: StepFxWaveformModel,
  stepUid: string,
): number {
  return Math.max(
    0,
    model.segments.find((segment) => segment.stepUid === stepUid)?.stepIndex ??
      0,
  );
}

/** Describes authored timing for pointer hover without introducing another editor model. */
export function segmentTitle(segment: StepFxWaveformSegment): string {
  return `Step ${segment.stepIndex + 1}: ${formatWaveformValue(segment.endBeat - segment.startBeat)} beats, ramp ${formatWaveformValue(segment.transitionStartBeat - segment.startBeat)}–${formatWaveformValue(segment.transitionEndBeat - segment.startBeat)}`;
}

/** Reports whether the visible value domain contains the relative zero baseline. */
export function containsZero(model: StepFxWaveformModel): boolean {
  return model.minimumValue <= 0 && model.maximumValue >= 0;
}

/** Formats beat and value labels without visually noisy floating-point tails. */
export function formatWaveformValue(value: number): string {
  return Number(value.toFixed(2)).toString();
}

/** Formats one physical step boundary as its direction-aware cycle position. */
export function formatStepDividerPosition(
  model: StepFxWaveformModel,
  segment: StepFxWaveformSegment,
  direction: FxDirection,
  unit: StepFxPositionUnit,
): string {
  const waveformPosition = segment.startBeat / model.totalBeats;
  return `${formatWaveformLabelValue(
    stepDividerCyclePosition(waveformPosition, direction) *
      stepFxPositionUnitScale(unit),
  )}${stepFxPositionUnitSuffix(unit)}`;
}

/** Maps a drawn waveform position to the first cycle offset that reaches it. */
export function stepDividerCyclePosition(
  waveformPosition: number,
  direction: FxDirection,
): number {
  if (direction === FxDirection.Reverse) return 1 - waveformPosition;
  return waveformPosition;
}

/** Formats semantic scale bounds without exposing normalized percentage storage. */
export function formatWaveformScaleValue(
  model: StepFxWaveformModel,
  value: number,
): string {
  return formatWaveformLabelValue(
    model.scaleKind === "percent" ? value * 100 : value,
  );
}

/** Formats visible waveform axis labels with at most one decimal place. */
export function formatWaveformLabelValue(value: number): string {
  return Number(value.toFixed(1)).toString();
}
