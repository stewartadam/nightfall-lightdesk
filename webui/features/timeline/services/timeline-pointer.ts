// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createSignal } from "solid-js";
import { pixelsToMs } from "../../../lib/utils";

type TimelinePointerControllerOptions = {
  scrollContainer: () => HTMLDivElement | undefined;
  timelinePlane: () => HTMLDivElement | undefined;
  trackHeaderWidth: number;
};

type TimelineCursorProjection = {
  start: number;
  zoom: number;
  setPosition: (position: number | undefined) => void;
};

/**
 * Owns pointer projection and transient seek-preview state for a timeline viewport.
 */
export function createTimelinePointerController(
  options: TimelinePointerControllerOptions,
) {
  const [ghostPlayheadPosition, setGhostPlayheadPosition] = createSignal<
    number | undefined
  >(undefined);
  const [lastClientX, setLastClientX] = createSignal<number | undefined>(
    undefined,
  );

  /** Clears the seek preview and, when supplied, the timeline cursor position. */
  const clear = (cursor?: TimelineCursorProjection) => {
    setLastClientX(undefined);
    setGhostPlayheadPosition(undefined);
    cursor?.setPosition(undefined);
  };

  /** Projects a client-space X coordinate into the visible timeline plane. */
  const projectGhost = (clientX: number) => {
    const scrollContainer = options.scrollContainer();
    const timelinePlane = options.timelinePlane();
    if (!scrollContainer || !timelinePlane) return;

    const viewportRect = scrollContainer.getBoundingClientRect();
    if (clientX < viewportRect.left + options.trackHeaderWidth) {
      setGhostPlayheadPosition(undefined);
      return;
    }

    const timelineRect = timelinePlane.getBoundingClientRect();
    const localX = Math.max(
      0,
      Math.min(clientX - timelineRect.left, timelineRect.width),
    );
    setGhostPlayheadPosition(localX);
  };

  /** Updates the seek preview and editable cursor from one pointer event. */
  const move = (event: PointerEvent, cursor: TimelineCursorProjection) => {
    setLastClientX(event.clientX);
    projectGhost(event.clientX);

    const scrollContainer = options.scrollContainer();
    const timelinePlane = options.timelinePlane();
    if (!scrollContainer || !timelinePlane) return;

    const viewportRect = scrollContainer.getBoundingClientRect();
    if (event.clientX < viewportRect.left + options.trackHeaderWidth) {
      cursor.setPosition(undefined);
      return;
    }

    const timelineRect = timelinePlane.getBoundingClientRect();
    const positionPx = event.clientX - timelineRect.left;
    cursor.setPosition(cursor.start + pixelsToMs(positionPx, cursor.zoom));
  };

  /** Reprojects the most recent pointer after scrolling changes viewport geometry. */
  const refresh = () => {
    const clientX = lastClientX();
    if (clientX !== undefined) projectGhost(clientX);
  };

  return {
    clear,
    ghostPlayheadPosition,
    move,
    refresh,
  };
}
