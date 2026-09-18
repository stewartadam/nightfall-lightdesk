// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { Item } from "../../../lib/data-grid-types";

export const ARROW_KEY_DELTAS: Record<string, readonly [number, number]> = {
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
};

/** Returns whether a key press can seed text editing for the active cell. */
export function isPrintableEditKey(event: KeyboardEvent): boolean {
  return (
    event.key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey
  );
}

/** Normalizes browser-specific space key values. */
export function isSpaceKey(event: KeyboardEvent): boolean {
  return event.key === " " || event.key === "Space";
}

/** Returns whether displayed text marks a primary cell as expandable. */
export function isExpandablePrimaryCellText(text: string): boolean {
  return text.startsWith("▶ ") || text.startsWith("▼ ");
}

/** Clamps a row or column index into a valid grid range. */
export function clampIndex(value: number, maxExclusive: number): number {
  if (maxExclusive <= 0) return 0;
  return Math.max(0, Math.min(value, maxExclusive - 1));
}

/** Reads a grid cell coordinate from a rendered cell element. */
function cellFromElement(element: Element | null): Item | undefined {
  const cellElement = element?.closest<HTMLElement>(
    '[role="gridcell"][id^="tanstack-cell-"]',
  );
  const match = cellElement?.id.match(/^tanstack-cell-(\d+)-(\d+)$/);
  if (!match) return undefined;

  const col = Number(match[1]);
  const row = Number(match[2]);
  if (!Number.isFinite(col) || !Number.isFinite(row)) return undefined;
  return [col, row];
}

/** Reads the grid cell coordinate under a viewport point. */
export function cellFromPoint(
  clientX: number,
  clientY: number,
): Item | undefined {
  return cellFromElement(document.elementFromPoint(clientX, clientY));
}

/** Returns whether a pointer target should own interaction instead of the grid. */
export function isInteractivePointerTarget(
  target: EventTarget | null,
): boolean {
  return (
    target instanceof Element &&
    target.closest("button,input,select,textarea") !== null
  );
}

/** Returns whether a keyboard event originated from an editable form target. */
export function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.closest("input,textarea,select") !== null ||
      target.isContentEditable)
  );
}
