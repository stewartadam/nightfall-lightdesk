// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import noUiSlider, { type API } from "nouislider";
import {
  createEffect,
  createMemo,
  For,
  type JSX,
  onCleanup,
  onMount,
  Show,
} from "solid-js";

export interface VerticalRangeSliderProps {
  /** Exposes the slider container for input interception and mapping presentation. */
  ref?: (element: HTMLDivElement) => void;
  /** Current value (0-100 for percentage sliders) */
  value: number;
  /** Called when value changes */
  onChange: (value: number) => void;
  /** Called when user starts dragging */
  onDragStart?: () => void;
  /** Called when user stops dragging */
  onDragEnd?: () => void;
  /** Minimum value */
  min?: number;
  /** Maximum value */
  max?: number;
  /** Step increment */
  step?: number;
  /** Number of ticks to show (default: 11 for 0%, 10%, ..., 100%) */
  tickCount?: number;
  /** Track height in pixels or a CSS size (default: 160px). */
  height?: number | string;

  /** Additional class for container */
  class?: string;
  /** Disable the slider */
  disabled?: boolean;
  /** Accessible name for the keyboard-operable fader handle. */
  ariaLabel?: string;
  /** Optional marker value rendered in the tick column */
  markerValue?: number;
}

/** Renders a controlled vertical fader with ticks, a reference marker, and pointer or keyboard input. */
export function VerticalRangeSlider(
  props: VerticalRangeSliderProps,
): JSX.Element {
  let sliderRef: HTMLDivElement | undefined;
  let sliderApi: API | undefined;
  let isUserInteracting = false;

  /** Resolves the lower bound for the fader. */
  const min = () => props.min ?? 0;

  /** Resolves the upper bound for the fader. */
  const max = () => props.max ?? 100;

  /** Resolves the increment for pointer and keyboard edits. */
  const step = () => props.step ?? 1;

  /** Resolves the number of evenly spaced tick marks. */
  const tickCount = () => props.tickCount ?? 11;

  /** Resolves a CSS track height, allowing the parent to supply available space. */
  const height = () =>
    typeof props.height === "string"
      ? props.height
      : `${props.height ?? 160}px`;
  /** Converts an optional reference value into a bounded track position. */
  const markerPercent = createMemo(() => {
    if (props.markerValue === undefined) return undefined;
    const range = max() - min();
    if (range <= 0) return 0;
    const clampedValue = Math.max(min(), Math.min(max(), props.markerValue));
    return ((clampedValue - min()) / range) * 100;
  });

  /** Generate array of tick count for rendering */
  const getTickArray = (): number[] => {
    return Array.from({ length: tickCount() }, (_, i) => i);
  };

  /** Creates the slider before applying reactive value and disabled-state synchronization. */
  onMount(() => {
    if (!sliderRef) return;

    sliderApi = noUiSlider.create(sliderRef, {
      start: [props.value],
      animate: false,
      connect: "lower",
      orientation: "vertical",
      direction: "rtl", // Makes 0 at bottom, 100 at top
      range: {
        min: min(),
        max: max(),
      },
      step: step(),
      handleAttributes: [{ "aria-label": props.ariaLabel ?? "Value" }],
    });

    sliderApi.on("start", () => {
      isUserInteracting = true;
      sliderRef?.classList.add("is-dragging");
      props.onDragStart?.();
    });

    sliderApi.on("end", () => {
      isUserInteracting = false;
      sliderRef?.classList.remove("is-dragging");
      props.onDragEnd?.();
    });

    /** Publishes pointer and keyboard edits; initialization and programmatic sets do not emit slide. */
    sliderApi.on("slide", (_, __, values) => {
      const newValue = values[0];
      if (newValue !== props.value) {
        props.onChange(newValue);
      }
    });

    /** Mirrors external values without echoing updates or disrupting an active drag. */
    createEffect(() => {
      const currentValue = props.value;
      if (!sliderApi || isUserInteracting) return;
      sliderApi.set([currentValue], false);
    });

    /** Applies disabled state after the slider exists, including on initial mount. */
    createEffect(() => {
      if (props.disabled) sliderApi?.disable();
      else sliderApi?.enable();
    });
  });

  /** Releases the generated handles and pointer listeners. */
  onCleanup(() => sliderApi?.destroy());

  return (
    <div
      ref={props.ref}
      class={`vertical-range-slider-container ${props.class ?? ""}`}
      style={{ height: height() }}
    >
      <div
        ref={sliderRef}
        class="vertical-range-slider"
        classList={{ "is-disabled": !!props.disabled }}
      />
      <div class="vertical-slider-ticks">
        <For each={getTickArray()}>
          {() => (
            <div class="vertical-slider-tick">
              <div class="vertical-slider-tick-mark" />
            </div>
          )}
        </For>
        <Show when={markerPercent() !== undefined}>
          <div
            class="vertical-slider-value-marker"
            style={{ bottom: `calc(${markerPercent() ?? 0}% - 1px)` }}
          />
        </Show>
      </div>
    </div>
  );
}
