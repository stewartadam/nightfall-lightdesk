// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  type Component,
  createEffect,
  createSignal,
  For,
  onCleanup,
} from "solid-js";
import { getLogger } from "../../../lib/logger";
import { durationToMs, msToPixels, pixelsToMs } from "../../../lib/utils";
import type * as types from "../../../types";
import { useTimelineContext } from "../context/timeline-context";

const log = getLogger(import.meta.url);

/** Renders one draggable automation point within a lane. */
const DraggablePoint: Component<{
  index: number;
  point: { x: number; y: number };
  value: number;
  positionMs: number;
  trackId: string;
  automationLaneId: string;
  onUpdate: (index: number, position: number, value: number) => void;
  onRemove: (index: number) => void;
  onDragStart: (index: number, point: { x: number; y: number }) => void;
  onDragEnd: (index: number) => void;
  trackHeight: number;
  startTime: number;
  zoom: number;
  isDragging: boolean;
  canEdit: () => boolean;
  onActivateTrack: () => void;
}> = (props) => {
  let pointRef: HTMLDivElement | undefined;
  const dragState = {
    isDragging: false,
    startX: 0,
    startY: 0,
    offsetX: 0,
    offsetY: 0,
  };

  let clickTimeout: number | null = null;
  const CLICK_DELAY = 200; // ms

  const handleMouseDown = (e: MouseEvent) => {
    e.stopPropagation();
    if (!props.canEdit()) {
      e.preventDefault();
      props.onActivateTrack();
      return;
    }
    if (!pointRef) return;

    // Clear any existing click timeout
    if (clickTimeout) {
      clearTimeout(clickTimeout);
      clickTimeout = null;
      // This is a double-click
      handleDoubleClick(e);
      return;
    }

    // Set a timeout to detect single click
    clickTimeout = window.setTimeout(() => {
      // Clear the timeout reference
      clickTimeout = null;
      // This is a single click, start dragging
      dragState.isDragging = true;
      dragState.startX = e.clientX;
      dragState.startY = e.clientY;
      dragState.offsetX = 0;
      dragState.offsetY = 0;

      // Notify parent about drag start
      props.onDragStart(props.index, { x: props.point.x, y: props.point.y });

      // Add global event listeners
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp, { once: true });
    }, CLICK_DELAY);

    // Prevent text selection during drag
    e.preventDefault();
  };

  const handleMouseMove = (e: MouseEvent) => {
    if (!dragState.isDragging || !pointRef?.parentElement) return;

    // Get the track container's position
    const trackRect = pointRef.parentElement.getBoundingClientRect();

    // Calculate mouse position relative to the track
    const mouseX = e.clientX - trackRect.left;
    const mouseY = e.clientY - trackRect.top;

    // Calculate offsets from the original point position
    const offsetX = mouseX - props.point.x;
    const offsetY = mouseY - props.point.y;

    // Update drag offset for visual feedback
    dragState.offsetX = offsetX;
    dragState.offsetY = offsetY;

    // Update visual position
    pointRef.style.transform = `translate(${offsetX}px, ${offsetY}px)`;

    // Calculate the new position in the track (in pixels)
    const trackX = props.point.x + offsetX;
    const trackY = props.point.y + offsetY;

    // Update the point in real-time (passing pixel X coordinate directly)
    props.onUpdate(props.index, trackX, trackY);
  };

  const handleMouseUp = (_e: MouseEvent) => {
    if (!dragState.isDragging) return;

    // Notify parent about drag end
    props.onDragEnd(props.index);

    // Reset drag state
    dragState.isDragging = false;
    if (pointRef) {
      pointRef.style.transform = "";
    }

    // Remove event listeners
    document.removeEventListener("mousemove", handleMouseMove);

    // Clear any pending click timeout
    if (clickTimeout) {
      clearTimeout(clickTimeout);
      clickTimeout = null;
    }
  };

  const handleDoubleClick = (e: MouseEvent) => {
    e.stopPropagation();
    if (!props.canEdit()) {
      props.onActivateTrack();
      return;
    }
    props.onRemove(props.index);
  };

  // Cleanup on unmount
  onCleanup(() => {
    document.removeEventListener("mousemove", handleMouseMove);
    document.removeEventListener("mouseup", handleMouseUp);
    if (clickTimeout) {
      clearTimeout(clickTimeout);
    }
  });

  return (
    <div
      ref={pointRef}
      class="automation-point draggable-point absolute w-2 h-2 rounded-full bg-white cursor-move -translate-x-1 -translate-y-1"
      style={{
        left: `${props.point.x}px`,
        top: `${props.point.y}px`,
      }}
      onMouseDown={handleMouseDown}
    />
  );
};

type AutomationLaneProps = {
  trackId: string;
  automationLane: types.AutomationLane;
};

export const AutomationLane: Component<AutomationLaneProps> = (props) => {
  log.trace("mounting");
  let containerRef: HTMLDivElement | undefined;
  const [isAddingPoint, setIsAddingPoint] = createSignal(false);
  const [draggedPoint, setDraggedPoint] = createSignal<{
    index: number;
    x: number;
    y: number;
  } | null>(null);
  const TRACK_HEIGHT = 60; // Height of the track in pixels
  const ctx = useTimelineContext();
  const [svgPath, setSvgPath] = createSignal("");
  const [pointPositions, setPointPositions] = createSignal<
    Array<{ x: number; y: number }>
  >([]);

  const isDragging = () => !!draggedPoint();

  const isTrackHighlighted = () => ctx.recordTargetTrackId() === props.trackId;
  // Track the currently dragged point index for visual feedback

  /** Function to calculate point positions from data points */
  const calculatePointPositions = () => {
    if (
      !props.automationLane.points ||
      props.automationLane.points.length === 0
    ) {
      setPointPositions([]);
      setSvgPath("");
      return;
    }

    // Sort points by position
    const sortedPoints = [...props.automationLane.points].sort(
      (a, b) => durationToMs(a.position) - durationToMs(b.position),
    );

    // Calculate pixel positions for each point
    const positions = sortedPoints.map((point) => {
      const x = msToPixels(
        durationToMs(point.position) - ctx.start(),
        ctx.zoom(),
      );
      // Invert Y coordinate (SVG Y is top to bottom, but we want bottom to top for automationLane value)
      const y = TRACK_HEIGHT - point.value * TRACK_HEIGHT;
      return { x, y };
    });

    setPointPositions(positions);

    /** Generate SVG path from points, accounting for dragged point */
    const updateSvgPath = () => {
      const points = pointPositions();
      const dragged = draggedPoint();

      if (points.length === 0) {
        setSvgPath("");
        return;
      }

      let path = `M ${points[0].x} ${points[0].y}`;

      for (let i = 1; i < points.length; i++) {
        if (dragged?.index === i) {
          // Use dragged position for the point being dragged
          path += ` L ${dragged.x} ${dragged.y}`;
        } else if (dragged?.index === i - 1) {
          // If previous point is being dragged, connect to it
          path += ` L ${dragged.x} ${dragged.y}`;
          // Add the next point if it's not the dragged point
          if (i < points.length - 1 || dragged.index !== i) {
            path += ` L ${points[i].x} ${points[i].y}`;
          }
        } else if (i - 1 !== dragged?.index) {
          // Normal point connection
          path += ` L ${points[i].x} ${points[i].y}`;
        }
      }

      setSvgPath(path);
    };

    // Update SVG path when points or dragged point changes
    createEffect(updateSvgPath);
  };

  // Update path when points change
  createEffect(() => {
    // Track dependency for reactive updates
    void props.automationLane.points;
    calculatePointPositions();
  });

  // Separate effect to update positions when zoom or start position changes
  createEffect(() => {
    // Track dependencies for reactive updates
    void ctx.zoom();
    void ctx.start();

    // Only recalculate if we have points
    if (props.automationLane.points.length > 0) {
      calculatePointPositions();
    }
  });

  /** Handle track click */
  const handleTrackClick = (e: MouseEvent) => {
    if (!isTrackHighlighted()) {
      ctx.setRecordTargetTrackId(props.trackId);
    }

    if (e.type === "click") {
      e.preventDefault();
    }

    if (!containerRef || isAddingPoint() || isDragging()) {
      e.stopPropagation();
      return;
    }

    // Check if we clicked on a point or its children
    const target = e.target as HTMLElement;
    const clickedOnPoint =
      target.closest(".automation-point") || target.closest(".draggable-point");

    if (clickedOnPoint) {
      // If we clicked on a point, don't add a new one
      return;
    }

    // Check if we're in the middle of a drag operation
    if (isDragging()) {
      return;
    }

    // Only proceed if this is a simple click (not part of a drag)
    if (e.type === "click") {
      setIsAddingPoint(true);

      // Calculate position based on click coordinates
      const rect = containerRef.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      // Convert to automationLane position and value
      const position = ctx.start() + pixelsToMs(x, ctx.zoom());
      // Invert Y coordinate (SVG Y is top to bottom, but automationLane value is bottom to top)
      const value = 1 - y / TRACK_HEIGHT;

      // Clamp value between 0 and 1
      const clampedValue = Math.max(0, Math.min(1, value));

      // Add new point
      ctx.track.addPoint(
        props.trackId,
        props.automationLane.id,
        position,
        clampedValue,
      );

      setIsAddingPoint(false);
    }
  };

  /** Handle point position updates during drag */
  const handlePointUpdate = (index: number, x: number, y: number) => {
    // Update the dragged point's position
    setDraggedPoint({
      index,
      x,
      y,
    });
    return true; // Indicate update was handled
  };

  /** Handle drag start - wrapped in createEffect to ensure reactivity */
  const handleDragStart = (index: number, point: { x: number; y: number }) => {
    setDraggedPoint({
      index,
      x: point.x,
      y: point.y,
    });
    return true; // Indicate drag started successfully
  };

  /** Handle drag end */
  const handleDragEnd = (index: number) => {
    const dragged = draggedPoint();
    if (!dragged) return;

    // Get the sorted points to find the correct point
    const sortedPoints = [...props.automationLane.points].sort(
      (a, b) => durationToMs(a.position) - durationToMs(b.position),
    );
    const pointData = sortedPoints[index];
    if (!pointData) {
      setDraggedPoint(null);
      return;
    }

    // Find the actual point in the original array by matching position and value
    const originalPointPosition = durationToMs(pointData.position);
    const originalPointValue = pointData.value;

    const actualPointIndex = props.automationLane.points.findIndex(
      (p) =>
        Math.abs(durationToMs(p.position) - originalPointPosition) < 1 &&
        Math.abs(p.value - originalPointValue) < 0.001,
    );

    if (actualPointIndex !== -1) {
      // Calculate the new position in the timeline (convert from pixels to timeline time)
      const timelinePosition = Math.max(
        0,
        ctx.start() + pixelsToMs(dragged.x, ctx.zoom()),
      );
      // Calculate the new value (inverted Y coordinate), clamped between 0 and 1
      const newValue = Math.max(0, Math.min(1, 1 - dragged.y / TRACK_HEIGHT));

      // Update the point in the timeline
      ctx.track.updatePoint(
        props.trackId,
        props.automationLane.id,
        actualPointIndex,
        timelinePosition,
        newValue,
      );
    }

    // Clear the dragged point state
    setDraggedPoint(null);
  };

  /** Handle point removal */
  const handleRemovePoint = (index: number) => {
    const sortedPoints = [...props.automationLane.points].sort(
      (a, b) => durationToMs(a.position) - durationToMs(b.position),
    );
    const pointData = sortedPoints[index];
    if (!pointData) return;

    const originalPointPosition = durationToMs(pointData.position);
    const originalPointValue = pointData.value;

    const actualPointIndex = props.automationLane.points.findIndex(
      (p) =>
        Math.abs(durationToMs(p.position) - originalPointPosition) < 1 &&
        Math.abs(p.value - originalPointValue) < 0.001,
    );

    if (actualPointIndex !== -1) {
      ctx.track.removePoint(
        props.trackId,
        props.automationLane.id,
        actualPointIndex,
      );
    }
  };

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Keyboard navigation not supported.
    <div
      ref={containerRef}
      data-timeline-automation-lane="true"
      data-track-id={props.trackId}
      data-automationLane-id={props.automationLane.id}
      class="relative h-[60px] w-full cursor-pointer select-none border-b border-gray-700"
      onMouseDown={handleTrackClick}
      onClick={handleTrackClick}
    >
      {/* Grid lines */}
      <div class="absolute inset-0 border-t border-b border-[#333333] pointer-events-none">
        <div class="absolute top-1/4 w-full border-t border-dashed border-[#2a2a2a]" />
        <div class="absolute top-1/2 w-full border-t border-dashed border-[#2a2a2a]" />
        <div class="absolute top-3/4 w-full border-t border-dashed border-[#2a2a2a]" />
      </div>

      {/* Automation lane curve */}
      <svg class="absolute inset-0 w-full h-full pointer-events-none">
        <path
          d={svgPath()}
          stroke={props.automationLane.color}
          stroke-width="2"
          fill="none"
        />
      </svg>

      {/* Automation points */}
      <For each={pointPositions()}>
        {(point) => {
          // Get the index from the point positions array
          const currentIndex = pointPositions().indexOf(point);
          // Get the sorted points once to avoid repeated sorting
          const sortedPoints = [...props.automationLane.points].sort(
            (a, b) => durationToMs(a.position) - durationToMs(b.position),
          );
          const pointData = sortedPoints[currentIndex];

          if (!pointData) return null;

          return (
            <DraggablePoint
              index={currentIndex}
              point={point}
              value={pointData.value}
              positionMs={durationToMs(pointData.position)}
              trackId={props.trackId}
              automationLaneId={props.automationLane.id}
              onUpdate={handlePointUpdate}
              onRemove={handleRemovePoint}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
              trackHeight={TRACK_HEIGHT}
              startTime={ctx.start()}
              zoom={ctx.zoom()}
              isDragging={!!draggedPoint()}
              canEdit={isTrackHighlighted}
              onActivateTrack={() => ctx.setRecordTargetTrackId(props.trackId)}
            />
          );
        }}
      </For>
    </div>
  );
};
