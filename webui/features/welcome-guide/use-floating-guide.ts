// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  type Accessor,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  untrack,
} from "solid-js";

/** Places cards beside their target and preserves manual placement until the next step. */
export function useFloatingGuide(
  element: Accessor<HTMLElement | undefined>,
  step: Accessor<string>,
  anchor: Accessor<DOMRect | null>,
  selector: Accessor<string | undefined>,
  preference: Accessor<"above" | undefined>,
) {
  const [position, setPosition] = createSignal({ x: 12, y: 80 });
  const [size, setSize] = createSignal({ width: 360, height: 400 });
  /** Aims a tip from the nearest card edge toward the actual action, including after dragging. */
  const pointer = createMemo(() => {
    const target = anchor();
    if (!target) return undefined;
    const { x, y } = position();
    const { width, height } = size();
    const cx = target.x + target.width / 2 - x;
    const cy = target.y + target.height / 2 - y;
    if (cx >= 0 && cx <= width && cy >= 0 && cy <= height) return undefined;
    const horizontal =
      Math.abs((cx - width / 2) / width) > Math.abs((cy - height / 2) / height);
    const side = horizontal
      ? cx < width / 2
        ? "left"
        : "right"
      : cy < height / 2
        ? "top"
        : "bottom";
    const offset = Math.max(
      20,
      Math.min(horizontal ? cy : cx, (horizontal ? height : width) - 20),
    );
    return {
      side,
      style: horizontal
        ? { top: `${offset}px`, [side]: "-7px" }
        : { left: `${offset}px`, [side]: "-7px" },
    };
  });
  let manual = false;
  let placedGeometry = "";
  /** Finds an open dialog's content so the card avoids its controls as well as the step target. */
  const dialogBounds = () => {
    const surfaces = [
      ...document.querySelectorAll<HTMLElement>(
        ".nf-dialog-backdrop > :first-child",
      ),
    ];
    return surfaces
      .map((surface) => surface.getBoundingClientRect())
      .reverse()
      .find((rect) => rect.width > 0 && rect.height > 0);
  };
  /** Keeps the card reachable after dragging or resizing. */
  const clamp = (point: { x: number; y: number }) => ({
    x: Math.max(
      12,
      Math.min(
        point.x,
        window.innerWidth - (element()?.offsetWidth ?? 360) - 12,
      ),
    ),
    y: Math.max(
      12,
      Math.min(
        point.y,
        window.innerHeight - (element()?.offsetHeight ?? 400) - 12,
      ),
    ),
  });
  /** Chooses a nearby placement that leaves the target clear and minimizes Visualizer overlap. */
  const place = () => {
    const card = element();
    if (!card) return;
    setSize({ width: card.offsetWidth, height: card.offsetHeight });
    if (manual) {
      setPosition(clamp(untrack(position)));
      return;
    }
    const visualizer = document
      .querySelector('[aria-label="3D visualizer viewport"]')
      ?.getBoundingClientRect();
    const dialog = dialogBounds();
    const target = anchor() ?? dialog ?? visualizer;
    const width = card.offsetWidth;
    const height = card.offsetHeight;
    if (!target) {
      setPosition(clamp({ x: window.innerWidth - width - 12, y: 80 }));
      return;
    }
    const targetElement = selector()
      ? [...document.querySelectorAll<HTMLElement>(selector()!)].find(
          (entry) => {
            const rect = entry.getBoundingClientRect();
            return (
              rect.width > 0 &&
              rect.height > 0 &&
              Math.abs(rect.x - (anchor()?.x ?? -1)) < 1 &&
              Math.abs(rect.y - (anchor()?.y ?? -1)) < 1
            );
          },
        )
      : undefined;
    const panel = targetElement
      ?.closest("[data-panel-id]")
      ?.getBoundingClientRect();
    /** Offers placements outside both the action and the panel whose content explains the lesson. */
    const beside = (rect: DOMRect) => [
      { x: rect.right + 16, y: target.y + target.height / 2 - height / 2 },
      {
        x: rect.left - width - 16,
        y: target.y + target.height / 2 - height / 2,
      },
      { x: target.x + target.width / 2 - width / 2, y: rect.bottom + 16 },
      { x: target.x + target.width / 2 - width / 2, y: rect.top - height - 16 },
    ];
    const candidates = [
      ...beside(target),
      ...(dialog ? beside(dialog) : []),
      ...(panel ? beside(panel) : []),
      ...(panel
        ? [
            {
              x: panel.right + 16,
              y: panel.top,
            },
            {
              x: panel.left - width - 16,
              y: panel.top,
            },
            {
              x: panel.left,
              y: panel.bottom + 16,
            },
            {
              x: panel.left,
              y: panel.top - height - 16,
            },
          ]
        : []),
      { x: 12, y: 80 },
      { x: window.innerWidth - width - 12, y: 80 },
      { x: 12, y: window.innerHeight - height - 12 },
      {
        x: window.innerWidth - width - 12,
        y: window.innerHeight - height - 12,
      },
    ].map(clamp);
    /** Measures the covered area of a rectangle for a candidate position. */
    const overlap = (point: { x: number; y: number }, rect: DOMRect) =>
      Math.max(
        0,
        Math.min(point.x + width, rect.right) - Math.max(point.x, rect.left),
      ) *
      Math.max(
        0,
        Math.min(point.y + height, rect.bottom) - Math.max(point.y, rect.top),
      );
    const geometry = `${target.x},${target.y},${target.width},${target.height},${width},${height}`;
    // Honor teaching-specific placement before falling back to general overlap scoring.
    const preferred = dialog
      ? beside(dialog).slice(0, 2).map(clamp)
      : targetElement?.matches("[data-panel-id]")
        ? beside(target).map(clamp)
        : preference() === "above"
          ? [
              {
                x: target.x + target.width / 2 - width / 2,
                y: (panel?.top ?? target.top) - height - 16,
              },
            ]
          : [];
    const preferredPosition = preferred.find((point) => {
      const bounded = clamp(point);
      return (
        point.x === bounded.x &&
        point.y === bounded.y &&
        overlap(point, target) === 0 &&
        (!dialog || overlap(point, dialog) === 0) &&
        (!panel || overlap(point, panel) === 0)
      );
    });
    if (preferredPosition) {
      placedGeometry = geometry;
      setPosition(preferredPosition);
      return;
    }
    /** Measures the empty gap between the card and the relevant surface, independent of their sizes. */
    const gap = (point: { x: number; y: number }, rect: DOMRect) =>
      Math.hypot(
        Math.max(rect.left - point.x - width, point.x - rect.right, 0),
        Math.max(rect.top - point.y - height, point.y - rect.bottom, 0),
      );
    const current = untrack(position);
    const bounded = clamp(current);
    // Small result-list changes preserve placement; a large empty gap requires reattachment.
    if (
      geometry === placedGeometry &&
      current.x === bounded.x &&
      current.y === bounded.y &&
      overlap(current, target) === 0 &&
      (!dialog ||
        (overlap(current, dialog) === 0 && gap(current, dialog) <= 64))
    )
      return;
    placedGeometry = geometry;
    const panels = [
      ...document.querySelectorAll<HTMLElement>("[data-panel-id]"),
    ]
      .map((entry) => entry.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0);
    for (const point of [...candidates]) {
      for (const rect of panels) {
        for (const x of [rect.left, rect.right - width]) {
          if (Math.abs(x - point.x) <= 12)
            candidates.push(clamp({ ...point, x }));
        }
        for (const y of [rect.top, rect.bottom - height]) {
          if (Math.abs(y - point.y) <= 12)
            candidates.push(clamp({ ...point, y }));
        }
      }
    }
    /** Prefers clean alignment with nearby panel edges without pulling a centered pointer away. */
    const alignment = (point: { x: number; y: number }) =>
      Math.min(
        16,
        ...panels.flatMap((rect) => [
          Math.abs(point.x - rect.left),
          Math.abs(point.x + width - rect.right),
          Math.abs(point.y - rect.top),
          Math.abs(point.y + height - rect.bottom),
        ]),
      );
    /** Measures how far the target is from the center of the pointer-bearing card edge. */
    const centering = (point: { x: number; y: number }) =>
      point.x >= target.right || point.x + width <= target.left
        ? Math.abs(point.y + height / 2 - target.y - target.height / 2)
        : Math.abs(point.x + width / 2 - target.x - target.width / 2);
    /** Keeps header actions nearby; panel actions also preserve their teaching panel and Visualizer. */
    const score = (point: { x: number; y: number }) =>
      overlap(point, target) * 10000 +
      (dialog ? overlap(point, dialog) * 10000 : 0) +
      (panel ? overlap(point, panel) * 2 : 0) +
      (visualizer && (panel || !anchor()) ? overlap(point, visualizer) : 0) +
      gap(point, dialog ?? target) * 2 +
      centering(point) * 0.25 +
      alignment(point) * 0.1 +
      Math.hypot(point.x - target.x, point.y - target.y) * 0.001;
    candidates.sort((a, b) => score(a) - score(b));
    setPosition(candidates[0]);
  };
  /** Resets manual placement when the lesson advances. */
  createEffect(() => {
    step();
    manual = false;
    placedGeometry = "";
    untrack(place);
  });
  /** Tracks geometry changes without moving the card in response to ordinary pointer movement. */
  createEffect(() => {
    const card = element();
    anchor();
    if (!card) return;
    const frame = requestAnimationFrame(place);
    const observer = new ResizeObserver(place);
    observer.observe(card);
    let previousDialog = "";
    /** Reacts to dialog opening or closing without following unrelated app updates. */
    const pollDialog = window.setInterval(() => {
      const rect = dialogBounds();
      const key = rect
        ? `${rect.x},${rect.y},${rect.width},${rect.height}`
        : "";
      if (key !== previousDialog) {
        previousDialog = key;
        place();
      }
    }, 250);
    window.addEventListener("resize", place);
    onCleanup(() => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.clearInterval(pollDialog);
      window.removeEventListener("resize", place);
    });
  });
  /** Retains deliberate placement until the next instructional action. */
  const move = (point: { x: number; y: number }) => {
    manual = true;
    setPosition(clamp(point));
  };
  /** Lets keyboard users move the card using its handle and arrow keys. */
  const onKeyDown = (event: KeyboardEvent) => {
    const directions: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    const direction = directions[event.key];
    if (!direction) return;
    event.preventDefault();
    event.stopPropagation();
    const delta = event.shiftKey ? 50 : 20;
    move({
      x: position().x + direction[0] * delta,
      y: position().y + direction[1] * delta,
    });
  };
  return { position, pointer, move, onKeyDown };
}
