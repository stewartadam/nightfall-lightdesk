// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  RollingTimingSamples,
  TIMING_SAMPLE_LIMIT,
  TIMING_WINDOW_MS,
} from "./rolling-timing-samples";

/** Checks exact tail percentiles and arithmetic averages for a known distribution. */
test("rolling timings calculate nearest-rank p95 and p99", () => {
  const samples = new RollingTimingSamples();
  for (let value = 1; value <= 100; value++) samples.record(value, value);
  assert.deepEqual(samples.summarize("test", 100), {
    name: "test",
    unit: "ms",
    count: 100,
    avgMs: 50.5,
    p90Ms: 90,
    p95Ms: 95,
    p99Ms: 99,
    maxMs: 100,
    lastMs: 100,
  });
});

/** Verifies capacity replacement, time expiry, and rejection of invalid input. */
test("rolling timings bound storage and expire stale samples", () => {
  const samples = new RollingTimingSamples();
  samples.record(1_000_000, 0);
  for (let value = 1; value <= TIMING_SAMPLE_LIMIT; value++)
    samples.record(value, 1);
  samples.record(Number.NaN, 1);
  samples.record(-1, 1);
  samples.record(1, Number.POSITIVE_INFINITY);
  const stats = samples.summarize("test", 1);
  assert.equal(stats?.count, TIMING_SAMPLE_LIMIT);
  assert.equal(stats?.maxMs, TIMING_SAMPLE_LIMIT);
  assert.equal(stats?.lastMs, TIMING_SAMPLE_LIMIT);
  assert.equal(samples.summarize("test", TIMING_WINDOW_MS + 2), undefined);
  samples.record(7, TIMING_WINDOW_MS + 3);
  assert.equal(samples.summarize("test", TIMING_WINDOW_MS + 3)?.count, 1);
});
