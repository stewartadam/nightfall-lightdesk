// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createSignal, For, onCleanup } from "solid-js";
import { playContentEntrance } from "../components/ui/content-entrance";
import { NativeSelect } from "../components/ui/form-controls";
import { RangeSlider } from "../components/ui/range-slider";
import { Button } from "../components/ui/visual-language/button";
import "./animations-demo.css";

const presets = [
  { label: "Sweep from left", direction: "left" },
  { label: "Sweep from right", direction: "right" },
  { label: "Sweep from top", direction: "top" },
  { label: "Sweep from bottom", direction: "bottom" },
  { label: "Fade in", direction: "fade" },
  { label: "Zoom in", direction: "zoom" },
] as const;

/** Previews replayable content entrances without moving the panel or its controls. */
export function AnimationsDemo() {
  let content!: HTMLDivElement;
  let cancelEntrance: (() => void) | undefined;
  const [duration, setDuration] = createSignal(600);
  const [delay, setDelay] = createSignal(0);
  const [distance, setDistance] = createSignal(100);
  const [opacity, setOpacity] = createSignal(0);
  const [scale, setScale] = createSignal(80);
  const [easing, setEasing] = createSignal("cubic-bezier(0.22, 1, 0.36, 1)");
  const [status, setStatus] = createSignal("Choose an animation to preview.");

  /** Replaces an in-flight entrance and preserves visible content when motion is reduced. */
  function play(preset: (typeof presets)[number]) {
    cancelEntrance?.();
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setStatus(
        `${preset.label} · Reduced motion: preview shown without animation.`,
      );
      return;
    }
    setStatus(`${preset.label} · Playing`);
    cancelEntrance = playContentEntrance(content, {
      direction: preset.direction,
      duration: duration(),
      delay: delay(),
      distance: distance(),
      opacity: opacity() / 100,
      scale: scale() / 100,
      easing: easing(),
      onComplete: () => setStatus(`${preset.label} · Complete`),
    });
  }

  onCleanup(() => cancelEntrance?.());

  return (
    <section class="properties lab-panel" aria-label="Animation examples">
      <div class="eyebrow">ANIMATIONS</div>
      <h2>Bring content into view.</h2>
      <p class="field-help">
        Replay an entrance below. Sweeps start from the named edge and follow
        your reduced-motion preference. Adjust the duration before replaying.
      </p>
      <div class="lab-animation-parameters">
        <For
          each={[
            {
              label: "Animation duration",
              value: duration,
              change: setDuration,
              min: 100,
              max: 2000,
              step: 50,
              suffix: " ms",
            },
            {
              label: "Animation delay",
              value: delay,
              change: setDelay,
              min: 0,
              max: 1000,
              step: 50,
              suffix: " ms",
            },
            {
              label: "Slide distance",
              value: distance,
              change: setDistance,
              min: 0,
              max: 100,
              step: 5,
              suffix: "%",
            },
            {
              label: "Starting opacity",
              value: opacity,
              change: setOpacity,
              min: 0,
              max: 100,
              step: 5,
              suffix: "%",
            },
            {
              label: "Starting zoom",
              value: scale,
              change: setScale,
              min: 10,
              max: 150,
              step: 5,
              suffix: "%",
            },
          ]}
        >
          {(parameter) => (
            <div class="lab-animation-parameter">
              <span class="field-help">{parameter.label}</span>
              <RangeSlider
                value={parameter.value()}
                onChange={parameter.change}
                min={parameter.min}
                max={parameter.max}
                step={parameter.step}
                suffix={parameter.suffix}
                ariaLabel={parameter.label}
                showPips={false}
                tooltips={false}
                containerClass=""
              />
            </div>
          )}
        </For>
        <label class="lab-animation-parameter">
          <span class="field-help">Easing</span>
          <NativeSelect
            aria-label="Easing"
            value={easing()}
            onChange={(event) => setEasing(event.currentTarget.value)}
          >
            <option value="cubic-bezier(0.22, 1, 0.36, 1)">
              Smooth entrance
            </option>
            <option value="linear">Linear</option>
            <option value="ease-in">Ease in</option>
            <option value="ease-out">Ease out</option>
            <option value="ease-in-out">Ease in and out</option>
          </NativeSelect>
        </label>
      </div>
      <p class="field-help">
        Distance applies to sweeps; starting zoom applies to Zoom in. Changes
        apply on replay.
      </p>
      <div
        class="lab-animation-controls"
        role="group"
        aria-label="Content animations"
      >
        <For each={presets}>
          {(preset) => (
            <Button onClick={() => play(preset)}>{preset.label}</Button>
          )}
        </For>
      </div>
      <div class="lab-animation-stage">
        <div
          ref={content}
          class="lab-animation-content"
          data-testid="animation-content"
        >
          <div class="eyebrow">CONTENT PREVIEW</div>
          <h3>Evening wash</h3>
          <p class="field-help">
            A soft wash across the stage, ready for the next cue.
          </p>
          <div class="lab-animation-details">
            <span>12 fixtures</span>
            <span>Stage left</span>
            <span>75% intensity</span>
          </div>
        </div>
      </div>
      <p class="field-help" role="status">
        {status()}
      </p>
    </section>
  );
}
