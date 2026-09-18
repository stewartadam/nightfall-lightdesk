// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createUniqueId, For, Show } from "solid-js";
import { FxDirection } from "../../../types";
import type { createStepFxWaveformDrag } from "../controllers/step-fx-waveform-drag";
import type { StepFxWaveformPreview } from "../controllers/step-fx-waveform-preview";
import {
  type StepFxWaveformModel,
  type StepFxWaveformSegment,
  stepFxWaveformPath,
} from "../model/step-fx-waveform-model";
import {
  boundaryHandleStyle,
  containsZero,
  controlPointStyle,
  formatStepDividerPosition,
  PLOT_HEIGHT,
  PLOT_LEFT,
  PLOT_TOP,
  PLOT_WIDTH,
  phaseMarkerPlotX,
  segmentButtonStyle,
  segmentTitle,
  VIEW_HEIGHT,
  VIEW_WIDTH,
  waveformGraphVerticalBounds,
  waveformPathClipX,
  waveformPlotWidth,
  waveformPlotX,
  waveformPlotY,
} from "../model/step-fx-waveform-plot";
import type { StepFxWaveformProps } from "../model/step-fx-waveform-types";

interface StepFxWaveformCycleProps
  extends Pick<
    StepFxWaveformProps,
    | "centerSelectedFixture"
    | "direction"
    | "positionUnit"
    | "selectedStepUids"
    | "onStepSelect"
  > {
  waveform: StepFxWaveformModel;
  cycleOffset: number;
  plotWidthPx: number;
  visibleDividerSegments: StepFxWaveformSegment[];
  preview: StepFxWaveformPreview;
  drag: Pick<
    ReturnType<typeof createStepFxWaveformDrag>,
    "dragEditingDisabled" | "startWaveformDrag"
  >;
}

/** Draws one authored cycle, its preview annotations, and accessible editing targets. */
export function StepFxWaveformCycle(props: StepFxWaveformCycleProps) {
  const waveformPathClipId = createUniqueId();
  /** Reports whether an authored step is selected in the shared editor state. */
  const isSelected = (stepUid: string): boolean =>
    props.selectedStepUids.has(stepUid);

  /** Reports whether this traversal interval owns the current live sample. */
  const isLive = (segment: StepFxWaveformSegment): boolean =>
    props.preview.previewSample()?.segment.traversalIndex ===
    segment.traversalIndex;

  /** Applies waveform pointer and keyboard selection through the editor's shared policy. */
  const selectSegment = (stepUid: string, event: MouseEvent): void => {
    props.onStepSelect(stepUid, {
      extend: event.shiftKey,
      toggle: event.metaKey || event.ctrlKey,
    });
  };

  return (
    <div
      class="absolute inset-0 will-change-transform"
      style={{
        transform: props.preview.waveformCycleTranslation(
          props.waveform,
          props.cycleOffset,
        ),
        "z-index": props.cycleOffset === 0 ? 1 : 0,
      }}
      aria-hidden={props.cycleOffset === 0 ? undefined : "true"}
      data-step-fx-waveform-cycle={props.cycleOffset}
    >
      <svg
        class="pointer-events-none absolute inset-0 z-10 size-full"
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <defs>
          <clipPath
            id={`${waveformPathClipId}-${props.cycleOffset}`}
            clipPathUnits="userSpaceOnUse"
          >
            <rect
              x={waveformPathClipX(
                props.waveform,
                props.preview.phaseMarkerSample()?.beat,
                props.plotWidthPx,
              )}
              y="0"
              width={
                PLOT_LEFT +
                PLOT_WIDTH -
                waveformPathClipX(
                  props.waveform,
                  props.preview.phaseMarkerSample()?.beat,
                  props.plotWidthPx,
                )
              }
              height={VIEW_HEIGHT}
              data-step-fx-waveform-path-clip={
                props.cycleOffset === 0 ? "" : undefined
              }
            />
          </clipPath>
        </defs>
        <rect
          x={PLOT_LEFT}
          y={waveformGraphVerticalBounds(props.waveform).top}
          width={PLOT_WIDTH}
          height={waveformGraphVerticalBounds(props.waveform).height}
          fill="transparent"
          class="pointer-events-none"
          data-step-fx-waveform-graph-bounds={
            props.cycleOffset === 0 ? "" : undefined
          }
        />
        <For each={[0.25, 0.5, 0.75]}>
          {(ratio) => (
            <line
              x1={PLOT_LEFT}
              y1={
                waveformGraphVerticalBounds(props.waveform).top +
                waveformGraphVerticalBounds(props.waveform).height * ratio
              }
              x2={PLOT_LEFT + PLOT_WIDTH}
              y2={
                waveformGraphVerticalBounds(props.waveform).top +
                waveformGraphVerticalBounds(props.waveform).height * ratio
              }
              stroke="currentColor"
              stroke-width="1"
              stroke-dasharray="4 6"
              class="text-neutral-800"
              vector-effect="non-scaling-stroke"
            />
          )}
        </For>
        <Show when={containsZero(props.waveform)}>
          <line
            x1={PLOT_LEFT}
            y1={waveformPlotY(props.waveform, 0)}
            x2={PLOT_LEFT + PLOT_WIDTH}
            y2={waveformPlotY(props.waveform, 0)}
            stroke="currentColor"
            stroke-width="1"
            class="text-neutral-600"
            vector-effect="non-scaling-stroke"
          />
        </Show>
        <For each={props.waveform.segments}>
          {(segment) => (
            <>
              <rect
                x={waveformPlotX(props.waveform, segment.startBeat)}
                y={waveformGraphVerticalBounds(props.waveform).top}
                width={waveformPlotWidth(
                  props.waveform,
                  segment.transitionStartBeat - segment.startBeat,
                )}
                height={waveformGraphVerticalBounds(props.waveform).height}
                class="fill-neutral-400/5"
                data-step-fx-hold-region={
                  props.cycleOffset === 0 ? "" : undefined
                }
              />
              <rect
                x={waveformPlotX(props.waveform, segment.transitionStartBeat)}
                y={waveformGraphVerticalBounds(props.waveform).top}
                width={waveformPlotWidth(
                  props.waveform,
                  segment.transitionEndBeat - segment.transitionStartBeat,
                )}
                height={waveformGraphVerticalBounds(props.waveform).height}
                class="fill-blue-500/10"
                data-step-fx-transition-region={
                  props.cycleOffset === 0 ? "" : undefined
                }
              />
              <rect
                x={waveformPlotX(props.waveform, segment.transitionEndBeat)}
                y={waveformGraphVerticalBounds(props.waveform).top}
                width={waveformPlotWidth(
                  props.waveform,
                  segment.endBeat - segment.transitionEndBeat,
                )}
                height={waveformGraphVerticalBounds(props.waveform).height}
                class="fill-neutral-400/5"
                data-step-fx-hold-region={
                  props.cycleOffset === 0 ? "" : undefined
                }
              />
            </>
          )}
        </For>
        <Show when={props.preview.previewSample()}>
          {(sample) => (
            <rect
              x={waveformPlotX(props.waveform, sample().segment.startBeat)}
              y={waveformGraphVerticalBounds(props.waveform).top}
              width={waveformPlotWidth(
                props.waveform,
                sample().segment.endBeat - sample().segment.startBeat,
              )}
              height={waveformGraphVerticalBounds(props.waveform).height}
              fill="currentColor"
              stroke="currentColor"
              stroke-width="1.5"
              class="text-amber-300/15"
              vector-effect="non-scaling-stroke"
              data-step-fx-waveform-live-segment={
                props.cycleOffset === 0 ? "" : undefined
              }
            />
          )}
        </Show>
        <For each={props.waveform.segments}>
          {(segment) => (
            <line
              x1={waveformPlotX(props.waveform, segment.startBeat)}
              y1={waveformGraphVerticalBounds(props.waveform).top}
              x2={waveformPlotX(props.waveform, segment.startBeat)}
              y2={waveformGraphVerticalBounds(props.waveform).bottom}
              stroke="currentColor"
              stroke-width="1"
              class="text-neutral-700"
              vector-effect="non-scaling-stroke"
              data-step-fx-waveform-divider={
                props.cycleOffset === 0 ? "" : undefined
              }
            />
          )}
        </For>
        <g
          clip-path={`url(#${waveformPathClipId}-${props.cycleOffset})`}
          data-step-fx-waveform-path-clip-group={
            props.cycleOffset === 0 ? "" : undefined
          }
        >
          <path
            d={stepFxWaveformPath(props.waveform, PLOT_WIDTH, PLOT_HEIGHT)}
            transform={`translate(${PLOT_LEFT} ${PLOT_TOP})`}
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linejoin="round"
            class="text-blue-400"
            vector-effect="non-scaling-stroke"
            data-step-fx-waveform-path={
              props.cycleOffset === 0 ? "" : undefined
            }
          />
        </g>
        <Show
          when={
            props.centerSelectedFixture &&
            props.direction !== FxDirection.Bounce
          }
        >
          <line
            x1={PLOT_LEFT}
            y1={waveformGraphVerticalBounds(props.waveform).top}
            x2={PLOT_LEFT}
            y2={waveformGraphVerticalBounds(props.waveform).bottom}
            stroke="currentColor"
            stroke-width="2"
            class="text-red-500"
            vector-effect="non-scaling-stroke"
            data-step-fx-waveform-cycle-delimiter
          />
        </Show>
        <For each={props.preview.playheadSamplesForCycle(props.cycleOffset)}>
          {(playhead) => (
            <>
              <line
                x1={waveformPlotX(props.waveform, playhead.sample.beat)}
                y1={waveformGraphVerticalBounds(props.waveform).top}
                x2={waveformPlotX(props.waveform, playhead.sample.beat)}
                y2={waveformGraphVerticalBounds(props.waveform).bottom}
                stroke="currentColor"
                stroke-width="1.5"
                class={
                  playhead.selected ? "text-amber-300" : "text-neutral-400"
                }
                vector-effect="non-scaling-stroke"
                data-step-fx-waveform-playhead=""
                data-playhead-cycle-offset={props.cycleOffset}
                data-preview-index={playhead.previewIndex}
                data-selected={playhead.selected}
              />
              <circle
                cx={waveformPlotX(props.waveform, playhead.sample.beat)}
                cy={waveformPlotY(props.waveform, playhead.sample.value)}
                r="4"
                fill="currentColor"
                stroke="rgb(23 23 23)"
                stroke-width="2"
                class={
                  playhead.selected ? "text-amber-300" : "text-neutral-400"
                }
                vector-effect="non-scaling-stroke"
                data-step-fx-waveform-live-value=""
                data-playhead-cycle-offset={props.cycleOffset}
                data-preview-index={playhead.previewIndex}
                data-selected={playhead.selected}
              />
            </>
          )}
        </For>
        <Show
          when={
            props.cycleOffset === props.preview.phaseMarkerCycleOffset()
              ? props.preview.phaseMarkerSample()
              : null
          }
        >
          {(sample) => (
            <>
              <line
                x1={phaseMarkerPlotX(
                  props.waveform,
                  sample().beat,
                  props.plotWidthPx,
                )}
                y1={waveformGraphVerticalBounds(props.waveform).top}
                x2={phaseMarkerPlotX(
                  props.waveform,
                  sample().beat,
                  props.plotWidthPx,
                )}
                y2={waveformGraphVerticalBounds(props.waveform).bottom}
                stroke="currentColor"
                stroke-width="1.5"
                stroke-dasharray="4 3"
                class="text-sky-300"
                vector-effect="non-scaling-stroke"
                data-step-fx-waveform-phase-marker=""
              />
              <circle
                cx={phaseMarkerPlotX(
                  props.waveform,
                  sample().beat,
                  props.plotWidthPx,
                )}
                cy={waveformGraphVerticalBounds(props.waveform).top + 5}
                r="3.5"
                fill="currentColor"
                stroke="rgb(23 23 23)"
                stroke-width="1.5"
                class="text-sky-300"
                vector-effect="non-scaling-stroke"
                data-step-fx-waveform-phase-value=""
              />
            </>
          )}
        </Show>
      </svg>

      <Show when={props.cycleOffset === 0 && props.preview.phaseMarkerSample()}>
        {(sample) => (
          <button
            type="button"
            class="absolute z-[25] w-3 -translate-x-1/2 cursor-ew-resize touch-none rounded border border-transparent bg-transparent p-0 transition-colors hover:border-sky-300 hover:bg-sky-400/20 focus-visible:border-sky-300 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
            style={{
              left: `${(phaseMarkerPlotX(props.waveform, sample().beat, props.plotWidthPx) / VIEW_WIDTH) * 100}%`,
              top: `${(waveformGraphVerticalBounds(props.waveform).top / VIEW_HEIGHT) * 100}%`,
              height: `${(waveformGraphVerticalBounds(props.waveform).height / VIEW_HEIGHT) * 100}%`,
            }}
            aria-label="Move waveform start marker"
            title={
              props.drag.dragEditingDisabled()
                ? "Stop preview or use Fixture scrolling to drag-edit"
                : "Drag start position; Shift-drag to adjust spread"
            }
            disabled={props.drag.dragEditingDisabled()}
            data-step-fx-waveform-start-handle
            onPointerDown={(event) =>
              props.drag.startWaveformDrag(
                event,
                { kind: "start-position" },
                props.waveform,
              )
            }
          />
        )}
      </Show>

      <Show
        when={
          props.cycleOffset === props.preview.phaseMarkerCycleOffset()
            ? props.preview.phaseMarkerSample()
            : null
        }
      >
        {(sample) => (
          <span
            class="pointer-events-none absolute z-20 -translate-x-1/2 rounded-sm border border-sky-400/30 bg-neutral-950/90 px-1.5 py-0.5 text-[10px] font-medium text-sky-200 shadow-sm"
            style={{
              left: `clamp(1.25rem, ${(phaseMarkerPlotX(props.waveform, sample().beat, props.plotWidthPx) / VIEW_WIDTH) * 100}%, calc(100% - 1.25rem))`,
              top: `${((waveformGraphVerticalBounds(props.waveform).top + 10) / VIEW_HEIGHT) * 100}%`,
            }}
            data-step-fx-waveform-phase-label=""
          >
            Start
          </span>
        )}
      </Show>

      <Show when={props.preview.selectedPlayheadForCycle(props.cycleOffset)}>
        {(playhead) => (
          <Show when={playhead().label}>
            {(label) => (
              <span
                class="pointer-events-none absolute z-20 max-w-32 -translate-x-1/2 truncate rounded-sm border border-amber-400/40 bg-neutral-950/90 px-1.5 py-0.5 text-[10px] font-medium text-amber-100 shadow-sm"
                style={{
                  left: `clamp(2.5rem, ${(waveformPlotX(props.waveform, playhead().sample.beat) / VIEW_WIDTH) * 100}%, calc(100% - 2.5rem))`,
                  bottom: `${((VIEW_HEIGHT - waveformGraphVerticalBounds(props.waveform).bottom + 4) / VIEW_HEIGHT) * 100}%`,
                }}
                title={label()}
                data-step-fx-waveform-playhead-label=""
                data-preview-index={playhead().previewIndex}
                data-selected="true"
              >
                {label()}
              </span>
            )}
          </Show>
        )}
      </Show>

      <For each={props.visibleDividerSegments}>
        {(segment) => (
          <span
            class="pointer-events-none absolute z-20 -translate-x-1/2 text-[10px] leading-none text-neutral-500"
            style={{
              left: `${(waveformPlotX(props.waveform, segment.startBeat) / VIEW_WIDTH) * 100}%`,
              top: `${((waveformGraphVerticalBounds(props.waveform).bottom + 2) / VIEW_HEIGHT) * 100}%`,
            }}
            data-step-fx-waveform-divider-label={
              props.cycleOffset === 0 ? "" : undefined
            }
            data-step-index={
              props.cycleOffset === 0 ? segment.stepIndex : undefined
            }
          >
            {formatStepDividerPosition(
              props.waveform,
              segment,
              props.direction,
              props.positionUnit,
            )}
          </span>
        )}
      </For>

      <For each={props.waveform.segments}>
        {(segment) => (
          <button
            type="button"
            class="absolute border-x border-transparent hover:border-blue-400/50 hover:bg-blue-400/5 focus-visible:border-blue-400 focus-visible:outline-none"
            classList={{
              "bg-blue-400/10": isSelected(segment.stepUid),
            }}
            style={segmentButtonStyle(props.waveform, segment)}
            aria-label={
              props.cycleOffset === 0
                ? `Select step ${segment.stepIndex + 1} from waveform`
                : undefined
            }
            aria-pressed={
              props.cycleOffset === 0 ? isSelected(segment.stepUid) : undefined
            }
            aria-current={
              props.cycleOffset === 0 && isLive(segment) ? "step" : undefined
            }
            title={props.cycleOffset === 0 ? segmentTitle(segment) : undefined}
            tabindex={props.cycleOffset === 0 ? undefined : -1}
            data-step-fx-waveform-segment={
              props.cycleOffset === 0 ? "" : undefined
            }
            data-step-index={
              props.cycleOffset === 0 ? segment.stepIndex : undefined
            }
            data-live={
              props.cycleOffset === 0 && isLive(segment) ? "true" : undefined
            }
            onClick={(event) => selectSegment(segment.stepUid, event)}
          />
        )}
      </For>
      <For each={props.waveform.segments.slice(1)}>
        {(trailingSegment, boundaryIndex) => {
          /** Returns the step immediately before this internal boundary. */
          const leadingSegment = () => props.waveform.segments[boundaryIndex()];
          return (
            <Show when={leadingSegment()}>
              {(leading) => (
                <button
                  type="button"
                  class="absolute z-20 w-3 -translate-x-1/2 cursor-ew-resize touch-none rounded border-0 bg-transparent p-0 transition-colors hover:bg-blue-400/20 focus-visible:bg-blue-400/20 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                  style={{
                    ...boundaryHandleStyle(props.waveform, trailingSegment),
                    cursor: props.drag.dragEditingDisabled()
                      ? "not-allowed"
                      : "ew-resize",
                  }}
                  aria-label={`Drag boundary between steps ${leading().stepIndex + 1} and ${trailingSegment.stepIndex + 1}`}
                  title={
                    props.drag.dragEditingDisabled()
                      ? "Stop preview or use Fixture scrolling to drag-edit"
                      : `Resize steps ${leading().stepIndex + 1} and ${trailingSegment.stepIndex + 1}; Shift-drag to resize only step ${leading().stepIndex + 1}`
                  }
                  disabled={props.drag.dragEditingDisabled()}
                  data-step-fx-waveform-boundary-handle
                  data-leading-step-index={leading().stepIndex}
                  data-trailing-step-index={trailingSegment.stepIndex}
                  onPointerDown={(event) =>
                    props.drag.startWaveformDrag(
                      event,
                      {
                        kind: "width",
                        stepUids: [leading().stepUid, trailingSegment.stepUid],
                        resizeCycle: false,
                      },
                      props.waveform,
                      leading(),
                      trailingSegment,
                    )
                  }
                />
              )}
            </Show>
          );
        }}
      </For>
      <For each={props.waveform.segments}>
        {(segment) => (
          <>
            <button
              type="button"
              class="absolute z-30 size-5 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize touch-none rounded-full border-2 border-blue-400 bg-neutral-950 p-0 transition-[transform,box-shadow] hover:scale-125 hover:ring-2 hover:ring-blue-300/60 focus-visible:scale-125 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300/60 disabled:cursor-not-allowed disabled:opacity-50"
              style={{
                ...controlPointStyle(props.waveform, segment, "ramp-start"),
                cursor: props.drag.dragEditingDisabled()
                  ? "not-allowed"
                  : "ew-resize",
              }}
              aria-label={
                props.cycleOffset === 0
                  ? `Adjust waveform ramp start for step ${segment.stepIndex + 1}`
                  : undefined
              }
              title={
                props.drag.dragEditingDisabled()
                  ? "Stop preview or use Fixture scrolling to drag-edit"
                  : `Drag step ${segment.stepIndex + 1} ramp start`
              }
              tabindex={props.cycleOffset === 0 ? undefined : -1}
              disabled={props.drag.dragEditingDisabled()}
              data-step-fx-waveform-point={
                props.cycleOffset === 0 ? "" : undefined
              }
              data-control-point="ramp-start"
              onPointerDown={(event) =>
                props.drag.startWaveformDrag(
                  event,
                  {
                    kind: "control-point",
                    stepUid: segment.stepUid,
                    point: "ramp-start",
                  },
                  props.waveform,
                  segment,
                )
              }
            />
            <button
              type="button"
              class="absolute z-40 size-3 -translate-x-1/2 -translate-y-1/2 cursor-grab touch-none rounded-full border border-blue-200 bg-blue-500 p-0 transition-[transform,box-shadow] hover:scale-150 hover:ring-2 hover:ring-blue-200/60 focus-visible:scale-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-200/60 active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-50"
              style={{
                ...controlPointStyle(props.waveform, segment, "ramp-end"),
                cursor: props.drag.dragEditingDisabled()
                  ? "not-allowed"
                  : "grab",
              }}
              aria-label={
                props.cycleOffset === 0
                  ? `Adjust waveform control point for step ${segment.stepIndex + 1}`
                  : undefined
              }
              title={
                props.drag.dragEditingDisabled()
                  ? "Stop preview or use Fixture scrolling to drag-edit"
                  : `Drag step ${segment.stepIndex + 1} ramp end and value`
              }
              tabindex={props.cycleOffset === 0 ? undefined : -1}
              disabled={props.drag.dragEditingDisabled()}
              data-step-fx-waveform-point={
                props.cycleOffset === 0 ? "" : undefined
              }
              data-control-point="ramp-end"
              onPointerDown={(event) =>
                props.drag.startWaveformDrag(
                  event,
                  {
                    kind: "control-point",
                    stepUid: segment.stepUid,
                    point: "ramp-end",
                  },
                  props.waveform,
                  segment,
                )
              }
            />
          </>
        )}
      </For>
    </div>
  );
}
