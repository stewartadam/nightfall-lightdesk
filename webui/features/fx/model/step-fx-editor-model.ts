// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { durationToSeconds, secondsToDuration } from "../../../lib/duration";
import type * as types from "../../../types";
import { FxDirection } from "../../../types";

/** Operator-facing units accepted by the Step FX speed control. */
export type StepFxSpeedUnit = "BPM" | "Hz" | "Seconds" | "Milliseconds";

/** Display units available for normalized Step FX cycle positions. */
export type StepFxPositionUnit = "percent" | "degrees";

/** Identifies one absolute or relative lane track. */
export type StepFxTrackKind = "absolute" | "relative";

/** Returns the normalized-cycle multiplier for the selected display unit. */
export function stepFxPositionUnitScale(unit: StepFxPositionUnit): number {
  return unit === "percent" ? 100 : 360;
}

/** Returns the compact suffix associated with one position display unit. */
export function stepFxPositionUnitSuffix(unit: StepFxPositionUnit): string {
  return unit === "percent" ? "%" : "°";
}

/** A path-addressed validation error suitable for marking an editor control. */
export interface StepFxDraftIssue {
  path: string;
  message: string;
}

/** Clones serializable Step FX state, including values exposed through store proxies. */
export function cloneStepFx(stepFx: types.StepFx): types.StepFx {
  return JSON.parse(JSON.stringify(stepFx)) as types.StepFx;
}

/** Compares complete Step FX definitions, including stable step identities. */
export function stepFxEquals(left: types.StepFx, right: types.StepFx): boolean {
  return (
    JSON.stringify(normalizedStepFxValue(left)) ===
    JSON.stringify(normalizedStepFxValue(right))
  );
}

/** Canonicalizes equivalent websocket and browser object representations recursively. */
function normalizedStepFxValue(value: unknown, key = ""): unknown {
  if (value == null) return undefined;
  if (typeof value === "string") {
    return key === "uid" || key.endsWith("_uid")
      ? normalizedUuid(value)
      : value;
  }
  if (Array.isArray(value)) {
    if (key === "union" && value.length === 0) return undefined;
    return value.map((item) => normalizedStepFxValue(item));
  }
  if (typeof value !== "object") return value;
  const normalized: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value).sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    const child = normalizedStepFxValue(childValue, childKey);
    if (child !== undefined) normalized[childKey] = child;
  }
  return normalized;
}

/** Canonicalizes compact and hyphenated UUID strings to one lowercase form. */
function normalizedUuid(value: string): string {
  return value.replace(/-/g, "").toLowerCase();
}

/** Returns a concise display label for a generated Attribute union value. */
export function stepFxAttributeName(attribute: types.Attribute): string {
  return attribute.type === "Custom" ? attribute.data.label : attribute.type;
}

/** Returns the editable numeric component of a step target. */
export function stepFxTargetValue(target: types.ParameterValue): number {
  return target.type === "Absolute" || target.type === "AbsolutePercent"
    ? target.data.value
    : target.data.offset;
}

/** Returns a target of the requested track polarity while preserving percent/raw form. */
export function setStepFxTargetValue(
  target: types.ParameterValue,
  value: number,
  kind: StepFxTrackKind,
): types.ParameterValue {
  const percent =
    target.type === "AbsolutePercent" || target.type === "RelativePercent";
  if (kind === "absolute") {
    return percent
      ? { type: "AbsolutePercent", data: { value } }
      : { type: "Absolute", data: { value } };
  }
  return percent
    ? { type: "RelativePercent", data: { offset: value } }
    : { type: "Relative", data: { offset: value } };
}

/** Formats a Step FX target in operator-facing percentage units. */
export function formatStepFxTarget(target: types.ParameterValue): string {
  return formatNumber(stepFxTargetValue(target) * 100);
}

/** Parses operator-facing percentage units into a normalized Step FX target. */
export function parseStepFxTarget(
  input: string,
  kind: StepFxTrackKind,
): types.ParameterValue | null {
  const trimmed = input.trim();
  const numeric = Number(trimmed.replace(/%$/, ""));
  if (!trimmed || !Number.isFinite(numeric)) return null;
  const value = numeric / 100;
  const template =
    kind === "absolute"
      ? ({ type: "AbsolutePercent", data: { value: 0 } } as const)
      : ({ type: "RelativePercent", data: { offset: 0 } } as const);
  return setStepFxTargetValue(template, value, kind);
}

/** Parses portable step JSON or plain line-separated values from the clipboard. */
export function stepFxStepsFromClipboard(
  text: string,
  kind: StepFxTrackKind,
  template: types.FxStep,
): types.FxStep[] {
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.filter(isFxStepClipboardValue);
  } catch {}

  return text
    .split(/\r?\n/)
    .map((value) => parseStepFxTarget(value, kind))
    .filter((target): target is types.ParameterValue => Boolean(target))
    .map((target) => ({
      ...structuredClone(template),
      uid: crypto.randomUUID(),
      target,
    }));
}

/** Returns the splice position immediately after the last selected authored step. */
export function stepFxPasteInsertionIndex(
  track: types.FxTrack,
  selectedUids: ReadonlySet<string>,
): number {
  let lastSelectedIndex = -1;
  track.steps.forEach((step, index) => {
    if (selectedUids.has(step.uid)) lastSelectedIndex = index;
  });
  return lastSelectedIndex >= 0 ? lastSelectedIndex + 1 : track.steps.length;
}

/** Narrows clipboard JSON to step-shaped objects before consumers read fields. */
function isFxStepClipboardValue(value: unknown): value is types.FxStep {
  if (!isRecord(value)) return false;
  const candidate = value as Partial<types.FxStep>;
  return (
    typeof candidate.uid === "string" &&
    typeof candidate.width_beats === "number" &&
    Number.isFinite(candidate.width_beats) &&
    candidate.width_beats > 0 &&
    isStepFxTransitionClipboardValue(candidate.transition) &&
    isParameterValueClipboardValue(candidate.target) &&
    isCurveClipboardValue(candidate.curve)
  );
}

/** Narrows structured clipboard data to a valid normalized transition window. */
function isStepFxTransitionClipboardValue(
  value: unknown,
): value is types.StepFxTransition {
  if (!isRecord(value)) return false;
  const start = value.start;
  const end = value.end;
  return (
    typeof start === "number" &&
    Number.isFinite(start) &&
    start >= 0 &&
    start <= 1 &&
    typeof end === "number" &&
    Number.isFinite(end) &&
    end >= start &&
    end <= 1
  );
}

/** Narrows an unknown clipboard value to a plain keyed object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Validates one complete tagged parameter value from structured clipboard input. */
function isParameterValueClipboardValue(
  value: unknown,
): value is types.ParameterValue {
  if (!isRecord(value) || !isRecord(value.data)) return false;
  switch (value.type) {
    case "Absolute":
    case "AbsolutePercent":
      return (
        typeof value.data.value === "number" &&
        Number.isFinite(value.data.value)
      );
    case "Relative":
    case "RelativePercent":
      return (
        typeof value.data.offset === "number" &&
        Number.isFinite(value.data.offset)
      );
    default:
      return false;
  }
}

/** Validates one complete tagged transition curve from structured clipboard input. */
function isCurveClipboardValue(value: unknown): value is types.CurveType {
  if (!isRecord(value) || !isRecord(value.data)) return false;
  if (value.type === "Linear" || value.type === "Snap") return true;
  if (value.type !== "Bezier") return false;
  return (
    isPointClipboardValue(value.data.cp1) &&
    isPointClipboardValue(value.data.cp2)
  );
}

/** Validates one finite two-dimensional Bézier control point. */
function isPointClipboardValue(value: unknown): value is types.Point2D {
  return (
    isRecord(value) &&
    typeof value.x === "number" &&
    Number.isFinite(value.x) &&
    typeof value.y === "number" &&
    Number.isFinite(value.y)
  );
}

/** Converts canonical beat duration into one operator-facing speed unit. */
export function stepFxSpeedValue(
  timing: types.StepFxTiming,
  unit: StepFxSpeedUnit,
): number {
  const seconds = durationToSeconds(timing.beat_duration);
  const value =
    unit === "BPM"
      ? 60 / seconds
      : unit === "Hz"
        ? 1 / seconds
        : unit === "Milliseconds"
          ? seconds * 1000
          : seconds;
  return Number(value.toFixed(6));
}

/** Parses a positive speed value into canonical duration-per-beat storage. */
export function stepFxTimingFromSpeed(
  value: number,
  unit: StepFxSpeedUnit,
): types.StepFxTiming | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  const seconds =
    unit === "BPM"
      ? 60 / value
      : unit === "Hz"
        ? 1 / value
        : unit === "Milliseconds"
          ? value / 1000
          : value;
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return { beat_duration: secondsToDuration(seconds) };
}

/** Returns one track's authored one-way width in beats. */
export function stepFxAuthoredPassBeats(
  track: types.FxTrack | undefined,
): number | null {
  return track?.steps.reduce((sum, step) => sum + step.width_beats, 0) ?? null;
}

/** Derives one track's automatic complete cycle from its pass width and direction. */
export function stepFxAutomaticCycleBeats(
  track: types.FxTrack | undefined,
  direction: FxDirection = FxDirection.Forward,
): number | null {
  const passBeats = stepFxAuthoredPassBeats(track);
  return passBeats === null
    ? null
    : passBeats * stepFxDirectionPassCount(direction);
}

/** Derives one track's complete cycle after scaling its authored pass. */
export function stepFxCycleBeats(
  stepFx: types.StepFx,
  track: types.FxTrack | undefined,
): number | null {
  const passBeats =
    stepFx.cycle_scale.type === "Fixed"
      ? stepFx.cycle_scale.data
      : stepFxAuthoredPassBeats(track);
  return passBeats === null
    ? null
    : passBeats * stepFxDirectionPassCount(stepFx.direction);
}

/** Returns the number of authored passes required by one directional cycle. */
function stepFxDirectionPassCount(direction: FxDirection): number {
  return direction === FxDirection.Bounce ? 2 : 1;
}

/** Formats an operator-facing beat count without floating-point serialization noise. */
export function formatStepFxBeatCount(value: number): string {
  return Number(value.toFixed(6)).toString();
}

/** Rounds one authored step width to the precision exposed by the sheet editor. */
export function roundStepFxWidthBeats(value: number): number {
  return Number(value.toFixed(3));
}

/** Formats one authored step width in beats with at most three decimal places. */
export function formatStepFxWidthBeats(value: number): string {
  return roundStepFxWidthBeats(value).toString();
}

/** Creates a two-step default track for one absolute or relative contribution. */
export function createDefaultStepFxTrack(kind: StepFxTrackKind): types.FxTrack {
  const values = kind === "absolute" ? [1, 0] : [0.25, -0.25];
  return {
    steps: values.map((value) => ({
      uid: crypto.randomUUID(),
      target:
        kind === "absolute"
          ? { type: "AbsolutePercent", data: { value } }
          : { type: "RelativePercent", data: { offset: value } },
      width_beats: 1,
      transition: { start: 0, end: 1 },
      curve: { type: "Snap", data: {} },
    })),
  };
}

/** Creates a new lane with one useful default track. */
export function createDefaultStepFxLane(
  attribute: types.Attribute,
  kind: StepFxTrackKind = "absolute",
): types.FxLane {
  return { attribute, [kind]: createDefaultStepFxTrack(kind) };
}

/** Returns the requested lane track without widening its optional key access. */
export function stepFxTrack(
  lane: types.FxLane,
  kind: StepFxTrackKind,
): types.FxTrack | undefined {
  return kind === "absolute" ? lane.absolute : lane.relative;
}

/** Adds a copied step after the supplied index and assigns a fresh stable identity. */
export function insertStepFxStep(
  track: types.FxTrack,
  afterIndex: number,
): { track: types.FxTrack; uid: string } {
  const next = structuredClone(track);
  const source =
    next.steps[Math.max(0, Math.min(afterIndex, next.steps.length - 1))];
  const inserted: types.FxStep = source
    ? {
        ...structuredClone(source),
        uid: crypto.randomUUID(),
      }
    : {
        uid: crypto.randomUUID(),
        target: { type: "AbsolutePercent", data: { value: 0 } },
        width_beats: 1,
        transition: { start: 0, end: 1 },
        curve: { type: "Snap", data: {} },
      };
  next.steps.splice(Math.max(0, afterIndex + 1), 0, inserted);
  return { track: next, uid: inserted.uid };
}

/** Duplicates selected steps in authored order and assigns independent identities. */
export function duplicateStepFxSteps(
  track: types.FxTrack,
  selectedUids: ReadonlySet<string>,
): { track: types.FxTrack; selectedUids: Set<string> } {
  const steps: types.FxStep[] = [];
  const duplicates = new Set<string>();
  for (const step of track.steps) {
    steps.push(structuredClone(step));
    if (!selectedUids.has(step.uid)) continue;
    const duplicate = {
      ...structuredClone(step),
      uid: crypto.randomUUID(),
    };
    steps.push(duplicate);
    duplicates.add(duplicate.uid);
  }
  return { track: { steps }, selectedUids: duplicates };
}

/** Shares the chosen steps' combined duration evenly without changing other widths. */
export function distributeStepFxWidthsEvenly(
  track: types.FxTrack,
  selectedUids: ReadonlySet<string>,
): types.FxTrack {
  const selectedCount = track.steps.filter((step) =>
    selectedUids.has(step.uid),
  ).length;
  const distributedUids =
    selectedCount > 1
      ? selectedUids
      : new Set(track.steps.map((step) => step.uid));
  const distributedSteps = track.steps.filter((step) =>
    distributedUids.has(step.uid),
  );
  if (distributedSteps.length === 0) return structuredClone(track);
  const totalWidth = distributedSteps.reduce(
    (total, step) => total + step.width_beats,
    0,
  );
  const width = roundStepFxWidthBeats(totalWidth / distributedSteps.length);
  return {
    steps: track.steps.map((step) =>
      distributedUids.has(step.uid)
        ? { ...structuredClone(step), width_beats: width }
        : structuredClone(step),
    ),
  };
}

/** Deletes selected steps and chooses the nearest survivor for continued editing. */
export function deleteStepFxSteps(
  track: types.FxTrack,
  selectedUids: ReadonlySet<string>,
): { track: types.FxTrack; selectedUids: Set<string> } {
  const firstSelected = track.steps.findIndex((step) =>
    selectedUids.has(step.uid),
  );
  const steps = track.steps
    .filter((step) => !selectedUids.has(step.uid))
    .map((step) => structuredClone(step));
  const selected = new Set<string>();
  if (steps.length > 0) {
    selected.add(
      steps[Math.min(Math.max(firstSelected, 0), steps.length - 1)].uid,
    );
  }
  return { track: { steps }, selectedUids: selected };
}

/** Moves selected steps by one position while retaining step and link identities. */
export function reorderStepFxSteps(
  track: types.FxTrack,
  selectedUids: ReadonlySet<string>,
  direction: -1 | 1,
): types.FxTrack {
  const steps = track.steps.map((step) => structuredClone(step));
  const indexes = steps
    .map((step, index) => (selectedUids.has(step.uid) ? index : -1))
    .filter((index) => index >= 0);
  const ordered = direction < 0 ? indexes : indexes.reverse();
  for (const index of ordered) {
    const target = index + direction;
    if (target < 0 || target >= steps.length) continue;
    if (selectedUids.has(steps[target].uid)) continue;
    [steps[index], steps[target]] = [steps[target], steps[index]];
  }
  return { steps };
}

/** Applies one partial edit to every selected step in a track. */
export function editStepFxSteps(
  track: types.FxTrack,
  selectedUids: ReadonlySet<string>,
  edit: (step: types.FxStep) => types.FxStep,
): types.FxTrack {
  return {
    steps: track.steps.map((step) =>
      selectedUids.has(step.uid)
        ? edit(structuredClone(step))
        : structuredClone(step),
    ),
  };
}

/** Computes half-open phase-envelope values for non-empty selection indexes. */
export function stepFxPhaseSlots(
  phase: types.StepFxPhase,
  indexCount: number,
): number[] {
  if (indexCount <= 0) return [];
  return Array.from({ length: indexCount }, (_, index) =>
    stepFxPhaseOffset(phase, index, indexCount),
  );
}

/** Returns one clamped selection index's normalized offset from authored waypoints. */
export function stepFxPhaseOffset(
  phase: types.StepFxPhase,
  selectionIndex: number,
  indexCount: number,
): number {
  const first = phase.waypoints[0] ?? 0;
  if (phase.waypoints.length <= 1 || indexCount <= 1) return first;
  const index = Math.max(
    0,
    Math.min(indexCount - 1, Math.floor(selectionIndex)),
  );
  const normalizedPosition =
    phase.groups?.type === "Explicit"
      ? Math.floor((index * Math.max(1, phase.groups.data)) / indexCount) /
        Math.max(1, phase.groups.data)
      : index / indexCount;
  const position = normalizedPosition * Math.max(0, phase.waypoints.length - 1);
  const segment = Math.min(Math.floor(position), phase.waypoints.length - 2);
  const factor = position - segment;
  const start = phase.waypoints[segment];
  const end = phase.waypoints[segment + 1];
  return start + (end - start) * factor;
}

/** Validates the complete local draft with the backend's structural rules. */
export function validateStepFxDraft(stepFx: types.StepFx): StepFxDraftIssue[] {
  const issues: StepFxDraftIssue[] = [];
  const add = (path: string, message: string) => issues.push({ path, message });
  if (!Number.isInteger(stepFx.identifiers.id) || stepFx.identifiers.id <= 0) {
    add("identifiers.id", "Step FX ID must be greater than zero");
  }
  if (!validUuid(stepFx.identifiers.uid)) {
    add("identifiers.uid", "Step FX UID must be valid");
  }
  if (!stepFx.identifiers.label.trim())
    add("identifiers.label", "Label cannot be empty");
  if (durationToSeconds(stepFx.timing.beat_duration) <= 0) {
    add("timing.beat_duration", "Beat duration must be greater than zero");
  }
  if (
    stepFx.cycle_scale.type === "Fixed" &&
    (!Number.isFinite(stepFx.cycle_scale.data) || stepFx.cycle_scale.data <= 0)
  ) {
    add(
      "cycle_scale.data",
      "Fixed pass beats must be finite and greater than zero",
    );
  }
  validatePhase(stepFx.phase, "phase", add);
  if (stepFx.lanes.length === 0) {
    add("lanes", "Add at least one attribute lane");
    return issues;
  }

  const attributes = new Set<string>();
  const stepUids = new Set<string>();
  let dynamic = false;
  stepFx.lanes.forEach((lane, laneIndex) => {
    const lanePath = `lanes.${laneIndex}`;
    const attribute = JSON.stringify(lane.attribute);
    if (attributes.has(attribute))
      add(
        `${lanePath}.attribute`,
        "Each attribute may appear in only one lane",
      );
    attributes.add(attribute);
    if (
      lane.timing_override &&
      durationToSeconds(lane.timing_override.beat_duration) <= 0
    ) {
      add(
        `${lanePath}.timing_override.beat_duration`,
        "Beat duration must be greater than zero",
      );
    }
    if (lane.phase_override)
      validatePhase(lane.phase_override, `${lanePath}.phase_override`, add);
    if (!lane.absolute && !lane.relative)
      add(lanePath, "A lane needs absolute or relative steps");

    (["absolute", "relative"] as const).forEach((kind) => {
      const track = stepFxTrack(lane, kind);
      if (!track) return;
      const path = `${lanePath}.${kind}`;
      if (track.steps.length === 0)
        add(`${path}.steps`, "At least one step is required");
      dynamic ||= track.steps.length >= 2;
      track.steps.forEach((step, stepIndex) => {
        const stepPath = `${path}.steps.${stepIndex}`;
        if (!validUuid(step.uid) || stepUids.has(step.uid))
          add(`${stepPath}.uid`, "Step identities must be valid and unique");
        stepUids.add(step.uid);
        if (!Number.isFinite(step.width_beats) || step.width_beats <= 0)
          add(
            `${stepPath}.width_beats`,
            "Width must be finite and greater than zero",
          );
        if (
          !Number.isFinite(step.transition.start) ||
          step.transition.start < 0 ||
          step.transition.start > 1
        )
          add(
            `${stepPath}.transition.start`,
            "Ramp start must be between 0% and 100%",
          );
        if (
          !Number.isFinite(step.transition.end) ||
          step.transition.end < 0 ||
          step.transition.end > 1
        )
          add(
            `${stepPath}.transition.end`,
            "Ramp end must be between 0% and 100%",
          );
        if (step.transition.start > step.transition.end)
          add(`${stepPath}.transition`, "Ramp start must not exceed its end");
        const relative =
          step.target.type === "Relative" ||
          step.target.type === "RelativePercent";
        if (relative !== (kind === "relative"))
          add(
            `${stepPath}.target`,
            kind === "relative"
              ? "Relative steps require relative targets"
              : "Absolute steps require absolute targets",
          );
        if (step.curve.type === "Bezier") {
          const points = [
            step.curve.data.cp1.x,
            step.curve.data.cp1.y,
            step.curve.data.cp2.x,
            step.curve.data.cp2.y,
          ];
          if (
            points.some(
              (value) => !Number.isFinite(value) || value < 0 || value > 1,
            )
          )
            add(
              `${stepPath}.curve`,
              "Curve control points must be between zero and one",
            );
        }
      });
    });
  });
  if (!dynamic) add("lanes", "At least one attribute needs two or more steps");
  return issues;
}

/** Reports whether a reconnect may recreate an editor-owned preview session. */
export function canRestartStepFxPreview(options: {
  previewActive: boolean;
  deletedExternally: boolean;
  hasValidDraft: boolean;
}): boolean {
  return (
    options.previewActive && !options.deletedExternally && options.hasValidDraft
  );
}

/** Formats editor numbers without unnecessary trailing precision. */
function formatNumber(value: number): string {
  return Number(value.toFixed(4)).toString();
}

/** Recognizes compact and hyphenated non-nil UUID strings. */
function validUuid(value: string): boolean {
  const compact = value.replace(/-/g, "").toLowerCase();
  return /^[0-9a-f]{32}$/.test(compact) && compact !== "0".repeat(32);
}

/** Applies shared phase-waypoint validation while retaining backend-compatible paths. */
function validatePhase(
  phase: types.StepFxPhase,
  path: string,
  add: (path: string, message: string) => void,
): void {
  if (phase.waypoints.length === 0)
    add(`${path}.waypoints`, "Phase requires at least one waypoint");
  phase.waypoints.forEach((waypoint, index) => {
    if (!Number.isFinite(waypoint))
      add(`${path}.waypoints.${index}`, "Phase waypoint must be finite");
  });
  if (phase.groups?.type === "Explicit" && phase.groups.data < 1)
    add(`${path}.groups`, "Explicit phase groups must be at least one");
}
