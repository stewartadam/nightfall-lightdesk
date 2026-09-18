// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type * as types from "../types";
import type { Rectangle } from "./data-grid-types";
import { durationToMs, msToDuration } from "./duration";

export type RichCellTone =
  | "neutral"
  | "info"
  | "success"
  | "warning"
  | "danger"
  | "accent";

type RichDropdownOption = {
  value: string | null | undefined;
  label: string;
};

export type RichDropdownCellData = {
  kind: "rich-dropdown-cell";
  value: string | null | undefined;
  allowedValues: readonly RichDropdownOption[];
  placeholder?: string;
  clearable?: boolean;
};

export type RichBadgeTag = {
  label: string;
  tone?: RichCellTone;
  title?: string;
};

export type RichActionButton = {
  actionId: string;
  label: string;
  icon?: string;
  disabled?: boolean;
  tone?: "neutral" | "danger" | "accent";
};

export type RichActionButtonCellData = {
  kind: "rich-action-button-cell";
  actions: readonly RichActionButton[];
};

export type RichRangeCellData = {
  kind: "rich-range-cell";
  value: number;
  min: number;
  max: number;
  mode: "range" | "percentage";
  precision?: number;
  warningAt?: number;
  criticalAt?: number;
};

export type RichColorSwatchCellData = {
  kind: "rich-color-swatch-cell" | "color-cell";
  color: string;
  withLabel?: boolean;
  with_label?: boolean;
  emptyLabel?: string;
};

export type RichTimeDisplayUnit =
  | "auto"
  | "seconds"
  | "milliseconds"
  | "bpm"
  | "hertz";

export type RichTimeCellData = {
  kind: "rich-time-cell";
  value: types.Duration;
  displayUnit?: RichTimeDisplayUnit;
  precision?: number;
  placeholder?: string;
  clearable?: boolean;
  cleared?: boolean;
  minMs?: number;
  displayValue?: string;
  badges?: readonly RichBadgeTag[];
  backgroundFill?: number;
  backgroundFillColor?: string;
};

export type TextMeasurer = (text: string) => number;

type RelativeRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export const CELL_PADDING = 8;
const BUTTON_GAP = 6;
const BADGE_GAP = 4;

function normalizeDropdownOption(
  option: RichDropdownOption | string | null | undefined,
): RichDropdownOption {
  if (typeof option === "string" || option === null || option === undefined) {
    return {
      value: option,
      label: option?.toString() ?? "",
    };
  }
  return option;
}

function getDropdownOptions(cell: RichDropdownCellData): RichDropdownOption[] {
  return cell.allowedValues.map(normalizeDropdownOption);
}

export function getDropdownLabel(data: RichDropdownCellData): string {
  const selected = getDropdownOptions(data).find(
    (option) => option.value === data.value,
  );
  return selected?.label ?? data.placeholder ?? "";
}

export function applyDropdownPaste(
  data: RichDropdownCellData,
  pasted: string,
): RichDropdownCellData {
  const normalized = pasted.trim();
  const match = getDropdownOptions(data).find(
    (option) => option.value === normalized || option.label === normalized,
  );
  return match ? { ...data, value: match.value } : data;
}

export function clearDropdownValue(
  data: RichDropdownCellData,
): RichDropdownCellData {
  return data.clearable === true ? { ...data, value: undefined } : data;
}

export function getVisibleBadgeCount(
  tags: readonly RichBadgeTag[],
  availableWidth: number,
  measure: TextMeasurer,
  compact = false,
): number {
  const horizontalPadding = compact ? 10 : 14;
  let used = 0;
  for (let index = 0; index < tags.length; index += 1) {
    const tagWidth = measure(tags[index].label) + horizontalPadding;
    const nextUsed = used === 0 ? tagWidth : used + BADGE_GAP + tagWidth;
    const remaining = tags.length - index - 1;
    const overflowWidth =
      remaining > 0 ? measure(`+${remaining}`) + horizontalPadding : 0;
    const requiredWidth =
      overflowWidth > 0 ? nextUsed + BADGE_GAP + overflowWidth : nextUsed;
    if (requiredWidth > availableWidth) {
      return index;
    }
    used = nextUsed;
  }
  return tags.length;
}

function getActionButtonRects(
  data: RichActionButtonCellData,
  width: number,
  height: number,
  measure: TextMeasurer,
): Array<RelativeRect & { action: RichActionButton }> {
  const buttonHeight = Math.min(24, Math.max(18, height - 8));
  let x = CELL_PADDING;
  return data.actions.map((action) => {
    const labelWidth = action.icon ? 16 : measure(action.label);
    const buttonWidth = Math.max(24, labelWidth + 18);
    const rect = {
      action,
      x,
      y: (height - buttonHeight) / 2,
      width: Math.min(buttonWidth, Math.max(0, width - x - CELL_PADDING)),
      height: buttonHeight,
    };
    x += buttonWidth + BUTTON_GAP;
    return rect;
  });
}

export function getActionAtPosition(
  data: RichActionButtonCellData,
  width: number,
  height: number,
  posX: number,
  posY: number,
  measure: TextMeasurer,
): RichActionButton | undefined {
  return getActionButtonRects(data, width, height, measure).find(
    (rect) =>
      posX >= rect.x &&
      posX <= rect.x + rect.width &&
      posY >= rect.y &&
      posY <= rect.y + rect.height,
  )?.action;
}

export function clampRangeFill(data: RichRangeCellData): number {
  if (data.max === data.min) return 0;
  return Math.min(
    Math.max((data.value - data.min) / (data.max - data.min), 0),
    1,
  );
}

export function formatRangeValue(data: RichRangeCellData): string {
  const precision = data.precision ?? (data.mode === "percentage" ? 0 : 1);
  if (data.mode === "percentage") {
    return `${(data.value * 100).toFixed(precision)}%`;
  }
  return data.value.toFixed(precision);
}

export function getRangeTone(data: RichRangeCellData): RichCellTone {
  if (data.criticalAt !== undefined && data.value >= data.criticalAt) {
    return "danger";
  }
  if (data.warningAt !== undefined && data.value >= data.warningAt) {
    return "warning";
  }
  return "accent";
}

export function isColorSwatchCellData(
  data: Record<string, unknown>,
): data is RichColorSwatchCellData {
  return data.kind === "rich-color-swatch-cell" || data.kind === "color-cell";
}

export const durationToMilliseconds = durationToMs;
const millisecondsToDuration = msToDuration;

function trimTrailingZeros(value: string): string {
  return value.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

export function chooseAutoDurationDisplayUnit(
  duration: types.Duration,
): Exclude<RichTimeDisplayUnit, "auto"> {
  const ms = durationToMilliseconds(duration);
  if (ms === 0) return "seconds";
  if (ms >= 1000 && ms % 1000 === 0) return "seconds";
  if (ms > 0 && ms < 1000 && Number.isInteger(ms)) return "milliseconds";

  const bpm = 60_000 / ms;
  if (Number.isInteger(bpm) && bpm >= 20 && bpm <= 300) return "bpm";

  return "seconds";
}

export function formatDurationInputValue(
  duration: types.Duration,
  unit: RichTimeDisplayUnit = "seconds",
  precision?: number,
): string {
  if (unit === "auto") {
    return formatDurationInputValue(
      duration,
      chooseAutoDurationDisplayUnit(duration),
      precision,
    );
  }

  const ms = durationToMilliseconds(duration);
  if (unit === "milliseconds") {
    const value = precision === undefined ? Math.round(ms) : ms;
    return `${trimTrailingZeros(value.toFixed(precision ?? 0))}ms`;
  }
  if (unit === "bpm") {
    if (ms === 0) return `${trimTrailingZeros((0).toFixed(precision ?? 1))}bpm`;
    if (ms < 0) return formatDurationInputValue(duration, "seconds", precision);
    const bpm = 60_000 / ms;
    return `${trimTrailingZeros(bpm.toFixed(precision ?? 1))}bpm`;
  }
  if (unit === "hertz") {
    if (ms === 0) return `${trimTrailingZeros((0).toFixed(precision ?? 2))}hz`;
    if (ms < 0) return formatDurationInputValue(duration, "seconds", precision);
    const hz = 1000 / ms;
    return `${trimTrailingZeros(hz.toFixed(precision ?? 2))}hz`;
  }

  const seconds = ms / 1000;
  const secondsPrecision =
    precision ?? (Number.isInteger(seconds) ? 0 : seconds < 1 ? 3 : 2);
  return `${trimTrailingZeros(seconds.toFixed(secondsPrecision))}s`;
}

export function parseDurationInput(
  input: string,
  options?: { minMs?: number },
): types.Duration | null {
  const trimmed = input.trim().toLowerCase();
  if (trimmed === "") return null;

  const match = trimmed.match(
    /^(\d+(?:\.\d+)?|\.\d+)\s*(ms|msec|msecs|millisecond|milliseconds|s|sec|secs|second|seconds|bpm|hz)?$/,
  );
  if (!match) return null;

  const rawValue = Number.parseFloat(match[1]);
  if (!Number.isFinite(rawValue) || rawValue < 0) return null;

  const unit = match[2] ?? "s";
  let ms: number;
  if (
    unit === "ms" ||
    unit === "msec" ||
    unit === "msecs" ||
    unit === "millisecond" ||
    unit === "milliseconds"
  ) {
    ms = rawValue;
  } else if (unit === "bpm") {
    ms = rawValue === 0 ? 0 : 60_000 / rawValue;
  } else if (unit === "hz") {
    ms = rawValue === 0 ? 0 : 1000 / rawValue;
  } else {
    ms = rawValue * 1000;
  }

  if (options?.minMs !== undefined && ms < options.minMs) {
    return null;
  }

  return millisecondsToDuration(ms);
}

export function isTimeCellData(
  data: Record<string, unknown>,
): data is RichTimeCellData {
  return data.kind === "rich-time-cell";
}

export function normalizeGridClickPosition(
  bounds: Rectangle,
  posX: number,
  posY: number,
): { x: number; y: number } {
  const x =
    posX >= bounds.x && posX <= bounds.x + bounds.width
      ? posX - bounds.x
      : posX;
  const y =
    posY >= bounds.y && posY <= bounds.y + bounds.height
      ? posY - bounds.y
      : posY;
  return { x, y };
}
