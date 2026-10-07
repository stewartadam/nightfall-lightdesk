// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { persistentJSON } from "@nanostores/persistent";

/** Panels shown as tabs in the compact tab bar; the rest are reached from the Panels sheet. */
export const COMPACT_PINNED_TAB_COUNT = 4;

/**
 * The phone's panel order by panel ID. The first open panels in this order are
 * the pinned tabs. IDs of closed panels are kept so a reopened panel returns
 * to its place.
 */
export const compactPanelOrderPreference = persistentJSON<string[]>(
  "nightfall-compact-panel-order",
  [],
);

/** Reads the saved order, ignoring storage that does not hold a list of IDs. */
export function savedCompactPanelOrder(): string[] {
  const saved: unknown = compactPanelOrderPreference.get();
  return Array.isArray(saved)
    ? saved.filter((id): id is string => typeof id === "string")
    : [];
}

/**
 * Orders open panels by the saved order, then appends panels the saved order
 * does not know yet in their workspace order.
 */
export function orderCompactPanelIds(
  openIds: readonly string[],
  savedOrder: readonly string[],
): string[] {
  const open = new Set(openIds);
  const known = savedOrder.filter((id) => open.has(id));
  const knownSet = new Set(known);
  return [...known, ...openIds.filter((id) => !knownSet.has(id))];
}

/**
 * Moves one open panel to `toIndex` among the open panels and returns the new
 * saved order. Saved IDs of panels that are not open stay in their slots, so
 * reordering the open panels never pushes a closed panel out of its pin.
 */
export function moveCompactPanel(
  openOrder: readonly string[],
  savedOrder: readonly string[],
  id: string,
  toIndex: number,
): string[] {
  const from = openOrder.indexOf(id);
  if (from < 0) return [...savedOrder];
  const next = openOrder.filter((panelId) => panelId !== id);
  const target = Math.max(0, Math.min(toIndex, next.length));
  next.splice(target, 0, id);
  const open = new Set(openOrder);
  const saved = new Set(savedOrder);
  // Open panels fill the slots open panels held before, in their new order.
  const slots = [
    ...savedOrder,
    ...openOrder.filter((panelId) => !saved.has(panelId)),
  ];
  let nextOpen = 0;
  return slots.map((panelId) =>
    open.has(panelId) ? next[nextOpen++] : panelId,
  );
}
