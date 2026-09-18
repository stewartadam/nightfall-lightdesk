// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { FxTrack, ParameterValue } from "../../../types";

/** One authored Step FX interval rendered across the fixed waveform shape. */
export interface StepFxWaveformSegment {
  traversalIndex: number;
  stepIndex: number;
  stepUid: string;
  startBeat: number;
  transitionStartBeat: number;
  transitionEndBeat: number;
  endBeat: number;
  fromValue: number;
  targetValue: number;
  curve: FxTrack["steps"][number]["curve"];
}

/** Validated geometry and display bounds for one complete Step FX cycle. */
export interface StepFxWaveformModel {
  segments: StepFxWaveformSegment[];
  totalBeats: number;
  minimumValue: number;
  maximumValue: number;
  scaleMinimumValue: number;
  scaleMaximumValue: number;
  scaleKind: "number" | "percent";
}

/** Evaluated position and value for one instant within the rendered cycle. */
export interface StepFxWaveformSample {
  beat: number;
  value: number;
  segment: StepFxWaveformSegment;
}

/** Clamps a dragged value to its semantic scale and snaps percentages to half points. */
export function snapStepFxWaveformValue(
  model: StepFxWaveformModel,
  value: number,
): number {
  const snapped =
    model.scaleKind === "percent" ? Math.round(value * 200) / 200 : value;
  return Math.min(
    model.scaleMaximumValue,
    Math.max(model.scaleMinimumValue, snapped),
  );
}

/** Builds the fixed forward-authored shape traversed by every playback direction. */
export function buildStepFxWaveformModel(
  track: FxTrack,
): StepFxWaveformModel | null {
  if (track.steps.length === 0 || !track.steps.every(isRenderableStep)) {
    return null;
  }

  const segments: StepFxWaveformSegment[] = [];
  let startBeat = 0;
  for (const [stepIndex, step] of track.steps.entries()) {
    const previous =
      track.steps[stepIndex - 1] ?? track.steps[track.steps.length - 1];
    const endBeat = startBeat + step.width_beats;
    const transitionStartBeat =
      startBeat + step.width_beats * step.transition.start;
    const transitionEndBeat =
      startBeat + step.width_beats * step.transition.end;
    segments.push({
      traversalIndex: stepIndex,
      stepIndex,
      stepUid: step.uid,
      startBeat,
      transitionStartBeat,
      transitionEndBeat,
      endBeat,
      fromValue: parameterValueNumber(previous.target),
      targetValue: parameterValueNumber(step.target),
      curve: step.curve,
    });
    startBeat = endBeat;
  }

  const values = track.steps.map((step) => parameterValueNumber(step.target));
  const scale = waveformScale(track, values);
  const [minimumValue, maximumValue] = waveformValueBounds([
    scale.minimum,
    scale.maximum,
  ]);
  return {
    segments,
    totalBeats: startBeat,
    minimumValue,
    maximumValue,
    scaleMinimumValue: scale.minimum,
    scaleMaximumValue: scale.maximum,
    scaleKind: scale.kind,
  };
}

/** Produces an exact SVG path for Snap, Linear, and CSS-style Bézier segments. */
export function stepFxWaveformPath(
  model: StepFxWaveformModel,
  width: number,
  height: number,
): string {
  const first = model.segments[0];
  if (!first || width <= 0 || height <= 0) return "";
  const commands = [
    `M ${svgNumber(stepFxWaveformX(model, first.startBeat, width))} ${svgNumber(stepFxWaveformY(model, first.fromValue, height))}`,
  ];

  for (const segment of model.segments) {
    const startX = stepFxWaveformX(model, segment.startBeat, width);
    const transitionStartX = stepFxWaveformX(
      model,
      segment.transitionStartBeat,
      width,
    );
    const transitionEndX = stepFxWaveformX(
      model,
      segment.transitionEndBeat,
      width,
    );
    const endX = stepFxWaveformX(model, segment.endBeat, width);
    const fromY = stepFxWaveformY(model, segment.fromValue, height);
    const targetY = stepFxWaveformY(model, segment.targetValue, height);
    if (transitionStartX > startX) {
      commands.push(`H ${svgNumber(transitionStartX)}`);
    }
    if (
      segment.curve.type === "Snap" ||
      segment.transitionEndBeat <= segment.transitionStartBeat
    ) {
      commands.push(`L ${svgNumber(transitionStartX)} ${svgNumber(targetY)}`);
    } else if (segment.curve.type === "Linear") {
      commands.push(`L ${svgNumber(transitionEndX)} ${svgNumber(targetY)}`);
    } else {
      const transitionWidth = transitionEndX - transitionStartX;
      const deltaY = targetY - fromY;
      const { cp1, cp2 } = segment.curve.data;
      commands.push(
        `C ${svgNumber(transitionStartX + transitionWidth * cp1.x)} ${svgNumber(fromY + deltaY * cp1.y)} ${svgNumber(transitionStartX + transitionWidth * cp2.x)} ${svgNumber(fromY + deltaY * cp2.y)} ${svgNumber(transitionEndX)} ${svgNumber(targetY)}`,
      );
    }
    const holdStartX =
      segment.curve.type === "Snap" ? transitionStartX : transitionEndX;
    if (endX > holdStartX) commands.push(`H ${svgNumber(endX)}`);
  }
  return commands.join(" ");
}

/** Evaluates the waveform at a wrapping beat position using engine curve semantics. */
export function sampleStepFxWaveform(
  model: StepFxWaveformModel,
  beat: number,
): StepFxWaveformSample | null {
  if (!Number.isFinite(beat) || model.totalBeats <= 0) return null;
  const wrappedBeat =
    ((beat % model.totalBeats) + model.totalBeats) % model.totalBeats;
  return sampleStepFxWaveformAtPosition(model, wrappedBeat);
}

/** Evaluates one non-wrapping position on the authored waveform, including its endpoint. */
export function sampleStepFxWaveformAtPosition(
  model: StepFxWaveformModel,
  beat: number,
): StepFxWaveformSample | null {
  if (!Number.isFinite(beat) || model.totalBeats <= 0) return null;
  const position = Math.min(model.totalBeats, Math.max(0, beat));
  if (position === model.totalBeats) {
    const segment = model.segments[model.segments.length - 1];
    return segment
      ? { beat: position, value: segment.targetValue, segment }
      : null;
  }
  const segment =
    model.segments.find((candidate) => position < candidate.endBeat) ??
    model.segments[model.segments.length - 1];
  if (!segment) return null;

  if (position < segment.transitionStartBeat) {
    return { beat: position, value: segment.fromValue, segment };
  }
  const transitionBeats =
    segment.transitionEndBeat - segment.transitionStartBeat;
  if (transitionBeats <= 0 || position >= segment.transitionEndBeat) {
    return { beat: position, value: segment.targetValue, segment };
  }

  const progress = (position - segment.transitionStartBeat) / transitionBeats;
  const curvedProgress = waveformCurveProgress(segment.curve, progress);
  return {
    beat: position,
    value:
      segment.fromValue +
      (segment.targetValue - segment.fromValue) * curvedProgress,
    segment,
  };
}

/** Maps a beat position into an SVG horizontal coordinate. */
export function stepFxWaveformX(
  model: StepFxWaveformModel,
  beat: number,
  width: number,
): number {
  return (beat / model.totalBeats) * width;
}

/** Maps a parameter value into an inverted SVG vertical coordinate. */
export function stepFxWaveformY(
  model: StepFxWaveformModel,
  value: number,
  height: number,
): number {
  return (
    height -
    ((value - model.minimumValue) / (model.maximumValue - model.minimumValue)) *
      height
  );
}

/** Rejects temporary draft values that cannot produce finite SVG geometry. */
function isRenderableStep(step: FxTrack["steps"][number]): boolean {
  if (
    !Number.isFinite(step.width_beats) ||
    step.width_beats <= 0 ||
    !Number.isFinite(step.transition.start) ||
    step.transition.start < 0 ||
    step.transition.start > 1 ||
    !Number.isFinite(step.transition.end) ||
    step.transition.end < step.transition.start ||
    step.transition.end > 1 ||
    !Number.isFinite(parameterValueNumber(step.target))
  ) {
    return false;
  }
  if (step.curve.type !== "Bezier") return true;
  return [
    step.curve.data.cp1.x,
    step.curve.data.cp1.y,
    step.curve.data.cp2.x,
    step.curve.data.cp2.y,
  ].every((value) => Number.isFinite(value) && value >= 0 && value <= 1);
}

/** Reads the numeric component shared by absolute and relative parameter values. */
function parameterValueNumber(value: ParameterValue): number {
  return value.type === "Absolute" || value.type === "AbsolutePercent"
    ? value.data.value
    : value.data.offset;
}

/** Chooses semantic scale labels while preserving padded plotting bounds. */
function waveformScale(
  track: FxTrack,
  values: number[],
): { minimum: number; maximum: number; kind: "number" | "percent" } {
  const targetTypes = new Set(track.steps.map((step) => step.target.type));
  if (targetTypes.size === 1 && targetTypes.has("AbsolutePercent")) {
    return {
      minimum: Math.min(0, ...values),
      maximum: Math.max(1, ...values),
      kind: "percent",
    };
  }
  if (targetTypes.size === 1 && targetTypes.has("RelativePercent")) {
    return {
      minimum: Math.min(-1, ...values),
      maximum: Math.max(1, ...values),
      kind: "percent",
    };
  }
  return {
    minimum: Math.min(...values),
    maximum: Math.max(...values),
    kind: "number",
  };
}

/** Adds stable vertical breathing room, including for constant-value tracks. */
function waveformValueBounds(values: number[]): [number, number] {
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const range = maximum - minimum;
  const padding =
    range > 0 ? range * 0.1 : Math.max(Math.abs(minimum) * 0.1, 0.1);
  return [minimum - padding, maximum + padding];
}

/** Maps normalized transition progress through a Step FX curve. */
function waveformCurveProgress(
  curve: FxTrack["steps"][number]["curve"],
  progress: number,
): number {
  if (curve.type === "Snap") return 1;
  if (curve.type === "Linear") return progress;
  return evaluateCubicBezier(
    curve.data.cp1.x,
    curve.data.cp1.y,
    curve.data.cp2.x,
    curve.data.cp2.y,
    progress,
  );
}

/** Evaluates a normalized CSS-style cubic Bézier timing function. */
function evaluateCubicBezier(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  progress: number,
): number {
  const clampedProgress = Math.min(1, Math.max(0, progress));
  if (clampedProgress === 0 || clampedProgress === 1) return clampedProgress;

  let parameter = clampedProgress;
  for (let iteration = 0; iteration < 8; iteration += 1) {
    const error = cubicBezierComponent(x1, x2, parameter) - clampedProgress;
    if (Math.abs(error) <= 1e-6) {
      return cubicBezierComponent(y1, y2, parameter);
    }
    const derivative = cubicBezierComponentDerivative(x1, x2, parameter);
    if (Math.abs(derivative) <= 1e-6) break;
    const next = parameter - error / derivative;
    if (next < 0 || next > 1) break;
    parameter = next;
  }

  let lower = 0;
  let upper = 1;
  for (let iteration = 0; iteration < 20; iteration += 1) {
    parameter = (lower + upper) * 0.5;
    if (cubicBezierComponent(x1, x2, parameter) < clampedProgress) {
      lower = parameter;
    } else {
      upper = parameter;
    }
  }
  return cubicBezierComponent(y1, y2, parameter);
}

/** Evaluates one normalized cubic Bézier axis. */
function cubicBezierComponent(
  control1: number,
  control2: number,
  parameter: number,
): number {
  const inverse = 1 - parameter;
  return (
    3 * control1 * inverse * inverse * parameter +
    3 * control2 * inverse * parameter * parameter +
    parameter * parameter * parameter
  );
}

/** Evaluates the parameter derivative for one normalized cubic Bézier axis. */
function cubicBezierComponentDerivative(
  control1: number,
  control2: number,
  parameter: number,
): number {
  const inverse = 1 - parameter;
  return (
    3 * control1 * (inverse * inverse - 2 * inverse * parameter) +
    3 * control2 * (2 * inverse * parameter - parameter * parameter) +
    3 * parameter * parameter
  );
}

/** Formats finite SVG coordinates compactly without exponential notation. */
function svgNumber(value: number): string {
  return Number(value.toFixed(3)).toString();
}
