// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

export type PaletteNavigationKey =
  | "ArrowDown"
  | "ArrowUp"
  | "PageDown"
  | "PageUp";

/** Returns whether a keyboard key is handled by palette list navigation. */
export function isPaletteNavigationKey(
  key: string,
): key is PaletteNavigationKey {
  return (
    key === "ArrowDown" ||
    key === "ArrowUp" ||
    key === "PageDown" ||
    key === "PageUp"
  );
}

/** Estimates how many palette rows fit in the visible scroll container. */
export function visiblePaletteRowCount(
  scrollContainer: HTMLElement | undefined,
  selectedRow: HTMLElement | undefined,
  fallback = 10,
): number {
  if (!scrollContainer || !selectedRow || selectedRow.offsetHeight <= 0) {
    return fallback;
  }

  return Math.max(
    1,
    Math.floor(scrollContainer.clientHeight / selectedRow.offsetHeight),
  );
}

/** Returns the next highlighted index for arrow and page navigation keys. */
export function nextPaletteIndex(
  currentIndex: number,
  count: number,
  key: PaletteNavigationKey,
  pageSize: number,
): number {
  if (count <= 0) return 0;

  switch (key) {
    case "ArrowDown":
      return (currentIndex + 1) % count;
    case "ArrowUp":
      return (currentIndex - 1 + count) % count;
    case "PageDown":
      return Math.min(currentIndex + pageSize, count - 1);
    case "PageUp":
      return Math.max(currentIndex - pageSize, 0);
  }
}
