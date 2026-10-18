// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { JSX } from "solid-js";
import { RangeSlider } from "../ui/range-slider";
import {
  SegmentedControl,
  type SegmentedControlOption,
} from "../ui/segmented-control";

export type AttributeMode = "absolute" | "relative";

const MODE_OPTIONS: readonly SegmentedControlOption<AttributeMode>[] = [
  { value: "absolute", label: "Abs", tooltip: "Absolute value" },
  { value: "relative", label: "Rel", tooltip: "Relative adjustment" },
];

export interface AttributeSliderProps {
  label: string;
  mode: AttributeMode;
  value: number;
  min: number;
  max: number;
  step?: number;
  onModeChange: (mode: AttributeMode) => void;
  onValueChange: (value: number) => void;
  onCommit?: (value: number) => void;
  class?: string;
}

/** Keeps committed attribute values inside the active mode's bounds. */
const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

/** Combines absolute/relative mode selection with the shared slider and its numeric entry, committing on release. */
export default function AttributeSlider(
  props: AttributeSliderProps,
): JSX.Element {
  /** Resolves the increment for both input controls. */
  const step = () => props.step ?? 1;
  /** Publishes bounded edits and optionally signals a completed interaction. */
  const updateValue = (raw: number, commit = false) => {
    if (Number.isNaN(raw)) return;
    const clamped = clamp(raw, props.min, props.max);
    props.onValueChange(clamped);
    if (commit) props.onCommit?.(clamped);
  };

  /** Changes interpretation and clamps the value against the resulting bounds. */
  const updateMode = (nextMode: AttributeMode) => {
    props.onModeChange(nextMode);
    props.onValueChange(clamp(props.value, props.min, props.max));
  };

  return (
    <div
      class={`flex flex-wrap items-center gap-3 ${props.class ?? ""}`.trim()}
    >
      <div class="w-28">
        <div class="text-xs font-medium text-neutral-300">{props.label}</div>
        <SegmentedControl
          class="mt-1"
          label={`${props.label} mode`}
          density="compact"
          options={MODE_OPTIONS}
          value={props.mode}
          onChange={updateMode}
        />
      </div>

      <RangeSlider
        value={props.value}
        min={props.min}
        max={props.max}
        step={step()}
        ariaLabel={props.label}
        suffix=""
        showPips={false}
        containerClass="min-w-0 flex-1"
        onChange={(value) => updateValue(value)}
        onCommit={(value) => updateValue(value, true)}
      />
    </div>
  );
}
