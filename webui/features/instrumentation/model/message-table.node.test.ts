// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  compareMessageTypeRows,
  formatMeasureName,
  type MessageTypeRow,
  messageSortIndicator,
  nextMessageSort,
} from "./message-table";

const ROWS: MessageTypeRow[] = [
  [
    "ParameterState",
    {
      count: 5,
      ratePerSec: 10,
      avgDecodeMs: 2,
      avgProcessMs: 4,
      dropped: 0,
    },
  ],
  [
    "CueList",
    {
      count: 2,
      ratePerSec: 1,
      avgDecodeMs: 3,
      avgProcessMs: 5,
      dropped: 1,
    },
  ],
];

/** Verifies measure prefixes are removed only from the start of names. */
test("formatMeasureName removes the nightfall timing scope prefix", () => {
  assert.equal(
    formatMeasureName("nightfall:timeline:render"),
    "timeline:render",
  );
  assert.equal(
    formatMeasureName("browser:nightfall:render"),
    "browser:nightfall:render",
  );
});

/** Verifies sort changes use operator-friendly default directions. */
test("nextMessageSort toggles active columns and defaults numeric sorts descending", () => {
  assert.deepEqual(
    nextMessageSort({ column: "type", direction: "asc" }, "type"),
    { column: "type", direction: "desc" },
  );
  assert.deepEqual(
    nextMessageSort({ column: "type", direction: "asc" }, "count"),
    { column: "count", direction: "desc" },
  );
});

/** Verifies indicators and row comparison follow the active sort. */
test("message sort helpers project active direction and ordered rows", () => {
  const sort = { column: "ratePerSec", direction: "desc" } as const;
  assert.equal(messageSortIndicator(sort, "ratePerSec"), "▼");
  assert.equal(messageSortIndicator(sort, "type"), "");
  assert.deepEqual(
    [...ROWS]
      .sort((left, right) =>
        compareMessageTypeRows(left, right, sort.column, sort.direction),
      )
      .map(([type]) => type),
    ["ParameterState", "CueList"],
  );
});
