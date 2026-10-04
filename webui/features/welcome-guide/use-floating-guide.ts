// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  computePosition,
  type Middleware,
  offset,
  type Placement,
  type Side,
  shift,
} from "@floating-ui/dom";
import {
  type Accessor,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  untrack,
} from "solid-js";
import type { GuideFocusArea, GuidePlacement } from "./lessons";

/** Open menus and dropdown lists the card must never cover, since the user is choosing from them. */
const POPOVER_SELECTOR =
  '[role="menu"], [role="listbox"], [data-hs-select-dropdown]';

/** Finds open menus and dropdown lists outside the guide card. */
function popoverBounds(): DOMRect[] {
  return [...document.querySelectorAll<HTMLElement>(POPOVER_SELECTOR)]
    .filter(
      (surface) =>
        !surface.closest(".nf-welcome-guide") &&
        surface.checkVisibility({
          opacityProperty: true,
          visibilityProperty: true,
        }),
    )
    .map((surface) => surface.getBoundingClientRect())
    .filter((rect) => rect.width > 0 && rect.height > 0);
}

/** Measures a grid row by joining all cells that share the target cell's row key, or the nearest row element. */
function rowBounds(element: Element): DOMRect | undefined {
  const key = element.closest<HTMLElement>("[data-grid-row-key]")?.dataset
    .gridRowKey;
  const cells = key
    ? [
        ...(element.closest("[data-panel-id]") ?? document).querySelectorAll(
          `[data-grid-row-key="${CSS.escape(key)}"]`,
        ),
      ]
    : [element.closest('[role="row"], tr')].filter(
        (row): row is Element => row !== null,
      );
  const rects = cells
    .map((cell) => cell.getBoundingClientRect())
    .filter((rect) => rect.width > 0 && rect.height > 0);
  if (rects.length === 0) return undefined;
  const left = Math.min(...rects.map((rect) => rect.left));
  const top = Math.min(...rects.map((rect) => rect.top));
  return new DOMRect(
    left,
    top,
    Math.max(...rects.map((rect) => rect.right)) - left,
    Math.max(...rects.map((rect) => rect.bottom)) - top,
  );
}

/** Serializes rectangles so placement can tell when protected surfaces moved. */
function rectsKey(rects: DOMRect[]): string {
  return rects
    .map((rect) => `${rect.x},${rect.y},${rect.width},${rect.height}`)
    .join(";");
}

/** Space between the card and what it points at. */
const GAP = 16;
/** Space the card keeps from the window edges. */
const MARGIN = 12;

/** Measures how much of a set of rectangles a card box covers. */
function covered(
  box: { x: number; y: number; width: number; height: number },
  rects: DOMRect[],
): number {
  return rects.reduce(
    (sum, rect) =>
      sum +
      Math.max(
        0,
        Math.min(box.x + box.width, rect.right) - Math.max(box.x, rect.left),
      ) *
        Math.max(
          0,
          Math.min(box.y + box.height, rect.bottom) - Math.max(box.y, rect.top),
        ),
    0,
  );
}

/** Measures the empty gap between a card box and a surface, independent of their sizes. */
function gap(
  box: { x: number; y: number; width: number; height: number },
  rect: DOMRect,
): number {
  return Math.hypot(
    Math.max(rect.left - box.x - box.width, box.x - rect.right, 0),
    Math.max(rect.top - box.y - box.height, box.y - rect.bottom, 0),
  );
}

/** Joins rectangles into the smallest rectangle containing all of them. */
function union(rects: DOMRect[]): DOMRect {
  const left = Math.min(...rects.map((rect) => rect.left));
  const top = Math.min(...rects.map((rect) => rect.top));
  return new DOMRect(
    left,
    top,
    Math.max(...rects.map((rect) => rect.right)) - left,
    Math.max(...rects.map((rect) => rect.bottom)) - top,
  );
}

/**
 * Lists placements in order of preference, each side centered first and then aligned to either end.
 * A side preference only offers left and right, so the card never moves below or above the target.
 */
function placementOrder(preference: GuidePlacement | undefined): Placement[] {
  const sides: Side[] =
    preference === "above"
      ? ["top", "right", "left", "bottom"]
      : preference === "side"
        ? ["right", "left"]
        : ["right", "left", "bottom", "top"];
  return sides.flatMap((side): Placement[] => [
    side,
    `${side}-start`,
    `${side}-end`,
  ]);
}

/** Progress of the avoidSurfaces middleware across Floating UI's placement resets. */
interface AvoidSurfacesData {
  index?: number;
  settled?: boolean;
  tried?: { placement: Placement; covered: number }[];
}

/**
 * Floating UI middleware that tries each placement in turn until the card covers none of the given
 * surfaces. When every placement covers something, it settles on the one covering the least.
 */
function avoidSurfaces(placements: Placement[], avoid: DOMRect[]): Middleware {
  return {
    name: "avoidSurfaces",
    fn({ x, y, placement, rects, middlewareData }) {
      const data = (middlewareData.avoidSurfaces ?? {}) as AvoidSurfacesData;
      const area = covered(
        { x, y, width: rects.floating.width, height: rects.floating.height },
        avoid,
      );
      if (data.settled || area === 0) return { data: { settled: true } };
      const tried = [...(data.tried ?? []), { placement, covered: area }];
      const index = (data.index ?? 0) + 1;
      if (index < placements.length)
        return {
          data: { index, tried },
          reset: { placement: placements[index] },
        };
      const best = tried.reduce((a, b) => (b.covered < a.covered ? b : a));
      return {
        data: { index, tried, settled: true },
        reset: { placement: best.placement },
      };
    },
  };
}

/** Places cards beside their target and preserves manual placement until the next step. */
export function useFloatingGuide(
  element: Accessor<HTMLElement | undefined>,
  step: Accessor<string>,
  anchor: Accessor<DOMRect | null>,
  selector: Accessor<string | undefined>,
  preference: Accessor<GuidePlacement | undefined>,
  keepVisible: Accessor<GuideFocusArea[] | undefined>,
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
        window.innerWidth - (element()?.offsetWidth ?? 360) - MARGIN,
      ),
    ),
    y: Math.max(
      12,
      Math.min(
        point.y,
        window.innerHeight - (element()?.offsetHeight ?? 400) - MARGIN,
      ),
    ),
  });
  let placing = 0;
  /**
   * Places the card beside its target with Floating UI. Each attempt walks the placements until the
   * card covers nothing it must leave clear. Attempts first anchor to the target, then to the target
   * together with the areas it must keep visible, and finally let the card cover the teaching panel
   * or Visualizer when nothing else fits.
   */
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
      setPosition(clamp({ x: window.innerWidth - width - MARGIN, y: 80 }));
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
    const focus = keepVisible();
    const row =
      focus?.includes("row") && targetElement
        ? rowBounds(targetElement)
        : undefined;
    const panelId = targetElement
      ?.closest<HTMLElement>("[data-panel-id]")
      ?.getAttribute("data-panel-id");
    const tab =
      focus?.includes("tab") && panelId
        ? document
            .querySelector(
              `[data-workspace-active="true"] .dv-tab[data-tab-panel-id="${CSS.escape(panelId)}"]`,
            )
            ?.getBoundingClientRect()
        : undefined;
    const kept = [
      ...(focus?.includes("panel") && panel ? [panel] : []),
      ...(tab && tab.width > 0 ? [tab] : []),
      ...(row ? [row] : []),
      ...(focus?.includes("visualizer") && visualizer ? [visualizer] : []),
    ];
    const popovers = popoverBounds();
    // The card never covers the action, an open dialog or menu, or an area the step asks the user to watch.
    const protect = [target, ...(dialog ? [dialog] : []), ...popovers, ...kept];
    // Without explicit focus areas, panel actions also prefer to leave their teaching panel and the Visualizer clear.
    const teaching = panel && focus === undefined ? panel : undefined;
    const prefer = [
      ...(teaching ? [teaching] : []),
      ...(visualizer && (panel || !anchor()) ? [visualizer] : []),
    ];
    /** Ranks a card position: covering a protected surface always costs more than covering a preferred one. */
    const cost = (point: { x: number; y: number }) => {
      const box = { ...point, width, height };
      return (
        covered(box, [target]) * 1_000_000 +
        covered(box, protect) * 10_000 +
        covered(box, prefer)
      );
    };
    const geometry = `${target.x},${target.y},${target.width},${target.height},${width},${height}|${rectsKey([...popovers, ...kept])}`;
    const current = untrack(position);
    const bounded = clamp(current);
    // Small result-list changes preserve placement; a large empty gap to a dialog requires reattachment.
    if (
      geometry === placedGeometry &&
      current.x === bounded.x &&
      current.y === bounded.y &&
      covered({ ...current, width, height }, protect) === 0 &&
      (!dialog || gap({ ...current, width, height }, dialog) <= 64)
    )
      return;
    const cluster = union([
      target,
      ...kept,
      ...(dialog ? [dialog] : []),
      ...(teaching ? [teaching] : []),
    ]);
    const attempts = [
      { reference: target, avoid: [...protect, ...prefer] },
      { reference: cluster, avoid: [...protect, ...prefer] },
      { reference: target, avoid: protect },
      { reference: cluster, avoid: protect },
    ];
    const placements = placementOrder(preference());
    const token = ++placing;
    void (async () => {
      const corners = [
        { x: MARGIN, y: 80 },
        { x: window.innerWidth - width - MARGIN, y: 80 },
        { x: MARGIN, y: window.innerHeight - height - MARGIN },
        {
          x: window.innerWidth - width - MARGIN,
          y: window.innerHeight - height - MARGIN,
        },
      ].map(clamp);
      let best = { point: corners[0], cost: Number.POSITIVE_INFINITY };
      for (const attempt of attempts) {
        const { reference, avoid } = attempt;
        const result = await computePosition(
          { getBoundingClientRect: () => reference },
          card,
          {
            strategy: "fixed",
            placement: placements[0],
            middleware: [
              offset(GAP),
              shift({ padding: MARGIN, crossAxis: true }),
              avoidSurfaces(placements, avoid),
            ],
          },
        );
        if (token !== placing) return;
        const point = clamp({ x: result.x, y: result.y });
        const score = cost(point);
        if (score < best.cost) best = { point, cost: score };
        if (score === 0) break;
      }
      for (const point of corners) {
        const score = cost(point);
        if (score < best.cost) best = { point, cost: score };
      }
      placedGeometry = geometry;
      setPosition(best.point);
    })();
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
    /** Reacts to dialogs and menus opening or closing without following unrelated app updates. */
    const pollDialog = window.setInterval(() => {
      const rect = dialogBounds();
      const key = rectsKey([...(rect ? [rect] : []), ...popoverBounds()]);
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
