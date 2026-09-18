// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { durationToMs } from "./duration";
import { parseTimingFanInput, resolveTimingFanDuration } from "./timing-fan";

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
test("resolveTimingFanDuration interpolates fixed target durations", () => {
  const durations = parseTimingFanInput("0>5s");
  assert.ok(durations);

  assert.equal(durationToMs(resolveTimingFanDuration(durations, 0, 3)), 0);
  assert.equal(durationToMs(resolveTimingFanDuration(durations, 1, 3)), 2500);
  assert.equal(durationToMs(resolveTimingFanDuration(durations, 2, 3)), 5000);
});

/** Verifies multi-point timing fans resolve through waypoint segments. */
test("resolveTimingFanDuration interpolates manual waypoints", () => {
  const durations = parseTimingFanInput("0>5>0");
  assert.ok(durations);

  assert.equal(durationToMs(resolveTimingFanDuration(durations, 0, 3)), 0);
  assert.equal(durationToMs(resolveTimingFanDuration(durations, 1, 3)), 5000);
  assert.equal(durationToMs(resolveTimingFanDuration(durations, 2, 3)), 0);
  assert.equal(durationToMs(resolveTimingFanDuration(durations, 0, 5)), 0);
  assert.equal(durationToMs(resolveTimingFanDuration(durations, 1, 5)), 2500);
  assert.equal(durationToMs(resolveTimingFanDuration(durations, 2, 5)), 5000);
  assert.equal(durationToMs(resolveTimingFanDuration(durations, 3, 5)), 2500);
  assert.equal(durationToMs(resolveTimingFanDuration(durations, 4, 5)), 0);
});

/** Verifies single target fan application uses the first waypoint. */
test("resolveTimingFanDuration uses first waypoint for a single target", () => {
  const durations = parseTimingFanInput("2s>5s");
  assert.ok(durations);

  assert.equal(durationToMs(resolveTimingFanDuration(durations, 0, 1)), 2000);
});
