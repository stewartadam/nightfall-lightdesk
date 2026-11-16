// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { SessionHistoryEntry } from "../../../types";
import {
  filterSessionHistory,
  mergeSessionHistory,
  sessionHistorySources,
} from "./session-history";

/** Builds a history entry with the given id and overrides. */
function entry(
  id: number,
  overrides: Partial<SessionHistoryEntry> = {},
): SessionHistoryEntry {
  return {
    id,
    revision: id,
    at_ms: 0,
    kind: "Command",
    source: "Web UI",
    module: "ClipCommand",
    summary: `Play { id: ${id} }`,
    ...overrides,
  } as SessionHistoryEntry;
}

/** A page replaces changed entries, adds new ones, and drops what the engine no longer keeps. */
test("merges pages into the shown entries", () => {
  const shown = [entry(1), entry(2), entry(3)];
  const merged = mergeSessionHistory(shown, {
    entries: [entry(4), entry(2, { summary: "changed" })],
    revision: 5,
    session: 1,
    oldest_id: 2,
  });
  assert.deepEqual(
    merged.map((item) => item.id),
    [2, 3, 4],
  );
  assert.equal(merged[0].summary, "changed");
});

/** Filters combine source, failed commands and text, and sources are listed once each. */
test("filters entries and lists sources", () => {
  const entries = [
    entry(1),
    entry(2, {
      source: "Backup",
      module: "Backup",
      summary: "Took over output",
    }),
    entry(3, { outcome: { succeeded: false, message: "Nope" } }),
  ];
  assert.deepEqual(
    filterSessionHistory(entries, {
      source: "Backup",
      failedOnly: false,
      text: "",
    }).map((item) => item.id),
    [2],
  );
  assert.deepEqual(
    filterSessionHistory(entries, {
      source: "",
      failedOnly: true,
      text: "",
    }).map((item) => item.id),
    [3],
  );
  assert.deepEqual(
    filterSessionHistory(entries, {
      source: "",
      failedOnly: false,
      text: "took",
    }).map((item) => item.id),
    [2],
  );
  assert.deepEqual(sessionHistorySources(entries), ["Backup", "Web UI"]);
});
