// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { JSX } from "solid-js";
import { RangeSlider } from "../ui/range-slider";

export type AttributeMode = "absolute" | "relative";

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
      class={`attribute-slider flex items-center gap-3 ${props.class ?? ""}`.trim()}
    >
      <div class="w-28">
        <div class="text-xs font-medium text-neutral-300">{props.label}</div>
        <div
          class="mt-1 inline-flex rounded-md text-[10px] border border-neutral-600 overflow-hidden"
          role="group"
          aria-label={`${props.label} mode`}
        >
          <button
            type="button"
            aria-pressed={props.mode === "absolute"}
            class={`px-2 py-0.5 ${props.mode === "absolute" ? "bg-blue-600 text-white" : "bg-neutral-800 text-neutral-300"}`}
            onClick={() => updateMode("absolute")}
          >
            Abs
          </button>
          <button
            type="button"
            aria-pressed={props.mode === "relative"}
            class={`px-2 py-0.5 ${props.mode === "relative" ? "bg-blue-600 text-white" : "bg-neutral-800 text-neutral-300"}`}
            onClick={() => updateMode("relative")}
          >
            Rel
          </button>
        </div>
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
