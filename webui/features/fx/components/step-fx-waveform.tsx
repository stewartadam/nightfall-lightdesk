// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { WarningIcon } from "@squidlab/phosphor-solid/warning";
import {
  createMemo,
  createSignal,
  For,
  type JSX,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import Tooltip from "../../../components/ui/tooltip";
import { createStepFxWaveformDrag } from "../controllers/step-fx-waveform-drag";
import { createStepFxWaveformPreview } from "../controllers/step-fx-waveform-preview";
import { buildStepFxWaveformModel } from "../model/step-fx-waveform-model";
import {
  formatWaveformScaleValue,
  PLOT_INSET_PERCENT,
  stepDividerLabelSegments,
  waveformScaleLabelStyle,
} from "../model/step-fx-waveform-plot";
import type { StepFxWaveformProps } from "../model/step-fx-waveform-types";
import { StepFxWaveformCycle } from "./step-fx-waveform-cycle";

export type {
  StepFxWaveformDragTarget,
  StepFxWaveformProps,
  StepFxWaveformSelectionModifiers,
} from "../model/step-fx-waveform-types";

/** Coordinates waveform editing and preview within the responsive plot layout. */
export function StepFxWaveform(props: StepFxWaveformProps) {
  /** Rebuilds validated geometry whenever the local draft track changes. */
  const model = createMemo(() => buildStepFxWaveformModel(props.track));
  const [plotWidthPx, setPlotWidthPx] = createSignal(0);
  let plotElement: HTMLDivElement | undefined;
  let plotResizeObserver: ResizeObserver | undefined;
  const drag = createStepFxWaveformDrag(props);
  const preview = createStepFxWaveformPreview(props, model, plotWidthPx);
  /** Renders an accessible sampling warning for each toolbar location. */
  const samplingWarning = (): JSX.Element => (
    <Show when={preview.samplingWarningMessage()}>
      {(message) => (
        <Tooltip content={() => message()} position="bottom">
          <span
            class="inline-flex size-5 shrink-0 items-center justify-center rounded text-amber-300 outline-none focus-visible:ring-1 focus-visible:ring-amber-300"
            role="img"
            aria-label={message()}
            tabindex="0"
            data-step-fx-playhead-sampling-warning
          >
            <WarningIcon class="size-4" weight="fill" aria-hidden />
          </span>
        </Tooltip>
      )}
    </Show>
  );

  /** Retains only divider labels that fit without colliding at the current plot width. */
  const visibleDividerSegments = createMemo(() => {
    const waveform = model();
    return waveform ? stepDividerLabelSegments(waveform, plotWidthPx()) : [];
  });

  /** Tracks responsive plot width so Show all cannot overcrowd the waveform. */
  onMount(() => {
    if (!plotElement) return;
    plotResizeObserver = new ResizeObserver((entries) => {
      const width =
        entries[0]?.contentRect.width ?? plotElement?.clientWidth ?? 0;
      setPlotWidthPx(width);
    });
    plotResizeObserver.observe(plotElement);
    setPlotWidthPx(plotElement.clientWidth);
  });

  /** Disconnects measurement when the plot leaves its owner. */
  onCleanup(() => plotResizeObserver?.disconnect());

  return (
    <section
      class="flex size-full min-h-0 flex-col overflow-auto bg-neutral-950/50 px-3 py-2"
      data-step-fx-waveform
      role="group"
      aria-label="Step ramp waveform"
    >
      <Show
        when={model()}
        fallback={
          <div class="flex h-28 items-center justify-center text-xs text-neutral-500">
            Waveform unavailable while the track contains invalid values.
          </div>
        }
      >
        {(waveform) => (
          <>
            <div class="mb-1 flex min-h-7 min-w-0 items-center gap-2 text-[11px] text-neutral-400">
              <span class="font-medium uppercase tracking-wide text-neutral-300">
                Waveform
              </span>
              <div class="ml-auto min-w-0 overflow-x-auto">
                {props.titleControls?.(samplingWarning())}
              </div>
            </div>
            <div
              ref={plotElement}
              class="relative min-h-28 flex-1 overflow-hidden rounded border border-neutral-800 bg-neutral-950"
              data-step-fx-waveform-plot
              data-scroll-mode={
                props.centerSelectedFixture ? "waveform" : "fixtures"
              }
              data-mode-transitioning={preview.centerModeTransitioning()}
              data-direction-transitioning={preview.directionTransitioning()}
              data-drag-editing-disabled={drag.dragEditingDisabled()}
              data-dragging={drag.activeDragTarget() ? "true" : undefined}
            >
              <For each={preview.waveformCycleOffsets()}>
                {(cycleOffset) => (
                  <StepFxWaveformCycle
                    waveform={waveform()}
                    cycleOffset={cycleOffset}
                    plotWidthPx={plotWidthPx()}
                    visibleDividerSegments={visibleDividerSegments()}
                    preview={preview}
                    drag={drag}
                    centerSelectedFixture={props.centerSelectedFixture}
                    direction={props.direction}
                    positionUnit={props.positionUnit}
                    selectedStepUids={props.selectedStepUids}
                    onStepSelect={props.onStepSelect}
                  />
                )}
              </For>

              <Show when={drag.dragLabel()}>
                {(label) => (
                  <span
                    class="pointer-events-none absolute z-[70] -translate-x-1/2 -translate-y-[calc(100%+0.5rem)] whitespace-nowrap rounded border border-amber-300/60 bg-neutral-950/95 px-2 py-1 text-[11px] font-medium tabular-nums text-amber-100 shadow-lg"
                    style={{ left: label().left, top: label().top }}
                    role="status"
                    data-step-fx-waveform-drag-label
                  >
                    {label().text}
                  </span>
                )}
              </Show>

              <span
                class="pointer-events-none absolute z-[60] -translate-y-1/2 pr-1 text-right text-[10px] text-neutral-500"
                style={waveformScaleLabelStyle(
                  waveform(),
                  waveform().scaleMaximumValue,
                )}
                data-step-fx-waveform-scale-max
              >
                {formatWaveformScaleValue(
                  waveform(),
                  waveform().scaleMaximumValue,
                )}
              </span>
              <span
                class="pointer-events-none absolute z-[60] -translate-y-1/2 pr-1 text-right text-[10px] text-neutral-500"
                style={waveformScaleLabelStyle(
                  waveform(),
                  waveform().scaleMinimumValue,
                )}
                data-step-fx-waveform-scale-min
              >
                {formatWaveformScaleValue(
                  waveform(),
                  waveform().scaleMinimumValue,
                )}
              </span>
              <div
                class="pointer-events-none absolute inset-y-0 left-0 z-50 bg-neutral-950"
                style={{ width: `${PLOT_INSET_PERCENT}%` }}
                aria-hidden="true"
                data-step-fx-waveform-gutter="left"
              />
              <div
                class="pointer-events-none absolute inset-y-0 right-0 z-50 bg-neutral-950"
                style={{ width: `${PLOT_INSET_PERCENT}%` }}
                aria-hidden="true"
                data-step-fx-waveform-gutter="right"
              />
            </div>
          </>
        )}
      </Show>
    </section>
  );
}
