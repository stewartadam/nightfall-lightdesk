// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeTapIntervals,
  analyzeTapPattern,
  bpmFromInterval,
  normalizeTapPatternDetectionOptions,
  type TapEvent,
} from "./tap-pattern-analysis";

/** Builds deterministic tap events from relative millisecond positions. */
function tapsFromTimes(timesMs: number[]): TapEvent[] {
  return timesMs.map((timeMs, id) => ({ id, timeMs }));
}

/** Builds deterministic tap events with keyboard identities. */
function tapsFromKeyedTimes(entries: Array<[number, string]>): TapEvent[] {
  return entries.map(([timeMs, key], id) => ({ id, timeMs, key }));
}

test("bpmFromInterval converts tap interval to tempo", () => {
  assert.equal(bpmFromInterval(500), 120);
  assert.equal(bpmFromInterval(null), null);
});

test("analyzeTapIntervals reports low variation for steady pulse taps", () => {
  const stats = analyzeTapIntervals(tapsFromTimes([0, 500, 1000, 1500, 2000]));

  assert.equal(stats.count, 4);
  assert.equal(stats.medianMs, 500);
  assert.equal(stats.coefficientOfVariation, 0);
});

test("analyzeTapPattern treats even taps as tap-tempo pulse", () => {
  const analysis = analyzeTapPattern(
    tapsFromTimes([100, 600, 1100, 1600, 2100]),
  );

  assert.equal(analysis.status, "pulse");
  assert.equal(analysis.pulseBpm, 120);
  assert.equal(analysis.pattern, null);
  assert.deepEqual(analysis.relativeTapsMs, [0, 500, 1000, 1500, 2000]);
});

test("analyzeTapPattern detects a repeated three-step loop", () => {
  const analysis = analyzeTapPattern(
    tapsFromTimes([0, 310, 690, 2000, 2310, 2690, 4000, 4310, 4690]),
  );

  assert.equal(analysis.status, "pattern");
  assert.ok(analysis.pattern);
  assert.equal(analysis.pattern.clusters.length, 3);
  assert.equal(Math.round(analysis.pattern.loopLengthMs), 2000);
  assert.ok(analysis.pattern.confidence > 0.9);
  assert.deepEqual(
    analysis.pattern.clusters.map((cluster) => Math.round(cluster.phaseMs)),
    [0, 310, 690],
  );
});

test("analyzeTapPattern keeps the first tap in the first detected cluster", () => {
  const timesMs = Array.from({ length: 4 }).flatMap((_, cycleIndex) =>
    [0, 195, 385, 1035, 1230, 1420, 1889, 2078, 2278].map(
      (phaseMs) => cycleIndex * 4000 + phaseMs,
    ),
  );
  const analysis = analyzeTapPattern(tapsFromTimes(timesMs));

  assert.equal(analysis.status, "pattern");
  assert.ok(analysis.pattern);
  assert.equal(analysis.pattern.clusters[0].id, 0);
  assert.equal(analysis.pattern.assignments[0].tapId, 0);
  assert.equal(analysis.pattern.assignments[0].clusterId, 0);
});

test("analyzeTapPattern counts elapsed loop spans for cycle count", () => {
  const analysis = analyzeTapPattern(
    tapsFromTimes([
      0, 250, 500, 900, 1000, 1250, 1500, 1900, 2000, 2250, 2500, 2900, 3000,
      3250, 3500, 3900,
    ]),
  );

  assert.equal(analysis.status, "pattern");
  assert.ok(analysis.pattern);
  assert.equal(Math.round(analysis.pattern.loopLengthMs), 1000);
  assert.equal(analysis.pattern.repeatCount, 4);
  assert.equal(
    Math.max(
      ...analysis.pattern.assignments.map(
        (assignment) => assignment.repeatIndex,
      ),
    ),
    3,
  );
});

test("analyzeTapPattern prefers the fundamental repeated loop", () => {
  const taps = tapsFromTimes(
    Array.from({ length: 6 }).flatMap((_, cycleIndex) =>
      [0, 310, 690].map((phaseMs) => cycleIndex * 2000 + phaseMs),
    ),
  );
  const balancedAnalysis = analyzeTapPattern(taps);
  const coarseAnalysis = analyzeTapPattern(taps, { granularity: 0 });

  assert.equal(balancedAnalysis.status, "pattern");
  assert.ok(balancedAnalysis.pattern);
  assert.equal(Math.round(balancedAnalysis.pattern.loopLengthMs), 2000);
  assert.equal(balancedAnalysis.pattern.repeatCount, 6);
  assert.equal(coarseAnalysis.status, "pattern");
  assert.ok(coarseAnalysis.pattern);
  assert.ok(
    coarseAnalysis.pattern.loopLengthMs > balancedAnalysis.pattern.loopLengthMs,
  );
  assert.ok(
    coarseAnalysis.pattern.repeatCount < balancedAnalysis.pattern.repeatCount,
  );
});

test("analyzeTapPattern keeps repeated ordered taps on the same steps", () => {
  const analysis = analyzeTapPattern(
    tapsFromTimes(
      Array.from({ length: 6 }).flatMap((_, cycleIndex) =>
        [0, 208, 415].map((phaseMs) => cycleIndex * 1097 + phaseMs),
      ),
    ),
  );

  assert.equal(analysis.status, "pattern");
  assert.ok(analysis.pattern);
  assert.equal(Math.round(analysis.pattern.loopLengthMs), 1097);
  assert.deepEqual(
    analysis.pattern.assignments
      .slice(0, 9)
      .map((assignment) => assignment.clusterId),
    [0, 1, 2, 0, 1, 2, 0, 1, 2],
  );
  assert.equal(analysis.pattern.orderConsistency, 1);
});

test("analyzeTapPattern detects loose two-step tap repetitions", () => {
  const analysis = analyzeTapPattern(
    tapsFromTimes([
      0, 189.59999999403954, 947.3999999910593, 1139.0999999940395,
      1847.7000000029802, 2045.0999999940395, 2732.7000000029802,
      2932.2999999970198, 3622.5, 3814.0999999940395, 4425.399999991059,
      4650.79999999702, 5322.5, 5522.399999991059, 6182.0999999940395,
      6389.899999991059,
    ]),
  );

  assert.equal(analysis.status, "pattern");
  assert.ok(analysis.pattern);
  assert.equal(analysis.pattern.clusters.length, 2);
  assert.equal(analysis.pattern.repeatCount, 8);
  assert.deepEqual(
    analysis.pattern.assignments
      .slice(0, 8)
      .map((assignment) => assignment.clusterId),
    [0, 1, 0, 1, 0, 1, 0, 1],
  );
});

/** Validates that lopsided loops are not rejected by median interval filtering. */
test("analyzeTapPattern detects lopsided two-step loop repetitions", () => {
  const analysis = analyzeTapPattern(
    tapsFromTimes([0, 900, 1000, 1900, 2000, 2900]),
  );

  assert.equal(analysis.status, "pattern");
  assert.ok(analysis.pattern);
  assert.equal(Math.round(analysis.pattern.loopLengthMs), 1000);
  assert.equal(analysis.pattern.clusters.length, 2);
  assert.deepEqual(
    analysis.pattern.assignments.map((assignment) => assignment.clusterId),
    [0, 1, 0, 1, 0, 1],
  );
});

/** Validates that keyed identity repeats survive loose tempo drift. */
test("analyzeTapPattern detects loose keyed two-step tap repetitions", () => {
  const analysis = analyzeTapPattern(
    tapsFromKeyedTimes([
      [0, "a"],
      [189.59999999403954, "s"],
      [947.3999999910593, "a"],
      [1139.0999999940395, "s"],
      [1847.7000000029802, "a"],
      [2045.0999999940395, "s"],
      [2732.7000000029802, "a"],
      [2932.2999999970198, "s"],
      [3622.5, "a"],
      [3814.0999999940395, "s"],
      [4425.399999991059, "a"],
      [4650.79999999702, "s"],
      [5322.5, "a"],
      [5522.399999991059, "s"],
      [6182.0999999940395, "a"],
      [6389.899999991059, "s"],
    ]),
  );

  assert.equal(analysis.status, "pattern");
  assert.ok(analysis.pattern);
  assert.equal(analysis.pattern.clusters.length, 2);
  assert.equal(analysis.pattern.repeatCount, 8);
  assert.deepEqual(
    analysis.pattern.assignments.map((assignment) => assignment.clusterId),
    [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1],
  );
});

/** Validates that keyed loops use the observed full key-cycle duration. */
test("analyzeTapPattern counts keyed repeat rows from full key cycles", () => {
  const analysis = analyzeTapPattern(
    tapsFromKeyedTimes([
      [0, "a"],
      [189.59999999403954, "s"],
      [947.3999999910593, "a"],
      [1139.0999999940395, "s"],
      [1847.7000000029802, "a"],
      [2045.0999999940395, "s"],
      [2732.7000000029802, "a"],
      [2932.2999999970198, "s"],
      [3622.5, "a"],
      [3814.0999999940395, "s"],
      [4425.399999991059, "a"],
      [4650.79999999702, "s"],
      [5322.5, "a"],
      [5522.399999991059, "s"],
      [6182.0999999940395, "a"],
      [6389.899999991059, "s"],
    ]),
    { granularity: 100 },
  );

  assert.equal(analysis.status, "pattern");
  assert.ok(analysis.pattern);
  assert.equal(Math.round(analysis.pattern.loopLengthMs), 886);
  assert.equal(analysis.pattern.repeatCount, 8);
  assert.ok(analysis.pattern.clusters[0].averageErrorMs > 0);
});

test("analyzeTapPattern prefers repeated keyed phrases over unstable key cycles", () => {
  const taps = tapsFromKeyedTimes([
    [0, "a"],
    [197.1000000089407, "s"],
    [352, "d"],
    [976.5, "a"],
    [1169.6000000089407, "s"],
    [1342.6000000089407, "d"],
    [1741.4000000059605, "a"],
    [1933.2000000029802, "s"],
    [2114.7999999970198, "d"],
    [2991.2999999970198, "a"],
    [3181.4000000059605, "s"],
    [3391.4000000059605, "d"],
    [4048.7999999970198, "a"],
    [4252.9000000059605, "s"],
    [4444.5, "d"],
    [4834.79999999702, "a"],
    [5031.4000000059605, "s"],
    [5208.79999999702, "d"],
  ]);
  const analysis = analyzeTapPattern(taps, { sensitivity: 53 });
  const stricterAnalysis = analyzeTapPattern(taps, { sensitivity: 45 });

  assert.equal(analysis.status, "pattern");
  assert.ok(analysis.pattern);
  assert.ok(stricterAnalysis.pattern);
  assert.equal(analysis.pattern.clusters.length, 9);
  assert.equal(analysis.pattern.repeatCount, 2);
  assert.equal(Math.round(analysis.pattern.loopLengthMs), 3083);
  assert.equal(
    stricterAnalysis.pattern.confidence,
    analysis.pattern.confidence,
  );
  assert.deepEqual(
    analysis.pattern.assignments.map((assignment) => assignment.repeatIndex),
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  );
});

/** Validates that incomplete noisy rows do not report inflated confidence. */
test("analyzeTapPattern discounts confidence for incomplete noisy repeats", () => {
  const analysis = analyzeTapPattern(
    tapsFromTimes([
      0, 441.70000000298023, 927.7999999970198, 1291.3999999910593,
      1622.5999999940395, 1857.3999999910593, 2322.5999999940395,
      2778.8999999910593, 3138.8999999910593, 3486.0999999940395, 3737,
      4200.29999999702, 4662.29999999702, 5030.0999999940395, 5373.29999999702,
      5627.79999999702, 7733.79999999702, 8212.89999999106, 8661.09999999404,
      9027.79999999702, 9369.89999999106, 9602.70000000298, 10082.89999999106,
      10538.79999999702, 10889, 11231.5, 11471.89999999106, 11957.70000000298,
      12402.70000000298, 12757.09999999404, 13098.89999999106,
      13352.70000000298,
    ]),
    { sensitivity: 52, granularity: 57 },
  );

  assert.equal(analysis.status, "pattern");
  assert.ok(analysis.pattern);
  assert.equal(Math.round(analysis.pattern.loopLengthMs), 3338);
  assert.equal(analysis.pattern.clusters.length, 9);
  assert.ok(analysis.pattern.confidence < 0.75);
});

/** Validates that repeated same-key tempo taps stay a pulse. */
test("analyzeTapPattern treats same-key steady taps as tap-tempo pulse", () => {
  const analysis = analyzeTapPattern(
    tapsFromKeyedTimes([
      [0, "a"],
      [500, "a"],
      [1000, "a"],
      [1500, "a"],
      [2000, "a"],
    ]),
  );

  assert.equal(analysis.status, "pulse");
  assert.equal(analysis.pulseBpm, 120);
  assert.equal(analysis.pattern, null);
});

/** Validates that mixed key and click taps can still form steady patterns. */
test("analyzeTapPattern preserves mixed key and click steady patterns", () => {
  const analysis = analyzeTapPattern([
    { id: 0, timeMs: 0, key: "a" },
    { id: 1, timeMs: 500 },
    { id: 2, timeMs: 1000, key: "a" },
    { id: 3, timeMs: 1500 },
    { id: 4, timeMs: 2000, key: "a" },
    { id: 5, timeMs: 2500 },
  ]);

  assert.equal(analysis.status, "pattern");
  assert.ok(analysis.pattern);
  assert.equal(analysis.pattern.clusters.length, 2);
  assert.deepEqual(
    analysis.pattern.assignments.map((assignment) => assignment.clusterId),
    [0, 1, 0, 1, 0, 1],
  );
});

/** Validates that keyboard identity can form clusters even for steady taps. */
test("analyzeTapPattern clusters steady keyed taps by key identity", () => {
  const analysis = analyzeTapPattern(
    tapsFromKeyedTimes([
      [0, "a"],
      [500, "b"],
      [1000, "a"],
      [1500, "b"],
      [2000, "a"],
      [2500, "b"],
    ]),
  );

  assert.equal(analysis.status, "pattern");
  assert.ok(analysis.pattern);
  assert.equal(analysis.pattern.clusters.length, 2);
  assert.equal(analysis.pattern.repeatCount, 3);
  assert.deepEqual(
    analysis.pattern.assignments.map((assignment) => assignment.clusterId),
    [0, 1, 0, 1, 0, 1],
  );
});

/** Validates that wrong keys cannot be rescued by timing-only detection. */
test("analyzeTapPattern rejects inconsistent keyed repetitions", () => {
  const wrongNewKeyAnalysis = analyzeTapPattern(
    tapsFromKeyedTimes([
      [0, "a"],
      [300, "b"],
      [600, "c"],
      [1000, "a"],
      [1300, "b"],
      [1600, "c"],
      [2000, "a"],
      [2300, "b"],
      [2600, "x"],
    ]),
  );
  const wrongExistingKeyAnalysis = analyzeTapPattern(
    tapsFromKeyedTimes([
      [0, "a"],
      [300, "b"],
      [600, "c"],
      [1000, "a"],
      [1300, "b"],
      [1600, "c"],
      [2000, "a"],
      [2300, "b"],
      [2600, "a"],
    ]),
  );

  assert.equal(wrongNewKeyAnalysis.status, "searching");
  assert.equal(wrongNewKeyAnalysis.pattern, null);
  assert.equal(wrongExistingKeyAnalysis.status, "searching");
  assert.equal(wrongExistingKeyAnalysis.pattern, null);
});

test("analyzeTapPattern detects noisy repeated triplets", () => {
  const analysis = analyzeTapPattern(
    tapsFromTimes([
      0, 196.20000000298023, 398.80000001192093, 1027.4000000059605,
      1209.4000000059605, 1400.4000000059605, 1881.5, 2075.4000000059605,
      2258.300000011921, 3370.2000000029802, 3574.800000011921,
      3756.300000011921, 4359.600000008941, 4556.300000011921, 4748, 5237,
      5431.5, 5611.20000000298,
    ]),
    { sensitivity: 66, granularity: 58 },
  );

  assert.equal(analysis.status, "pattern");
  assert.ok(analysis.pattern);
  assert.equal(analysis.pattern.clusters.length, 9);
  assert.deepEqual(
    analysis.pattern.assignments
      .slice(0, 9)
      .map((assignment) => assignment.clusterId),
    analysis.pattern.assignments
      .slice(9, 18)
      .map((assignment) => assignment.clusterId),
  );
  assert.equal(analysis.pattern.orderConsistency, 1);
});

test("analyzeTapPattern detects repeated noisy triplets across four cycles", () => {
  const analysis = analyzeTapPattern(
    tapsFromTimes([
      0, 192.3999999910593, 385.8999999910593, 1038.699999988079,
      1227.8999999910593, 1425.3999999910593, 1855.199999988079,
      2050.2999999970198, 2238.5999999940395, 3260.199999988079,
      3469.199999988079, 3651.199999988079, 4384.199999988079, 4580.29999999702,
      4771.899999991059, 5218.5999999940395, 5410.79999999702,
      5619.0999999940395, 6663.5, 6868.0999999940395, 7059.29999999702,
      7660.79999999702, 7853.199999988079, 8046.899999991059, 8505.29999999702,
      8685.09999999404, 8891, 9977.89999999106, 10165.89999999106,
      10346.79999999702, 10975.5, 11165.699999988079, 11344.199999988079,
      11760.199999988079, 11940.79999999702, 12124,
    ]),
    { sensitivity: 50, granularity: 73 },
  );

  assert.equal(analysis.status, "pattern");
  assert.ok(analysis.pattern);
  assert.equal(analysis.pattern.clusters.length, 9);
  assert.equal(analysis.pattern.repeatCount, 4);
  assert.ok(analysis.pattern.clusters[0].averageErrorMs > 0);
  for (let repeatIndex = 0; repeatIndex < 4; repeatIndex += 1) {
    assert.deepEqual(
      analysis.pattern.assignments
        .slice(repeatIndex * 9, repeatIndex * 9 + 9)
        .map((assignment) => assignment.clusterId),
      [0, 1, 2, 3, 4, 5, 6, 7, 8],
    );
  }
});

/** Validates that coarser granularity can select a longer repeated phrase. */
test("analyzeTapPattern exposes longer repeated phrases at coarse granularity", () => {
  const analysis = analyzeTapPattern(
    tapsFromTimes([
      0, 192.3999999910593, 385.8999999910593, 1038.699999988079,
      1227.8999999910593, 1425.3999999910593, 1855.199999988079,
      2050.2999999970198, 2238.5999999940395, 3260.199999988079,
      3469.199999988079, 3651.199999988079, 4384.199999988079, 4580.29999999702,
      4771.899999991059, 5218.5999999940395, 5410.79999999702,
      5619.0999999940395, 6663.5, 6868.0999999940395, 7059.29999999702,
      7660.79999999702, 7853.199999988079, 8046.899999991059, 8505.29999999702,
      8685.09999999404, 8891, 9977.89999999106, 10165.89999999106,
      10346.79999999702, 10975.5, 11165.699999988079, 11344.199999988079,
      11760.199999988079, 11940.79999999702, 12124,
    ]),
    { sensitivity: 68, granularity: 47 },
  );

  assert.equal(analysis.status, "pattern");
  assert.ok(analysis.pattern);
  assert.equal(analysis.pattern.clusters.length, 18);
  assert.equal(analysis.pattern.repeatCount, 2);
  assert.ok(analysis.pattern.loopLengthMs > 6000);
  assert.deepEqual(
    analysis.pattern.assignments
      .slice(0, 18)
      .map((assignment) => assignment.clusterId),
    analysis.pattern.assignments
      .slice(18, 36)
      .map((assignment) => assignment.clusterId),
  );
});

test("normalizeTapPatternDetectionOptions clamps slider values", () => {
  assert.deepEqual(
    normalizeTapPatternDetectionOptions({
      sensitivity: -25,
      granularity: 125,
    }),
    {
      sensitivity: 0,
      granularity: 100,
    },
  );
});

test("analyzeTapPattern waits for more taps when no interval exists", () => {
  const analysis = analyzeTapPattern(tapsFromTimes([250]));

  assert.equal(analysis.status, "waiting");
  assert.equal(analysis.pulseBpm, null);
  assert.equal(analysis.pattern, null);
});
