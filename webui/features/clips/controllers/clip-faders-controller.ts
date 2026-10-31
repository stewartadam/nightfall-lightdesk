// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { reducedMotion } from "../../../state/reduced-motion";
import {
  COLLAPSED_FADERS_HEIGHT,
  clampFadersHeight,
  loadFadersCollapsed,
  loadFadersHeight,
  persistFadersCollapsed,
  persistFadersHeight,
} from "../state/faders-layout";

interface ResizeStart {
  pointerId: number;
  startY: number;
  startHeight: number;
  panelHeight: number | undefined;
}

/** Owns persisted clip faders sizing, collapse state, and resize listeners. */
export function createClipFadersController(
  panelElement: () => HTMLDivElement | undefined,
) {
  let resizeStart: ResizeStart | undefined;
  const [height, setHeight] = createSignal(loadFadersHeight());
  const [collapsed, setCollapsedSignal] = createSignal(loadFadersCollapsed());

  const [transitioning, setTransitioning] = createSignal(false);
  let transitionTimer: ReturnType<typeof setTimeout> | undefined;

  /** Ends the collapse transition before direct resizing or disposal. */
  const finishTransition = () => {
    clearTimeout(transitionTimer);
    setTransitioning(false);
  };

  /** Computes the section height rendered for expanded and collapsed states. */
  const visibleHeight = createMemo(() =>
    collapsed() ? COLLAPSED_FADERS_HEIGHT : height(),
  );

  /** Applies and persists a height clamped to the current panel bounds. */
  const applyHeight = (nextHeight: number, panelHeight?: number) => {
    finishTransition();
    const clampedHeight = clampFadersHeight(nextHeight, panelHeight);
    setHeight(clampedHeight);
    persistFadersHeight(clampedHeight);
  };

  /** Applies and persists the faders collapsed state. */
  const setCollapsed = (nextCollapsed: boolean) => {
    setCollapsedSignal(nextCollapsed);
    persistFadersCollapsed(nextCollapsed);
  };

  /** Tracks pointer movement while a faders resize is active. */
  const handleResizeMove = (event: PointerEvent) => {
    if (!resizeStart || event.pointerId !== resizeStart.pointerId) return;
    event.preventDefault();
    applyHeight(
      resizeStart.startHeight + resizeStart.startY - event.clientY,
      resizeStart.panelHeight,
    );
  };

  /** Removes global pointer listeners and ends an active resize operation. */
  const removeResizeListeners = () => {
    window.removeEventListener("pointermove", handleResizeMove);
    window.removeEventListener("pointerup", handleResizeEnd);
    window.removeEventListener("pointercancel", handleResizeEnd);
  };

  /** Completes the active resize when its originating pointer is released. */
  const handleResizeEnd = (event: PointerEvent) => {
    if (!resizeStart || event.pointerId !== resizeStart.pointerId) return;
    event.preventDefault();
    resizeStart = undefined;
    removeResizeListeners();
  };

  /** Begins pointer tracking for an expanded faders. */
  const handleResizeStart = (event: PointerEvent) => {
    if (collapsed()) return;
    event.preventDefault();
    resizeStart = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: height(),
      panelHeight: panelElement()?.getBoundingClientRect().height,
    };
    window.addEventListener("pointermove", handleResizeMove);
    window.addEventListener("pointerup", handleResizeEnd);
    window.addEventListener("pointercancel", handleResizeEnd);
  };

  /** Changes faders height in fixed keyboard increments. */
  const handleResizeKeyDown = (event: KeyboardEvent) => {
    if (collapsed()) return;
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    applyHeight(
      height() + (event.key === "ArrowUp" ? 16 : -16),
      panelElement()?.getBoundingClientRect().height,
    );
  };

  /** Toggles the persisted collapsed state. */
  const toggleCollapsed = () => {
    clearTimeout(transitionTimer);
    setTransitioning(!reducedMotion.get());
    setCollapsed(!collapsed());
    transitionTimer = setTimeout(finishTransition, 200);
  };

  /** Reapplies the section bounds when its docked panel changes size. */
  onMount(() => {
    const panel = panelElement();
    if (!panel) return;
    const observer = new ResizeObserver(() => {
      const nextHeight = clampFadersHeight(
        height(),
        panel.getBoundingClientRect().height,
      );
      if (nextHeight !== height())
        applyHeight(nextHeight, panel.getBoundingClientRect().height);
    });
    observer.observe(panel);
    onCleanup(() => observer.disconnect());
  });

  onCleanup(removeResizeListeners);
  onCleanup(finishTransition);

  return {
    collapsed,
    transitioning,
    height,
    visibleHeight,
    handleResizeKeyDown,
    handleResizeStart,
    toggleCollapsed,
  };
}
