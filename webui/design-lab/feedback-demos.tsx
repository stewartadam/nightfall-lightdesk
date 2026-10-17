// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { MagnifyingGlassIcon } from "@squidlab/phosphor-solid/magnifying-glass";
import { SparkleIcon } from "@squidlab/phosphor-solid/sparkle";
import { createSignal, ErrorBoundary, For, Show } from "solid-js";
import { Alert } from "../components/ui/alert";
import { EmptyState } from "../components/ui/empty-state";
import { ErrorFallback } from "../components/ui/error-fallback";
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

/** Sample panel content that throws while rendering whenever `failing` is set, to trip its boundary. */
function FragileSample(props: { failing: boolean }) {
  /** Reads the fault flag reactively so toggling it throws inside the boundary's render scope. */
  const content = () => {
    if (props.failing) {
      throw new TypeError(
        "Cannot read properties of undefined (reading 'cues')",
      );
    }
    return "Sample panel content rendered normally.";
  };
  return <p class="widget-fallback-sample">{content()}</p>;
}

/** Wraps sample content in the production `ErrorFallback` boundary; Retry clears the simulated fault. */
export function ErrorFallbackDemo() {
  const [failing, setFailing] = createSignal(false);
  const [reports, setReports] = createSignal(0);
  return (
    <section class="properties lab-panel" aria-label="Error fallback examples">
      <div class="eyebrow">ERROR FALLBACK</div>
      <h2>Contain a failure to its panel.</h2>
      <div class="widget-alert-actions">
        <Button variant="danger" onClick={() => setFailing(true)}>
          Throw render error
        </Button>
      </div>
      <div class="widget-fallback-frame">
        <ErrorBoundary
          fallback={(error, reset) => (
            <ErrorFallback
              title="Sample panel failed to render"
              error={error}
              reset={() => {
                setFailing(false);
                reset();
              }}
              actions={
                <Button
                  size="compact"
                  onClick={() => setReports(reports() + 1)}
                >
                  Report Bug
                </Button>
              }
            />
          )}
        >
          <FragileSample failing={failing()} />
        </ErrorBoundary>
      </div>
      <Show when={reports() > 0}>
        <p class="widget-fallback-sample">Bug reports opened: {reports()}</p>
      </Show>
    </section>
  );
}

/** Shows every inline alert kind, density and border, plus toggled transitions and a timed flash. */
export function AlertDemo() {
  const [shown, setShown] = createSignal(true);
  const [saves, setSaves] = createSignal(0);
  return (
    <section class="properties lab-panel" aria-label="Alert examples">
      <div class="eyebrow">ALERTS</div>
      <h2>Inline callouts, in context.</h2>
      <div class="widget-alert-stack">
        <Alert variant="note" title="Note">
          Fixtures patched to the same universe share one output stream.
        </Alert>
        <Alert variant="tip" title="Tip">
          Hold Shift while dragging a fader for fine adjustments.
        </Alert>
        <Alert variant="important" title="Important">
          Changes to the patch apply to every cue that uses these fixtures.
        </Alert>
        <Alert variant="warning" title="Warning">
          This showfile was saved by a newer version of Nightfall.
        </Alert>
        <Alert variant="caution" title="Caution">
          <p>Deleting this sequence also removes the clips that play it.</p>
          <Button variant="danger" size="compact">
            Delete sequence
          </Button>
        </Alert>
      </div>
      <div class="eyebrow">COMPACT, NO TITLE</div>
      <div class="widget-alert-stack">
        <Alert variant="note" density="compact">
          Untitled alerts align the icon with the first line of text.
        </Alert>
        <Alert variant="warning" density="compact">
          No WebAssembly modules found in this showfile.
        </Alert>
        <Alert variant="caution" density="compact" icon={false}>
          Icons can be hidden when space is tight.
        </Alert>
      </div>
      <div class="eyebrow">BORDERS</div>
      <div class="widget-alert-stack">
        <Alert variant="tip" border="left">
          Left border, the blockquote default.
        </Alert>
        <Alert variant="tip" border="top">
          Top border, like Flowbite's border accent.
        </Alert>
        <Alert variant="tip" border="none">
          No border, tint only.
        </Alert>
      </div>
      <div class="eyebrow">TRANSITIONS AND FLASH</div>
      <div class="widget-alert-actions">
        <Button onClick={() => setShown(!shown())}>
          {shown() ? "Hide" : "Show"} warning
        </Button>
        <Button onClick={() => setSaves(saves() + 1)}>Save</Button>
      </div>
      <div class="widget-alert-stack">
        <Alert variant="warning" transition="slide" show={shown()}>
          Slides in and out over 150 ms when toggled.
        </Alert>
        <Alert variant="tip" role="alert" flash={saves} flashMs={1500}>
          Saved. This confirmation shows for 1.5 s after each save.
        </Alert>
      </div>
    </section>
  );
}

/** Shows each empty-state variant with titles, guidance, icons, an action, and the loading state. */
export function EmptyStateDemo() {
  const [loading, setLoading] = createSignal(true);
  return (
    <section class="properties lab-panel" aria-label="Empty state examples">
      <div class="eyebrow">EMPTY STATES</div>
      <h2>Nothing here, yet.</h2>
      <p class="field-help">
        Panel empty states fill and center in their panel. Inline ones sit in
        lists and inspectors; dashed ones mark placeholder areas.
      </p>
      <div class="eyebrow">PANEL</div>
      <div class="widget-empty-state-frame">
        <EmptyState
          icon={SparkleIcon}
          title="No FX defined"
          description="Use the add button in the toolbar to create your first effect"
          action={
            <Button size="compact" variant="primary">
              Create FX
            </Button>
          }
        />
      </div>
      <div class="eyebrow">INLINE</div>
      <div class="widget-alert-stack">
        <EmptyState
          variant="inline"
          title="Select one clip to edit its source assignment and options."
        />
        <EmptyState
          variant="inline"
          icon={MagnifyingGlassIcon}
          title="No matching fixtures"
        />
      </div>
      <div class="eyebrow">DASHED</div>
      <div class="widget-alert-stack">
        <EmptyState
          variant="dashed"
          title="No active spatial selection."
          description="Select fixtures in the programmer to inspect their resolved grid positions."
        />
        <EmptyState
          variant="dashed"
          density="compact"
          title="No column filters"
        />
      </div>
      <div class="eyebrow">LOADING</div>
      <div class="widget-alert-actions">
        <Button onClick={() => setLoading(!loading())}>
          {loading() ? "Finish loading" : "Reload"}
        </Button>
      </div>
      <div class="widget-alert-stack">
        <Show
          when={loading()}
          fallback={<EmptyState variant="dashed" title="No showfiles found." />}
        >
          <EmptyState variant="dashed" loading title="Loading showfiles..." />
        </Show>
        <EmptyState variant="inline" loading />
      </div>
    </section>
  );
}
