// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createSignal, For } from "solid-js";
import { Sparkline } from "../components/ui/sparkline";
import Tooltip from "../components/ui/tooltip";
import { Button } from "../components/ui/visual-language/button";
import "./widget-demos.css";

const trends = [
  {
    label: "Frame time",
    detail: "Variable · 4–12 ms",
    data: [5, 6, 4, 8, 7, 12, 9, 6, 5, 7, 6, 4],
  },
  {
    label: "Output rate",
    detail: "Flat · 40 Hz",
    data: [40, 40, 40, 40, 40, 40],
  },
  { label: "New metric", detail: "One sample · 8 ms", data: [8] },
  { label: "No samples", detail: "Waiting for data", data: [] },
];

/** Compares varying, flat, single-sample, and empty metric histories without a live polling loop. */
export function SparklineDemo() {
  return (
    <section class="properties lab-panel" aria-label="Sparkline examples">
      <div class="eyebrow">SPARKLINES</div>
      <h2>Small trends, useful context.</h2>
      <For each={trends}>
        {(trend) => (
          <div class="widget-metric-row" role="group" aria-label={trend.label}>
            <div>
              <div>{trend.label}</div>
              <p class="field-help">{trend.detail}</p>
            </div>
            <Sparkline
              data={trend.data}
              width={140}
              height={32}
              color="var(--accent)"
            />
          </div>
        )}
      </For>
      <p class="field-help">
        Each trend scales to its own range. Fewer than two samples leaves the
        chart blank.
      </p>
    </section>
  );
}

/** Demonstrates tooltip placement, wrapped guidance, focus activation, and interactive reactive content. */
export function TooltipDemo() {
  const [count, setCount] = createSignal(0);
  return (
    <section class="properties lab-panel" aria-label="Tooltip examples">
      <div class="eyebrow">TOOLTIPS</div>
      <h2>Details on demand.</h2>
      <p class="field-help">
        Hover for a moment or focus a button to reveal its hint.
      </p>
      <div class="widget-tooltip-placements">
        <For each={["top", "bottom", "left", "right"] as const}>
          {(position) => (
            <Tooltip
              position={position}
              content={() => `${position} placement`}
            >
              <Button>{position}</Button>
            </Tooltip>
          )}
        </For>
      </div>
      <div class="property-section button-samples">
        <Tooltip
          content={() => (
            <span class="widget-tooltip-copy">
              Keep the output level below the reference marker while preparing
              the next cue. This longer hint wraps to fit a narrow panel.
            </span>
          )}
        >
          <Button>Long hint</Button>
        </Tooltip>
        <Tooltip
          interactive
          position="bottom"
          content={() => (
            <span class="widget-tooltip-actions">
              <span>Preview count: {count()}</span>
              <Button onClick={() => setCount(count() + 1)}>Increment</Button>
            </span>
          )}
        >
          <Button>Interactive hint</Button>
        </Tooltip>
      </div>
      <p class="field-help" role="status">
        Preview count: {count()}
      </p>
    </section>
  );
}
