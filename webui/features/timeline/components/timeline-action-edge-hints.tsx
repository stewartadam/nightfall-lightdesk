// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createEffect, createSignal, For, onCleanup, onMount } from "solid-js";
import type * as types from "../../../types";
import { useTimelineContext } from "../context/timeline-context";
import { getMarkerStyle } from "./action";

const EDGE_HINT_BAND_HEIGHT_PX = 10;
const EDGE_HINT_HEIGHT_PX = 3;
const EDGE_HINT_BUCKET_WIDTH_PX = 10;
const EDGE_HINT_MAX_WIDTH_PX = 72;
const EDGE_HINT_MAX_ITEMS_PER_EDGE = 96;

type TimelineActionEdgeHintEdge = "top" | "bottom";

interface TimelineActionEdgeHint {
  key: string;
  edge: TimelineActionEdgeHintEdge;
  actionType: types.ActionKind["type"];
  left: number;
  width: number;
  count: number;
}

interface TimelineActionEdgeHintsProps {
  scrollContainer: () => HTMLDivElement | undefined;
  timelinePlane: () => HTMLDivElement | undefined;
  timelineWidth: () => number;
  trackHeaderWidth: number;
  timelineChromeHeight: number;
}

/** Creates a stable grouping key for nearby offscreen action hints. */
function actionEdgeHintBucketKey(
  edge: TimelineActionEdgeHintEdge,
  actionType: types.ActionKind["type"],
  left: number,
): string {
  return `${edge}:${actionType}:${Math.round(left / EDGE_HINT_BUCKET_WIDTH_PX)}`;
}

/** Returns the action type stored on a rendered action, if it is valid. */
function actionActionTypeFromElement(
  element: HTMLElement,
): types.ActionKind["type"] | undefined {
  const actionType = element.dataset.actionType;
  switch (actionType) {
    case "FireCue":
    case "StartClip":
    case "StopClip":
    case "AdvanceSequence":
    case "BackSequence":
    case "SetClipRate":
    case "JumpToCue":
    case "DeskEval":
      return actionType;
    default:
      return undefined;
  }
}

/** Measures rendered actions fully above or below the track viewport. */
function measureActionEdgeHints(
  scrollContainer: HTMLElement,
  timelinePlane: HTMLElement,
  timelineWidth: number,
  trackHeaderWidth: number,
  timelineChromeHeight: number,
): TimelineActionEdgeHint[] {
  const containerBox = scrollContainer.getBoundingClientRect();
  const planeBox = timelinePlane.getBoundingClientRect();
  const trackViewportTop = containerBox.top + timelineChromeHeight;
  const trackViewportBottom = containerBox.bottom;
  const trackViewportLeft = containerBox.left + trackHeaderWidth;
  const trackViewportRight = containerBox.right;
  const hintsByBucket = new Map<string, TimelineActionEdgeHint>();
  const edgeCounts: Record<TimelineActionEdgeHintEdge, number> = {
    top: 0,
    bottom: 0,
  };

  for (const row of scrollContainer.querySelectorAll<HTMLElement>(
    "[data-timeline-track-row='true']",
  )) {
    const rowBox = row.getBoundingClientRect();
    const edge =
      rowBox.bottom < trackViewportTop
        ? "top"
        : rowBox.top > trackViewportBottom
          ? "bottom"
          : undefined;
    if (!edge || edgeCounts[edge] >= EDGE_HINT_MAX_ITEMS_PER_EDGE) continue;

    for (const action of row.querySelectorAll<HTMLElement>(
      "[data-timeline-action='true']:not([data-drag-preview='true'])",
    )) {
      const actionType = actionActionTypeFromElement(action);
      if (!actionType) continue;

      const itemBox = action.getBoundingClientRect();
      if (
        itemBox.right < trackViewportLeft ||
        itemBox.left > trackViewportRight
      ) {
        continue;
      }

      const width = Math.min(
        Math.max(itemBox.width, EDGE_HINT_BUCKET_WIDTH_PX),
        EDGE_HINT_MAX_WIDTH_PX,
      );
      const left = itemBox.left - planeBox.left;
      if (left + width < 0 || left > timelineWidth) continue;

      const key = actionEdgeHintBucketKey(edge, actionType, left);
      const existing = hintsByBucket.get(key);
      if (existing) {
        existing.width = Math.max(existing.width, width);
        existing.count += 1;
      } else {
        hintsByBucket.set(key, {
          key,
          edge,
          actionType,
          left,
          width,
          count: 1,
        });
      }
      edgeCounts[edge] += 1;
      if (edgeCounts[edge] >= EDGE_HINT_MAX_ITEMS_PER_EDGE) break;
    }
  }

  return [...hintsByBucket.values()];
}

/** Renders compressed color hints for actions outside the vertical viewport. */
export function TimelineActionEdgeHints(props: TimelineActionEdgeHintsProps) {
  const ctx = useTimelineContext();
  const [hints, setHints] = createSignal<TimelineActionEdgeHint[]>([]);
  const [viewport, setViewport] = createSignal({ height: 0, scrollTop: 0 });
  let animationFrame: number | undefined;

  /** Recomputes edge hint positions after scroll, resize, zoom, or track changes. */
  const updateHints = () => {
    const scrollContainer = props.scrollContainer();
    const timelinePlane = props.timelinePlane();
    if (!scrollContainer || !timelinePlane) {
      setHints([]);
      setViewport({ height: 0, scrollTop: 0 });
      return;
    }

    setViewport({
      height: scrollContainer.clientHeight,
      scrollTop: scrollContainer.scrollTop,
    });
    setHints(
      measureActionEdgeHints(
        scrollContainer,
        timelinePlane,
        props.timelineWidth(),
        props.trackHeaderWidth,
        props.timelineChromeHeight,
      ),
    );
  };

  /** Batches repeated scroll and resize notifications into one layout read. */
  const scheduleUpdateHints = () => {
    if (animationFrame !== undefined) return;
    animationFrame = window.requestAnimationFrame(() => {
      animationFrame = undefined;
      updateHints();
    });
  };

  onMount(() => {
    const scrollContainer = props.scrollContainer();
    if (!scrollContainer) return;
    const resizeObserver = new ResizeObserver(scheduleUpdateHints);

    scrollContainer.addEventListener("scroll", scheduleUpdateHints, {
      passive: true,
    });
    resizeObserver.observe(scrollContainer);
    window.addEventListener("resize", scheduleUpdateHints);
    scheduleUpdateHints();

    onCleanup(() => {
      scrollContainer.removeEventListener("scroll", scheduleUpdateHints);
      resizeObserver.disconnect();
      window.removeEventListener("resize", scheduleUpdateHints);
    });
  });

  /** Rechecks hints when timeline data or horizontal scale changes. */
  createEffect(() => {
    ctx.displayTracks();
    ctx.start();
    ctx.zoom();
    ctx.end();
    scheduleUpdateHints();
  });

  onCleanup(() => {
    if (animationFrame !== undefined) {
      window.cancelAnimationFrame(animationFrame);
    }
  });

  return (
    <div
      data-timeline-action-edge-hints="true"
      aria-hidden="true"
      class="pointer-events-none absolute inset-x-0 top-0 z-[75]"
      style={{ height: `${Math.max(viewport().height, 1)}px` }}
    >
      <For each={hints()}>
        {(hint) => {
          const markerStyle = getMarkerStyle(hint.actionType);
          const top =
            hint.edge === "top"
              ? viewport().scrollTop + props.timelineChromeHeight
              : viewport().scrollTop +
                viewport().height -
                EDGE_HINT_BAND_HEIGHT_PX;
          const offset =
            hint.edge === "top"
              ? Math.min(hint.count - 1, 2)
              : EDGE_HINT_BAND_HEIGHT_PX -
                EDGE_HINT_HEIGHT_PX -
                Math.min(hint.count - 1, 2);
          return (
            <div
              data-timeline-action-edge-hint={hint.edge}
              data-action-type={hint.actionType}
              class={`absolute rounded-full opacity-75 shadow-[0_0_8px_rgba(255,255,255,0.18)] ${markerStyle.stem}`}
              style={{
                left: `${props.trackHeaderWidth + hint.left}px`,
                top: `${top + offset}px`,
                width: `${hint.width}px`,
                height: `${EDGE_HINT_HEIGHT_PX}px`,
              }}
            />
          );
        }}
      </For>
    </div>
  );
}
