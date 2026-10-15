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

/** Verifies the default order lists the busiest message types first and breaks rate ties by name. */
test("compareMessageTypeRows orders by rate, then type", () => {
  const tied: MessageTypeRow = ["Alpha", { ...ROWS[1]![1], ratePerSec: 1 }];
  assert.deepEqual(
    [...ROWS, tied].sort(compareMessageTypeRows).map(([type]) => type),
    ["ParameterState", "Alpha", "CueList"],
  );
});
