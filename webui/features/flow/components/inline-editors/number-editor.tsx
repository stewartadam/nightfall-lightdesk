// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Input } from "../../../../components/ui/form-controls";
/**
 * Number editor components for flow nodes.
 * Includes a standard input, a knob for BPM-style values, and a slider for normalized 0..1 values.
 */

import { createMemo, Show } from "solid-js";
import type { FlowPortDefinition } from "../../../../types/index";

const KNOB_MAX_BPM = 300;
const KNOB_MIN_BPM = 30;

/** Port names that represent normalized 0..1 values */
const NORMALIZED_PORT_NAMES = new Set([
  "amplitude",
  "phase",
  "base",
  "duty cycle",
  "duty",
]);

interface KnobProps {
  value: number;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}

/**
 * Rotary knob control for numeric values.
 */
function Knob(props: KnobProps) {
  const angle = createMemo(
    () => ((props.value - props.min) / (props.max - props.min)) * 270 - 135,
  );

  return (
    <div class="flex flex-col items-center gap-1">
      <div class="relative h-10 w-10 rounded-full border border-neutral-700 bg-neutral-950">
        <div class="absolute inset-0 flex items-center justify-center">
          <div
            class="h-4 w-0.5 origin-bottom rounded-full bg-blue-400"
            style={{ transform: `rotate(${angle()}deg) translateY(-4px)` }}
          />
        </div>
      </div>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onInput={(e) =>
          props.onChange(Number.parseFloat(e.currentTarget.value))
        }
        onPointerDown={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        disabled={props.disabled}
        class="w-full nodrag"
      />
    </div>
  );
}

interface SliderProps {
  value: number;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  /** Called on every input event during drag (for optimistic UI updates) */
  onInput: (value: number) => void;
  /** Called on change event (mouse release) for immediate commit */
  onCommit: (value: number) => void;
}

/**
 * Slider control for normalized 0..1 values with inline value display.
 * Calls onInput during drag for visual feedback, onCommit on release for persistence.
 * Debouncing is handled by the parent PortValueContext provider.
 */
function Slider(props: SliderProps) {
  const percentage = createMemo(
    () => ((props.value - props.min) / (props.max - props.min)) * 100,
  );

  return (
    <div class="flex w-[140px] items-center gap-2">
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onInput={(e) => props.onInput(Number.parseFloat(e.currentTarget.value))}
        onChange={(e) =>
          props.onCommit(Number.parseFloat(e.currentTarget.value))
        }
        onPointerDown={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        disabled={props.disabled}
        class="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-neutral-700 nodrag [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-sky-400"
        style={{
          background: `linear-gradient(to right, rgb(56 189 248) 0%, rgb(56 189 248) ${percentage()}%, rgb(64 64 64) ${percentage()}%, rgb(64 64 64) 100%)`,
        }}
      />
      <span class="w-8 text-right text-[10px] text-neutral-400">
        {props.value.toFixed(2)}
      </span>
    </div>
  );
}

/**
 * Check if a port name represents a normalized 0..1 value.
 */
function isNormalizedPort(portName: string): boolean {
  return NORMALIZED_PORT_NAMES.has(portName.toLowerCase());
}

export interface NumberEditorProps {
  value: number;
  port: FlowPortDefinition;
  disabled?: boolean;
  /** Called on input for optimistic UI updates (optional, used with PortValueContext) */
  onInput?: (value: number) => void;
  /** Called to commit the final value */
  onCommit: (value: number) => void;
}

/**
 * Number editor that switches between input, knob, or slider based on port name.
 * Uses a knob for BPM-related ports and a slider for normalized 0..1 ports.
 *
 * When `onInput` is provided (via PortValueContext), the component uses props.value
 * directly for display (optimistic updates handled externally). Otherwise, it
 * maintains local state for smooth UI during editing.
 */
export function NumberEditor(props: NumberEditorProps) {
  const isBpm = createMemo(() =>
    (props.port.name ?? "").toLowerCase().includes("bpm"),
  );
  const isNormalized = createMemo(() =>
    isNormalizedPort(props.port.name ?? ""),
  );

  // When onInput is provided, value comes from context (optimistic updates)
  /** Otherwise, we maintain local state for smooth editing */
  const hasExternalState = () => props.onInput !== undefined;

  const handleInput = (value: number) => {
    if (props.onInput) {
      props.onInput(value);
    }
  };

  const handleCommit = (value: number) => {
    props.onCommit(value);
  };

  return (
    <div class="flex flex-col gap-1">
      <Show when={isBpm()}>
        <Knob
          value={props.value}
          min={KNOB_MIN_BPM}
          max={KNOB_MAX_BPM}
          step={1}
          disabled={props.disabled}
          onChange={handleCommit}
        />
      </Show>
      <Show when={isNormalized() && !isBpm()}>
        <Slider
          value={props.value}
          min={0}
          max={1}
          step={0.01}
          disabled={props.disabled}
          onInput={hasExternalState() ? handleInput : () => {}}
          onCommit={handleCommit}
        />
      </Show>
      <Show when={!isBpm() && !isNormalized()}>
        <Input
          density="compact"
          type="number"
          value={props.value}
          onInput={(e) => {
            const val = Number(e.currentTarget.value);
            handleInput(val);
            if (!hasExternalState()) {
              handleCommit(val);
            }
          }}
          onChange={(e) => handleCommit(Number(e.currentTarget.value))}
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          disabled={props.disabled}
          class="w-[140px] nodrag"
        />
      </Show>
    </div>
  );
}
