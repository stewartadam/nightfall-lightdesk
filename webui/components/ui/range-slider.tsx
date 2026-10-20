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
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import "./range-slider.css";

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
  /** Id of an element that describes the control, applied to handles and numeric inputs. */
  describedBy?: string;
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
  /**
   * Values a dragged handle settles on when released near them, marked under the track.
   * Keys and numeric entry still reach every value in between.
   */
  detents?: readonly number[];
}

/** Share of the slider's range within which a dragged handle settles on a detent. */
const DETENT_RADIUS = 0.03;

export type RangeSliderProps = RangeSliderOptions &
  (
    | {
        mode?: "single";
        value: number;
        /** Receives every edit, including each step of a drag. */
        onChange: (value: number) => void;
        /** Receives the settled value when a drag ends or a key, tap or numeric entry completes. */
        onCommit?: (value: number) => void;
      }
    | {
        mode: "range";
        value: readonly [number, number];
        onChange: (value: [number, number]) => void;
        onCommit?: (value: [number, number]) => void;
      }
  );

/** Shares noUiSlider handles, keyboard interaction, and numeric inputs across scalar and bounded-range controls. */
export function RangeSlider(props: RangeSliderProps): JSX.Element {
  let containerRef!: HTMLDivElement;
  let sliderApi: API | undefined;
  let syncing = false;
  let dragging = false;
  /** Handle values as of the last commit or external update, used to skip commits that change nothing. */
  let committed: number[] = [];
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
  /** Reads the slider's settled handle values, rounded like emitted changes. */
  const settledValues = () => {
    const raw = sliderApi?.get(true) ?? values();
    return (Array.isArray(raw) ? raw : [raw]).map((value) =>
      Number(Number(value).toFixed(10)),
    );
  };
  /** Moves each value within the detent radius of a detent onto it. */
  const snapToDetents = (next: number[]) => {
    const detents = props.detents;
    if (!detents?.length) return next;
    const radius = (max() - min()) * DETENT_RADIUS;
    return next.map((value) => {
      const nearest = detents.reduce((best, detent) =>
        Math.abs(detent - value) < Math.abs(best - value) ? detent : best,
      );
      return Math.abs(nearest - value) <= radius ? nearest : value;
    });
  };
  /** Reports a completed interaction to the optional commit callback unless it left the values unchanged. */
  const emitCommit = () => {
    const next = settledValues();
    if (next.every((value, index) => value === committed[index])) return;
    committed = next;
    if (props.mode === "range") props.onCommit?.([next[0], next[1]]);
    else props.onCommit?.(next[0]);
  };
  /** Commits numeric input through the slider's step, bounds, and handle-order constraints. */
  const commitInput = (index: number, input: HTMLInputElement) => {
    const value = input.valueAsNumber;
    if (Number.isFinite(value)) {
      sliderApi?.setHandle(index, value, true);
      emitCommit();
    }
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
      ariaFormat: { to: formatValue },
      handleAttributes: values().map((_, index) => ({
        "aria-label": label(index),
        ...(props.describedBy ? { "aria-describedby": props.describedBy } : {}),
      })),
      pips: props.detents?.length
        ? {
            mode: PipsMode.Values,
            values: [...props.detents],
            density: 100,
            format: { to: formatValue },
          }
        : props.showPips === false
          ? undefined
          : {
              mode: PipsMode.Count,
              values: Math.max(2, props.pipCount ?? 5),
              density: 100,
              format: { to: formatValue },
            },
    });
    sliderApi.on("start", () => {
      dragging = true;
      containerRef.classList.add("is-dragging");
    });
    sliderApi.on("end", () => {
      dragging = false;
      containerRef.classList.remove("is-dragging");
    });
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
    sliderApi.on("change", () => {
      if (syncing) return;
      const settled = settledValues();
      // Only a released pointer drag settles; keys, taps and typed values land exactly.
      const snapped = dragging ? snapToDetents(settled) : settled;
      if (snapped.some((value, index) => value !== settled[index])) {
        syncing = true;
        sliderApi?.set(snapped, false);
        syncing = false;
      }
      emitCommit();
    });
    committed = settledValues();
    /** Mirrors controlled values, leaving an active drag in place so delayed echoes cannot pull the handle back. */
    createEffect(() => {
      const next = values();
      if (dragging) return;
      const current = settledValues();
      syncing = true;
      sliderApi?.set(next, false);
      syncing = false;
      // An echo of the slider's own edit is not an external change to commit against.
      if (next.some((value, index) => value !== current[index]))
        committed = settledValues();
    });
    /** Rebuilds the scale when bounds or step change, such as when a mode switch widens the range. */
    createEffect(
      on(
        [min, max, step],
        ([nextMin, nextMax, nextStep]) => {
          syncing = true;
          sliderApi?.updateOptions(
            { range: { min: nextMin, max: nextMax }, step: nextStep },
            false,
          );
          sliderApi?.set(values(), false);
          syncing = false;
        },
        { defer: true },
      ),
    );
    /** Keeps handle names current when a mounted slider's labels change, such as after its row moves. */
    createEffect(() => {
      containerRef
        .querySelectorAll<HTMLElement>(".noUi-handle")
        .forEach((handle, index) => {
          handle.setAttribute("aria-label", label(index));
          if (props.describedBy)
            handle.setAttribute("aria-describedby", props.describedBy);
          else handle.removeAttribute("aria-describedby");
        });
    });
    /** Applies disabled state after the library instance exists and exposes it on each handle. */
    createEffect(() => {
      if (props.disabled) sliderApi?.disable();
      else sliderApi?.enable();
      containerRef.classList.toggle("is-disabled", !!props.disabled);
      containerRef
        .querySelectorAll<HTMLElement>(".noUi-handle")
        .forEach((handle) => {
          handle.setAttribute("aria-disabled", String(!!props.disabled));
        });
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
        <div class="range-slider-inputs shrink-0 flex gap-2">
          <For each={props.mode === "range" ? [0, 1] : [0]}>
            {(index) => (
              <label class="nf-input-group range-slider-field flex items-stretch overflow-hidden rounded-md border">
                <input
                  type="number"
                  aria-label={label(index)}
                  aria-describedby={props.describedBy}
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
                  class="border-0 bg-transparent px-2 py-1 text-right text-xs focus:outline-none disabled:cursor-not-allowed"
                />
                <Show when={suffix()}>
                  <span class="inline-flex items-center border-l px-2 text-xs">
                    {suffix()}
                  </span>
                </Show>
              </label>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
