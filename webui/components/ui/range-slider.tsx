// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import noUiSlider, { type API, PipsMode } from "nouislider";
import {
  createEffect,
  For,
  type JSX,
  onCleanup,
  onMount,
  Show,
} from "solid-js";

interface RangeSliderOptions {
  min?: number;
  max?: number;
  step?: number;
  pipCount?: number;
  format?: (value: number) => string;
  suffix?: string;
  class?: string;
  disabled?: boolean;
  ariaLabel?: string;
  /** Accessible names for scalar or ordered interval handles. */
  handleLabels?: string | readonly [string, string];
  /** Additional layout classes for embedding the control. */
  containerClass?: string;
  /** Hides pip marks in compact waveform controls when false. */
  showPips?: boolean;
  /** Hides numeric inputs when the surrounding editor supplies them. */
  showInputs?: boolean;
  /** Enables handle value tooltips unless explicitly disabled. */
  tooltips?: boolean;
}

export type RangeSliderProps = RangeSliderOptions &
  (
    | { mode?: "single"; value: number; onChange: (value: number) => void }
    | {
        mode: "range";
        value: readonly [number, number];
        onChange: (value: [number, number]) => void;
      }
  );

/** Shares noUiSlider handles, keyboard interaction, and numeric inputs across scalar and bounded-range controls. */
export function RangeSlider(props: RangeSliderProps): JSX.Element {
  let containerRef!: HTMLDivElement;
  let sliderApi: API | undefined;
  let syncing = false;
  /** Returns the controlled handle values in noUiSlider order. */
  const values = () =>
    props.mode === "range" ? [...props.value] : [props.value];
  /** Resolves the lower bound for slider and input constraints. */
  const min = () => props.min ?? 0;
  /** Resolves the upper bound for slider and input constraints. */
  const max = () => props.max ?? 100;
  /** Resolves the increment used by dragging, keys, and numeric entry. */
  const step = () => props.step ?? 1;
  /** Resolves the displayed unit. */
  const suffix = () => props.suffix ?? "%";
  /** Produces readable values while retaining fractional steps. */
  const formatValue = (value: number) =>
    props.format?.(value) ?? `${Number(value.toFixed(4))}${suffix()}`;
  /** Names each handle and its matching numeric input for assistive technology. */
  const label = (index: number) =>
    (typeof props.handleLabels === "string"
      ? props.handleLabels
      : props.handleLabels?.[index]) ??
    `${props.ariaLabel ?? "Value"}${props.mode === "range" ? (index === 0 ? " minimum" : " maximum") : ""}`;
  /** Commits numeric input through the slider's step, bounds, and handle-order constraints. */
  const commitInput = (index: number, input: HTMLInputElement) => {
    const value = input.valueAsNumber;
    if (Number.isFinite(value)) sliderApi?.setHandle(index, value, true);
    input.value = String(values()[index]);
  };

  /** Initializes the shared slider and synchronizes externally controlled state after mounting. */
  onMount(() => {
    sliderApi = noUiSlider.create(containerRef, {
      start: values(),
      animate: false,
      connect: props.mode === "range" ? true : [true, false],
      range: { min: min(), max: max() },
      step: step(),
      tooltips: props.tooltips === false ? false : { to: formatValue },
      handleAttributes: values().map((_, index) => ({
        "aria-label": label(index),
      })),
      pips:
        props.showPips === false
          ? undefined
          : {
              mode: PipsMode.Count,
              values: Math.max(2, props.pipCount ?? 5),
              density: 100,
              format: { to: formatValue },
            },
    });
    sliderApi.on("start", () => containerRef.classList.add("is-dragging"));
    sliderApi.on("end", () => containerRef.classList.remove("is-dragging"));
    /** Emits user edits without treating mount-time normalization as an authored change. */
    const emitChange: Parameters<API["on"]>[1] = (_, __, unencoded) => {
      if (syncing) return;
      const next = unencoded.map((value) => Number(value.toFixed(10)));
      if (props.mode === "range") {
        if (next[0] !== props.value[0] || next[1] !== props.value[1])
          props.onChange([next[0], next[1]]);
      } else if (next[0] !== props.value) props.onChange(next[0]);
    };
    sliderApi.on("slide", emitChange);
    sliderApi.on("set", emitChange);
    /** Mirrors controlled values without emitting feedback changes during programmatic updates. */
    createEffect(() => {
      const next = values();
      syncing = true;
      sliderApi?.set(next, false);
      syncing = false;
    });
    /** Applies disabled state after the library instance exists. */
    createEffect(() => {
      if (props.disabled) sliderApi?.disable();
      else sliderApi?.enable();
      containerRef.classList.toggle("is-disabled", !!props.disabled);
    });
  });

  /** Releases the library's pointer listeners and generated handle DOM. */
  onCleanup(() => sliderApi?.destroy());

  return (
    <div
      class={`${props.containerClass ?? "ml-2"} range-slider-container flex items-center gap-3 ${props.mode === "range" ? "range-slider-pair" : ""} ${props.disabled ? "opacity-50 cursor-not-allowed" : ""}`}
    >
      <div
        ref={containerRef}
        class="range-slider flex-1 min-w-0"
        classList={{
          "pointer-events-none": props.disabled,
          [props.class ?? ""]: !!props.class,
        }}
      />
      <Show when={props.showInputs !== false}>
        <div class="range-slider-inputs ml-4 shrink-0 flex gap-2">
          <For each={props.mode === "range" ? [0, 1] : [0]}>
            {(index) => (
              <label
                class={`nf-input-group range-slider-field flex items-stretch overflow-hidden rounded-md border ${props.disabled ? "border-neutral-800 bg-neutral-900" : "border-neutral-700 bg-neutral-800"}`}
              >
                <input
                  type="number"
                  aria-label={label(index)}
                  min={index === 1 ? values()[0] : min()}
                  max={
                    props.mode === "range" && index === 0 ? values()[1] : max()
                  }
                  step={step()}
                  value={values()[index]}
                  onChange={(event) => commitInput(index, event.currentTarget)}
                  onBlur={(event) => {
                    event.currentTarget.value = String(values()[index]);
                  }}
                  disabled={props.disabled}
                  class={`w-12 border-0 bg-transparent px-2 py-1 text-right text-xs focus:outline-none ${props.disabled ? "text-neutral-500 cursor-not-allowed" : "text-neutral-200"}`}
                />
                <span
                  class={`inline-flex items-center border-l px-2 text-xs ${props.disabled ? "border-neutral-800 text-neutral-600" : "border-neutral-700 text-neutral-500"}`}
                >
                  {suffix()}
                </span>
              </label>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
