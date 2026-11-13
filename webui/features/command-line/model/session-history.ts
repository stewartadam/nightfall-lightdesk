// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { SessionHistoryEntry, SessionHistoryPage } from "../../../types";

/** Which session history entries to show. */
export interface SessionHistoryFilter {
  /** Source to show, such as `Web UI` or `Backup`, or empty for every source. */
  source: string;
  /** Shows only commands that failed. */
  failedOnly: boolean;
  /** Text the entry's module or summary must contain, ignoring case. */
  text: string;
}

/**
 * Merges a page read from the engine into the entries already shown: changed entries replace
 * their old copy, entries the engine dropped from its history are dropped here too, and the
 * result is ordered oldest first.
 */
export function mergeSessionHistory(
  current: readonly SessionHistoryEntry[],
  page: SessionHistoryPage,
): SessionHistoryEntry[] {
  const byId = new Map<number, SessionHistoryEntry>();
  for (const entry of current) byId.set(entry.id, entry);
  for (const entry of page.entries) byId.set(entry.id, entry);
  const oldest = page.oldest_id ?? Number.POSITIVE_INFINITY;
  return [...byId.values()]
    .filter((entry) => entry.id >= oldest)
    .sort((a, b) => a.id - b.id);
}

/** Returns the entries that match `filter`, keeping their order. */
export function filterSessionHistory(
  entries: readonly SessionHistoryEntry[],
  filter: SessionHistoryFilter,
): SessionHistoryEntry[] {
  const text = filter.text.trim().toLowerCase();
  return entries.filter(
    (entry) =>
      (!filter.source || entry.source === filter.source) &&
      (!filter.failedOnly || entry.outcome?.succeeded === false) &&
      (!text ||
        entry.summary.toLowerCase().includes(text) ||
        entry.module.toLowerCase().includes(text)),
  );
}

/** Lists the distinct sources among `entries`, sorted by name, for the source filter. */
export function sessionHistorySources(
  entries: readonly SessionHistoryEntry[],
): string[] {
  return [...new Set(entries.map((entry) => entry.source))].sort((a, b) =>
    a.localeCompare(b),
  );
}

/** Formats a Unix time in milliseconds as a local time of day with milliseconds. */
export function sessionHistoryTime(atMs: number): string {
  const at = new Date(atMs);
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}.${pad(at.getMilliseconds(), 3)}`;
}
