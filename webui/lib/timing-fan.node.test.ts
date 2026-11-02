// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { strict as assert } from "node:assert";
import test, { before } from "node:test";
import { durationToMs } from "./duration";
import { fanTimingDurations, parseTimingFanInput } from "./timing-fan";
import { loadWasmBridge } from "./wasm-module";

/** Loads the WASM bridge that resolves timing fans before any fan is spread. */
before(async () => {
  await loadWasmBridge();
});

/** Resolves a timing fan across `total` targets as milliseconds per target. */
function fanMs(
  durations: Parameters<typeof fanTimingDurations>[0],
  total: number,
) {
  return fanTimingDurations(durations, total)?.map(durationToMs);
}

/** Verifies timing fan parsing accepts command-line style duration ranges. */
test("parseTimingFanInput parses duration waypoints", () => {
  const durations = parseTimingFanInput("0>5s");
  assert.ok(durations);
  assert.deepEqual(durations.map(durationToMs), [0, 5000]);

  const mixedUnits = parseTimingFanInput("500ms > 1s > 120bpm");
  assert.ok(mixedUnits);
  assert.deepEqual(mixedUnits.map(durationToMs), [500, 1000, 500]);
});

/** Verifies invalid timing fans are rejected without falling back to clears. */
test("parseTimingFanInput rejects invalid fan syntax", () => {
  assert.equal(parseTimingFanInput("5s"), null);
  assert.equal(parseTimingFanInput("0>>5s"), null);
  assert.equal(parseTimingFanInput(">5s"), null);
  assert.equal(parseTimingFanInput("0>"), null);
  assert.equal(parseTimingFanInput("0>-1s"), null);
});

/** Verifies two-point timing fans resolve fixed durations across target indexes. */
test("fanTimingDurations interpolates fixed target durations", () => {
  const durations = parseTimingFanInput("0>5s");
  assert.ok(durations);

  assert.deepEqual(fanMs(durations, 3), [0, 2500, 5000]);
});

/** Verifies multi-point timing fans resolve through waypoint segments. */
test("fanTimingDurations interpolates manual waypoints", () => {
  const durations = parseTimingFanInput("0>5>0");
  assert.ok(durations);

  assert.deepEqual(fanMs(durations, 3), [0, 5000, 0]);
  assert.deepEqual(fanMs(durations, 5), [0, 2500, 5000, 2500, 0]);
});

/** Verifies single target fan application uses the first waypoint. */
test("fanTimingDurations uses first waypoint for a single target", () => {
  const durations = parseTimingFanInput("2s>5s");
  assert.ok(durations);

  assert.deepEqual(fanMs(durations, 1), [2000]);
});
