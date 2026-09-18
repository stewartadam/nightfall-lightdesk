// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

export interface TapEvent {
  id: number;
  timeMs: number;
  key?: string;
}

export interface TapIntervalStats {
  count: number;
  medianMs: number | null;
  meanMs: number | null;
  coefficientOfVariation: number | null;
}

export interface TapPatternCluster {
  id: number;
  phaseMs: number;
  tapIds: number[];
  averageErrorMs: number;
}

export interface TapPatternAssignment {
  tapId: number;
  clusterId: number;
  repeatIndex: number;
  phaseMs: number;
  errorMs: number;
}

interface TapPatternCandidate {
  loopLengthMs: number;
  confidence: number;
  rankScore?: number;
  averageErrorMs: number;
  repeatedTapRatio: number;
  orderConsistency: number;
  clusters: TapPatternCluster[];
  assignments: TapPatternAssignment[];
  repeatCount: number;
  strideSupported: boolean;
}

export interface TapPatternDetectionOptions {
  sensitivity: number;
  granularity: number;
}

export interface TapPatternAnalysis {
  relativeTapsMs: number[];
  intervalStats: TapIntervalStats;
  pulseBpm: number | null;
  pattern: TapPatternCandidate | null;
  status: "waiting" | "pulse" | "pattern" | "searching";
}

interface PhaseSample {
  tap: TapEvent;
  phaseMs: number;
  unwrappedPhaseMs: number;
}

interface ClusterAccumulator {
  samples: PhaseSample[];
  centerMs: number;
}

interface LoopCandidate {
  loopLengthMs: number;
  strideLength: number | null;
  strideSupported: boolean;
}

const MAX_ORDERED_STRIDE_CANDIDATE_TAPS = 64;
const MAX_ORDERED_STRIDE_LOOP_VARIATION = 0.12;
const MIN_LOOP_REPEAT_COUNT = 2;
const MIN_PATTERN_CLUSTER_COUNT = 2;
const STEADY_PULSE_VARIATION_LIMIT = 0.08;
export const DEFAULT_TAP_PATTERN_DETECTION_OPTIONS: TapPatternDetectionOptions =
  {
    sensitivity: 50,
    granularity: 50,
  };

/** Clamps a numeric option to the percentage range used by panel sliders. */
function clampOptionPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

/** Resolves partial detection options with defaults and slider bounds. */
export function normalizeTapPatternDetectionOptions(
  options: Partial<TapPatternDetectionOptions> = {},
): TapPatternDetectionOptions {
  return {
    sensitivity: clampOptionPercent(
      typeof options.sensitivity === "number" &&
        Number.isFinite(options.sensitivity)
        ? options.sensitivity
        : DEFAULT_TAP_PATTERN_DETECTION_OPTIONS.sensitivity,
    ),
    granularity: clampOptionPercent(
      typeof options.granularity === "number" &&
        Number.isFinite(options.granularity)
        ? options.granularity
        : DEFAULT_TAP_PATTERN_DETECTION_OPTIONS.granularity,
    ),
  };
}

/** Converts sensitivity into a phase-cluster tolerance multiplier. */
function sensitivityToleranceScale(sensitivity: number): number {
  return 2 ** ((sensitivity - 50) / 50);
}

/** Returns a stable keyboard identity when a tap was captured from a key. */
function keyIdentityForTap(tap: TapEvent): string | null {
  return typeof tap.key === "string" && tap.key.length > 0 ? tap.key : null;
}

/** Returns true when every tap carries a keyboard identity. */
function hasOnlyKeyedTaps(taps: TapEvent[]): boolean {
  return taps.length > 0 && taps.every((tap) => keyIdentityForTap(tap) != null);
}

/** Returns true when keyed taps include more than one keyboard identity. */
function hasMultipleKeyIdentities(taps: TapEvent[]): boolean {
  return (
    new Set(
      taps
        .map((tap) => keyIdentityForTap(tap))
        .filter((key): key is string => key != null),
    ).size >= MIN_PATTERN_CLUSTER_COUNT
  );
}

/** Resolves phase-cluster tolerance without merging adjacent intentional taps. */
function phaseClusterToleranceMs(
  loopLengthMs: number,
  sensitivity: number,
  medianIntervalMs: number | null,
): number {
  const baseToleranceMs = Math.min(180, Math.max(40, loopLengthMs * 0.05));
  const scaledToleranceMs =
    baseToleranceMs * sensitivityToleranceScale(sensitivity);
  const intervalLimitMs =
    medianIntervalMs == null
      ? Number.POSITIVE_INFINITY
      : medianIntervalMs * 0.45;

  return Math.min(scaledToleranceMs, intervalLimitMs);
}

/** Uses neutral sensitivity for display confidence so slider tolerance does not inflate fit quality. */
function displayConfidenceToleranceMs(
  loopLengthMs: number,
  medianIntervalMs: number | null,
): number {
  return phaseClusterToleranceMs(
    loopLengthMs,
    DEFAULT_TAP_PATTERN_DETECTION_OPTIONS.sensitivity,
    medianIntervalMs,
  );
}

/** Converts granularity into a signed preference for shorter or longer loops. */
function granularityPreference(granularity: number): number {
  return (granularity - 50) / 50;
}

/** Computes the median of a non-empty numeric array. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const midpoint = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 1) {
    return sorted[midpoint];
  }

  return (sorted[midpoint - 1] + sorted[midpoint]) / 2;
}

/** Computes the arithmetic mean of a non-empty numeric array. */
function mean(values: number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/** Converts an interval in milliseconds to beats per minute. */
export function bpmFromInterval(intervalMs: number | null): number | null {
  if (intervalMs == null || intervalMs <= 0) {
    return null;
  }

  return 60000 / intervalMs;
}

/** Measures interval spread for tap-tempo and pulse-only detection. */
export function analyzeTapIntervals(taps: TapEvent[]): TapIntervalStats {
  if (taps.length < 2) {
    return {
      count: 0,
      medianMs: null,
      meanMs: null,
      coefficientOfVariation: null,
    };
  }

  const intervals = taps
    .slice(1)
    .map((tap, index) => tap.timeMs - taps[index].timeMs);
  const intervalMean = mean(intervals);
  const variance =
    intervals.reduce(
      (total, interval) => total + (interval - intervalMean) ** 2,
      0,
    ) / intervals.length;

  return {
    count: intervals.length,
    medianMs: median(intervals),
    meanMs: intervalMean,
    coefficientOfVariation:
      intervalMean > 0 ? Math.sqrt(variance) / intervalMean : null,
  };
}

/** Returns the shortest circular distance between two phase positions. */
function circularDistance(
  aMs: number,
  bMs: number,
  loopLengthMs: number,
): number {
  const rawDistance = Math.abs(aMs - bMs);
  return Math.min(rawDistance, loopLengthMs - rawDistance);
}

/** Normalizes a timestamp into a phase inside one loop. */
function phaseOf(timeMs: number, loopLengthMs: number): number {
  return ((timeMs % loopLengthMs) + loopLengthMs) % loopLengthMs;
}

/** Assigns a tap to the elapsed loop span shown in the canonical timeline. */
function repeatIndexForTime(timeMs: number, loopLengthMs: number): number {
  if (loopLengthMs <= 0) {
    return 0;
  }

  return Math.max(0, Math.floor(timeMs / loopLengthMs));
}

/** Assigns loop-boundary taps to the repeat containing their matched phase cluster. */
function repeatIndexForClusteredPhase(
  timeMs: number,
  phaseMs: number,
  clusterPhaseMs: number,
  loopLengthMs: number,
): number {
  const repeatIndex = repeatIndexForTime(timeMs, loopLengthMs);
  const phaseDeltaMs = phaseMs - clusterPhaseMs;

  if (phaseDeltaMs > loopLengthMs / 2) {
    return repeatIndex + 1;
  }

  if (phaseDeltaMs < -loopLengthMs / 2) {
    return Math.max(0, repeatIndex - 1);
  }

  return repeatIndex;
}

/** Measures variation in non-overlapping cycles for a stride-derived loop. */
function orderedStrideLoopVariation(
  taps: TapEvent[],
  strideLength: number,
): number {
  const durations: number[] = [];
  for (
    let index = 0;
    index + strideLength < taps.length;
    index += strideLength
  ) {
    durations.push(taps[index + strideLength].timeMs - taps[index].timeMs);
  }

  if (durations.length < 2) {
    return 0;
  }

  const averageDurationMs = mean(durations);
  const variance = mean(
    durations.map((durationMs) => (durationMs - averageDurationMs) ** 2),
  );

  return averageDurationMs > 0 ? Math.sqrt(variance) / averageDurationMs : 1;
}

/** Returns true when keyed taps in each ordered stride position share one key. */
function orderedStrideKeysMatch(
  taps: TapEvent[],
  strideLength: number,
): boolean {
  const keysByCluster = new Map<number, string>();
  for (const [index, tap] of taps.entries()) {
    const key = keyIdentityForTap(tap);
    if (key == null) {
      continue;
    }

    const clusterId = index % strideLength;
    const existingKey = keysByCluster.get(clusterId);
    if (existingKey != null && existingKey !== key) {
      return false;
    }

    keysByCluster.set(clusterId, key);
  }

  return true;
}

/** Returns true when a repeat row follows the canonical step order. */
function isOrderedSubsequence(
  canonicalClusterIds: number[],
  repeatClusterIds: number[],
): boolean {
  let canonicalIndex = 0;
  for (const clusterId of repeatClusterIds) {
    canonicalIndex = canonicalClusterIds.indexOf(clusterId, canonicalIndex);
    if (canonicalIndex < 0) {
      return false;
    }
    canonicalIndex += 1;
  }

  return true;
}

/** Measures whether detected repeats use the same ordered cluster sequence. */
function repeatOrderConsistency(assignments: TapPatternAssignment[]): number {
  if (assignments.length === 0) {
    return 0;
  }

  const repeatAssignments = new Map<number, TapPatternAssignment[]>();
  for (const assignment of assignments) {
    const repeat = repeatAssignments.get(assignment.repeatIndex) ?? [];
    repeat.push(assignment);
    repeatAssignments.set(assignment.repeatIndex, repeat);
  }

  const rows = [...repeatAssignments.values()].map((repeat) =>
    repeat
      .sort((a, b) => a.phaseMs - b.phaseMs)
      .map((assignment) => assignment.clusterId),
  );
  const maxRowLength = Math.max(...rows.map((row) => row.length));
  const canonicalRows = rows.filter((row) => row.length === maxRowLength);
  const canonicalCounts = new Map<string, number>();
  for (const row of canonicalRows) {
    const key = row.join(",");
    canonicalCounts.set(key, (canonicalCounts.get(key) ?? 0) + 1);
  }
  const canonicalKey = [...canonicalCounts.entries()].sort(
    (a, b) => b[1] - a[1],
  )[0]?.[0];
  const canonicalClusterIds = canonicalKey
    ? canonicalKey.split(",").map((clusterId) => Number.parseInt(clusterId, 10))
    : [];

  let inconsistentCount = 0;
  for (const row of rows) {
    const duplicateCount = row.length - new Set(row).size;
    inconsistentCount += duplicateCount;

    if (!isOrderedSubsequence(canonicalClusterIds, row)) {
      inconsistentCount += row.length;
    }
  }

  return 1 - inconsistentCount / assignments.length;
}

/** Counts the repeat rows represented by tap assignments. */
function repeatCountForAssignments(
  assignments: TapPatternAssignment[],
): number {
  if (assignments.length === 0) {
    return 0;
  }

  return (
    Math.max(...assignments.map((assignment) => assignment.repeatIndex)) + 1
  );
}

/** Measures how fully each detected repeat row covers the cluster set. */
function repeatRowCompleteness(
  assignments: TapPatternAssignment[],
  clusterCount: number,
): number {
  if (assignments.length === 0 || clusterCount <= 0) {
    return 0;
  }

  const clusterIdsByRepeat = new Map<number, Set<number>>();
  for (const assignment of assignments) {
    const clusterIds =
      clusterIdsByRepeat.get(assignment.repeatIndex) ?? new Set<number>();
    clusterIds.add(assignment.clusterId);
    clusterIdsByRepeat.set(assignment.repeatIndex, clusterIds);
  }

  return mean(
    [...clusterIdsByRepeat.values()].map(
      (clusterIds) => Math.min(clusterIds.size, clusterCount) / clusterCount,
    ),
  );
}

/** Computes the legacy candidate rank score used for choosing loop candidates. */
function candidateRankScore(
  repeatedTapRatio: number,
  repeatedClusterRatio: number,
  errorMs: number,
  toleranceMs: number,
  orderConsistency: number,
): number {
  return Math.max(
    0,
    Math.min(
      1,
      repeatedTapRatio * 0.4 +
        repeatedClusterRatio * 0.3 +
        (1 - errorMs / toleranceMs) * 0.15 +
        orderConsistency * 0.15,
    ),
  );
}

/** Scores confidence from coverage, row completeness, ordering, and cluster error. */
function candidateConfidence(
  assignments: TapPatternAssignment[],
  clusters: TapPatternCluster[],
  repeatedTapRatio: number,
  orderConsistency: number,
  toleranceMs: number,
): number {
  const repeatedClusterRatio =
    clusters.length > 0
      ? clusters.filter((cluster) => cluster.tapIds.length >= 2).length /
        clusters.length
      : 0;
  const rowCompleteness = repeatRowCompleteness(assignments, clusters.length);
  const medianClusterErrorMs =
    clusters.length > 0
      ? median(clusters.map((cluster) => cluster.averageErrorMs))
      : toleranceMs;
  const errorScore =
    toleranceMs > 0
      ? Math.max(0, Math.min(1, 1 - medianClusterErrorMs / toleranceMs))
      : 0;
  const baseScore =
    repeatedTapRatio * 0.25 +
    repeatedClusterRatio * 0.2 +
    orderConsistency * 0.2 +
    rowCompleteness * 0.2 +
    errorScore * 0.15;

  return Math.max(
    0,
    Math.min(
      1,
      baseScore * (0.35 + rowCompleteness * 0.65) * (0.35 + errorScore * 0.65),
    ),
  );
}

/** Builds one phase cluster using circular mean so loop-boundary groups stay centered near zero. */
function buildPhaseCluster(
  samples: PhaseSample[],
  id: number,
  loopLengthMs: number,
): TapPatternCluster {
  const angleScale = (Math.PI * 2) / loopLengthMs;
  const vector = samples.reduce(
    (total, sample) => {
      const angle = sample.phaseMs * angleScale;
      return {
        sin: total.sin + Math.sin(angle),
        cos: total.cos + Math.cos(angle),
      };
    },
    { sin: 0, cos: 0 },
  );
  const angle = Math.atan2(vector.sin, vector.cos);
  const phaseMs = phaseOf(
    (angle < 0 ? angle + Math.PI * 2 : angle) / angleScale,
    loopLengthMs,
  );
  const errors = samples.map((sample) =>
    circularDistance(sample.phaseMs, phaseMs, loopLengthMs),
  );

  return {
    id,
    phaseMs,
    tapIds: samples.map((sample) => sample.tap.id),
    averageErrorMs: errors.length > 0 ? mean(errors) : 0,
  };
}

/** Builds likely loop-length candidates from repeated tap strides and whole-span divisions. */
function buildLoopCandidates(taps: TapEvent[]): LoopCandidate[] {
  if (taps.length < 4) {
    return [];
  }

  const spanMs = taps[taps.length - 1].timeMs - taps[0].timeMs;
  if (spanMs <= 0) {
    return [];
  }

  const candidates = new Map<number, LoopCandidate>();
  const maxStride = Math.min(
    MAX_ORDERED_STRIDE_CANDIDATE_TAPS,
    Math.floor(taps.length / 2),
  );
  /** Adds a loop candidate, preserving direct stride support when any source has it. */
  const addCandidate = (loopLengthMs: number, strideLength: number | null) => {
    const key = Math.round(loopLengthMs);
    const existing = candidates.get(key);
    const existingStride = existing?.strideLength ?? null;
    candidates.set(key, {
      loopLengthMs,
      strideLength:
        existingStride == null ||
        (strideLength != null && strideLength < existingStride)
          ? strideLength
          : existingStride,
      strideSupported:
        (existing?.strideSupported ?? false) || strideLength != null,
    });
  };

  for (let stride = 2; stride <= maxStride; stride += 1) {
    const strideDurations: number[] = [];
    for (let index = 0; index + stride < taps.length; index += 1) {
      strideDurations.push(taps[index + stride].timeMs - taps[index].timeMs);
    }
    addCandidate(median(strideDurations), stride);
  }

  for (let repeats = 2; repeats <= Math.min(8, taps.length - 1); repeats += 1) {
    addCandidate(spanMs / repeats, null);
  }

  const minCandidate = 240;
  const maxCandidate = spanMs * 0.95;

  return [...candidates.values()]
    .filter(
      (candidate) =>
        candidate.loopLengthMs >= minCandidate &&
        candidate.loopLengthMs <= maxCandidate,
    )
    .sort((a, b) => a.loopLengthMs - b.loopLengthMs);
}

/** Groups tap phases that land near the same position in a candidate loop. */
function clusterPhases(
  taps: TapEvent[],
  loopLengthMs: number,
  toleranceMs: number,
): TapPatternCluster[] {
  const sortedSamples = taps
    .map((tap) => {
      const phaseMs = phaseOf(tap.timeMs, loopLengthMs);
      return { tap, phaseMs, unwrappedPhaseMs: phaseMs };
    })
    .sort((a, b) => a.phaseMs - b.phaseMs);

  if (sortedSamples.length === 0) {
    return [];
  }

  let largestGapIndex = 0;
  let largestGapMs = -Infinity;
  for (let index = 0; index < sortedSamples.length; index += 1) {
    const current = sortedSamples[index];
    const next = sortedSamples[(index + 1) % sortedSamples.length];
    const gapMs =
      index === sortedSamples.length - 1
        ? next.phaseMs + loopLengthMs - current.phaseMs
        : next.phaseMs - current.phaseMs;

    if (gapMs > largestGapMs) {
      largestGapMs = gapMs;
      largestGapIndex = index;
    }
  }

  const rotatedSamples = [
    ...sortedSamples.slice(largestGapIndex + 1),
    ...sortedSamples.slice(0, largestGapIndex + 1),
  ];
  const orderedSamples: PhaseSample[] = [];
  let unwrapOffsetMs = 0;
  for (const sample of rotatedSamples) {
    const previous = orderedSamples[orderedSamples.length - 1];
    if (
      previous &&
      sample.phaseMs + unwrapOffsetMs < previous.unwrappedPhaseMs
    ) {
      unwrapOffsetMs += loopLengthMs;
    }

    orderedSamples.push({
      ...sample,
      unwrappedPhaseMs: sample.phaseMs + unwrapOffsetMs,
    });
  }

  const accumulators: ClusterAccumulator[] = [];
  for (const sample of orderedSamples) {
    const current = accumulators[accumulators.length - 1];
    if (
      !current ||
      Math.abs(sample.unwrappedPhaseMs - current.centerMs) > toleranceMs
    ) {
      accumulators.push({
        samples: [sample],
        centerMs: sample.unwrappedPhaseMs,
      });
      continue;
    }

    current.samples.push(sample);
    current.centerMs = mean(
      current.samples.map((entry) => entry.unwrappedPhaseMs),
    );
  }

  if (accumulators.length > 1) {
    const first = accumulators[0];
    const last = accumulators[accumulators.length - 1];
    if (
      circularDistance(
        phaseOf(first.centerMs, loopLengthMs),
        phaseOf(last.centerMs, loopLengthMs),
        loopLengthMs,
      ) <= toleranceMs
    ) {
      first.samples = [...last.samples, ...first.samples];
      first.centerMs = mean(
        first.samples.map((entry) => entry.unwrappedPhaseMs),
      );
      accumulators.pop();
    }
  }

  return accumulators
    .map((cluster, id) => buildPhaseCluster(cluster.samples, id, loopLengthMs))
    .sort((a, b) => a.phaseMs - b.phaseMs)
    .map((cluster, id) => ({ ...cluster, id }));
}

/** Validates that every keyed repeat contains the same key identities once. */
function hasCompleteKeyedRepeats(
  assignments: TapPatternAssignment[],
  clusters: TapPatternCluster[],
): boolean {
  const expectedClusterIds = new Set(clusters.map((cluster) => cluster.id));
  const clusterIdsByRepeat = new Map<number, Set<number>>();

  for (const assignment of assignments) {
    const clusterIds =
      clusterIdsByRepeat.get(assignment.repeatIndex) ?? new Set<number>();
    if (clusterIds.has(assignment.clusterId)) {
      return false;
    }

    clusterIds.add(assignment.clusterId);
    clusterIdsByRepeat.set(assignment.repeatIndex, clusterIds);
  }

  if (clusterIdsByRepeat.size < MIN_LOOP_REPEAT_COUNT) {
    return false;
  }

  for (const clusterIds of clusterIdsByRepeat.values()) {
    if (clusterIds.size !== expectedClusterIds.size) {
      return false;
    }

    for (const expectedClusterId of expectedClusterIds) {
      if (!clusterIds.has(expectedClusterId)) {
        return false;
      }
    }
  }

  return true;
}

/** Builds a candidate whose clusters are fixed by captured key identity. */
function buildKeyIdentityCandidate(
  taps: TapEvent[],
  loopCandidate: LoopCandidate,
  options: TapPatternDetectionOptions,
  medianIntervalMs: number | null,
): TapPatternCandidate | null {
  const { loopLengthMs } = loopCandidate;
  const keyedTaps = taps
    .map((tap) => ({ tap, key: keyIdentityForTap(tap) }))
    .filter(
      (entry): entry is { tap: TapEvent; key: string } => entry.key != null,
    );
  if (
    keyedTaps.length !== taps.length ||
    new Set(keyedTaps.map((entry) => entry.key)).size <
      MIN_PATTERN_CLUSTER_COUNT
  ) {
    return null;
  }

  const keyCount = new Set(keyedTaps.map((entry) => entry.key)).size;
  const canonicalKeys = keyedTaps.slice(0, keyCount).map((entry) => entry.key);
  if (
    keyedTaps.length % keyCount !== 0 ||
    new Set(canonicalKeys).size !== keyCount
  ) {
    return null;
  }

  for (const [index, entry] of keyedTaps.entries()) {
    if (entry.key !== canonicalKeys[index % keyCount]) {
      return null;
    }
  }
  if (loopCandidate.strideLength !== keyCount) {
    return null;
  }
  if (
    orderedStrideLoopVariation(taps, keyCount) >
    MAX_ORDERED_STRIDE_LOOP_VARIATION
  ) {
    return null;
  }

  const toleranceMs = phaseClusterToleranceMs(
    loopLengthMs,
    options.sensitivity,
    medianIntervalMs,
  );
  const samplesByKey = new Map<string, PhaseSample[]>();
  for (const [index, { tap, key }] of keyedTaps.entries()) {
    const repeatIndex = Math.floor(index / keyCount);
    const cycleStartMs = keyedTaps[repeatIndex * keyCount]?.tap.timeMs ?? 0;
    const phaseMs = phaseOf(tap.timeMs - cycleStartMs, loopLengthMs);
    samplesByKey.set(key, [
      ...(samplesByKey.get(key) ?? []),
      { tap, phaseMs, unwrappedPhaseMs: phaseMs },
    ]);
  }

  const keyedClusters = [...samplesByKey.entries()]
    .map(([key, samples]) => ({
      key,
      cluster: buildPhaseCluster(samples, 0, loopLengthMs),
    }))
    .sort((a, b) => a.cluster.phaseMs - b.cluster.phaseMs)
    .map(({ key, cluster }, id) => ({
      key,
      cluster: { ...cluster, id },
    }));
  const clusterByKey = new Map(
    keyedClusters.map(({ key, cluster }) => [key, cluster]),
  );
  const clusterIdByKey = new Map(
    keyedClusters.map(({ key, cluster }) => [key, cluster.id]),
  );
  const assignments = keyedTaps.map(({ tap, key }, index) => {
    const cluster = clusterByKey.get(key);
    const repeatIndex = Math.floor(index / keyCount);
    const cycleStartMs = keyedTaps[repeatIndex * keyCount]?.tap.timeMs ?? 0;
    const phaseMs = phaseOf(tap.timeMs - cycleStartMs, loopLengthMs);
    if (!cluster) {
      throw new Error(`Missing key cluster for ${key}`);
    }

    return {
      tapId: tap.id,
      clusterId: clusterIdByKey.get(key) ?? cluster.id,
      repeatIndex,
      phaseMs,
      errorMs: circularDistance(phaseMs, cluster.phaseMs, loopLengthMs),
    };
  });
  const cycleStartErrorMs = mean(
    Array.from({ length: keyedTaps.length / keyCount }, (_, repeatIndex) => {
      const cycleStartTap = keyedTaps[repeatIndex * keyCount]?.tap;
      return cycleStartTap
        ? circularDistance(
            phaseOf(cycleStartTap.timeMs, loopLengthMs),
            0,
            loopLengthMs,
          )
        : 0;
    }),
  );
  const clusters = keyedClusters.map(({ key, cluster }) =>
    key === canonicalKeys[0]
      ? {
          ...cluster,
          averageErrorMs: Math.max(cluster.averageErrorMs, cycleStartErrorMs),
        }
      : cluster,
  );
  const repeatedClusters = clusters.filter(
    (cluster) => cluster.tapIds.length >= 2,
  );
  const repeatedTapCount = repeatedClusters.reduce(
    (total, cluster) => total + cluster.tapIds.length,
    0,
  );
  const averageErrorMs = mean(
    assignments.map((assignment) => assignment.errorMs),
  );
  const repeatCount = repeatCountForAssignments(assignments);
  const orderConsistency = repeatOrderConsistency(assignments);

  if (
    repeatCount < MIN_LOOP_REPEAT_COUNT ||
    !hasCompleteKeyedRepeats(assignments, clusters) ||
    averageErrorMs > toleranceMs * 0.75 ||
    orderConsistency < 0.98
  ) {
    return null;
  }

  const repeatedTapRatio = repeatedTapCount / taps.length;
  const repeatedClusterRatio = repeatedClusters.length / clusters.length;
  const confidenceToleranceMs = displayConfidenceToleranceMs(
    loopLengthMs,
    medianIntervalMs,
  );
  const confidence = candidateConfidence(
    assignments,
    clusters,
    repeatedTapRatio,
    orderConsistency,
    confidenceToleranceMs,
  );
  const rankScore = candidateRankScore(
    repeatedTapRatio,
    repeatedClusterRatio,
    averageErrorMs,
    toleranceMs,
    orderConsistency,
  );

  return reindexCandidateFromFirstTap(taps, {
    loopLengthMs,
    confidence,
    rankScore,
    averageErrorMs,
    repeatedTapRatio,
    orderConsistency,
    clusters,
    assignments,
    repeatCount,
    strideSupported: loopCandidate.strideSupported,
  });
}

/** Builds a direct ordered-repeat candidate from a supported tap stride. */
function buildOrderedStrideCandidate(
  taps: TapEvent[],
  loopCandidate: LoopCandidate,
  options: TapPatternDetectionOptions,
  medianIntervalMs: number | null,
): TapPatternCandidate | null {
  const { loopLengthMs, strideLength } = loopCandidate;
  if (strideLength == null || strideLength < MIN_PATTERN_CLUSTER_COUNT) {
    return null;
  }

  if (!orderedStrideKeysMatch(taps, strideLength)) {
    return null;
  }

  if (
    orderedStrideLoopVariation(taps, strideLength) >
    MAX_ORDERED_STRIDE_LOOP_VARIATION
  ) {
    return null;
  }

  const toleranceMs = phaseClusterToleranceMs(
    loopLengthMs,
    options.sensitivity,
    medianIntervalMs,
  );
  const phasesByTapId = new Map<number, number>();
  const samplesByCluster = new Map<number, PhaseSample[]>();
  for (let index = 0; index < taps.length; index += 1) {
    const tap = taps[index];
    const repeatIndex = Math.floor(index / strideLength);
    const cycleStart = taps[repeatIndex * strideLength]?.timeMs ?? 0;
    const localPhaseMs = phaseOf(tap.timeMs - cycleStart, loopLengthMs);
    const clusterId = index % strideLength;
    phasesByTapId.set(tap.id, localPhaseMs);
    samplesByCluster.set(clusterId, [
      ...(samplesByCluster.get(clusterId) ?? []),
      { tap, phaseMs: localPhaseMs, unwrappedPhaseMs: localPhaseMs },
    ]);
  }

  const baseClusters = [...samplesByCluster.entries()]
    .sort(([a], [b]) => a - b)
    .map(([clusterId, samples]) =>
      buildPhaseCluster(samples, clusterId, loopLengthMs),
    );
  const localAverageErrorMs = mean(
    taps.map((tap, index) => {
      const clusterId = index % strideLength;
      return circularDistance(
        phasesByTapId.get(tap.id) ?? 0,
        baseClusters[clusterId].phaseMs,
        loopLengthMs,
      );
    }),
  );

  const localCycleStartErrorMs = mean(
    Array.from(
      { length: Math.ceil(taps.length / strideLength) },
      (_, index) => {
        const tap = taps[index * strideLength];
        return tap
          ? circularDistance(phaseOf(tap.timeMs, loopLengthMs), 0, loopLengthMs)
          : 0;
      },
    ),
  );
  const clusters = baseClusters.map((cluster) =>
    cluster.id === 0
      ? {
          ...cluster,
          averageErrorMs: Math.max(
            cluster.averageErrorMs,
            localCycleStartErrorMs,
          ),
        }
      : cluster,
  );
  const assignments = taps.map((tap, index) => {
    const clusterId = index % strideLength;
    const cluster = clusters[clusterId];
    const phaseMs = phasesByTapId.get(tap.id) ?? 0;

    return {
      tapId: tap.id,
      clusterId,
      repeatIndex: Math.floor(index / strideLength),
      phaseMs,
      errorMs: circularDistance(phaseMs, cluster.phaseMs, loopLengthMs),
    };
  });
  const repeatedClusters = clusters.filter(
    (cluster) => cluster.tapIds.length >= 2,
  );
  const repeatedTapCount = repeatedClusters.reduce(
    (total, cluster) => total + cluster.tapIds.length,
    0,
  );
  const averageErrorMs = mean(
    assignments.map((assignment) => assignment.errorMs),
  );
  const repeatCount = repeatCountForAssignments(assignments);
  const orderConsistency = 1;

  if (
    repeatCount < MIN_LOOP_REPEAT_COUNT ||
    repeatedClusters.length / clusters.length < 0.6 ||
    localAverageErrorMs > toleranceMs * 0.75 ||
    orderConsistency < 0.98
  ) {
    return null;
  }

  const repeatedTapRatio = repeatedTapCount / taps.length;
  const repeatedClusterRatio = repeatedClusters.length / clusters.length;
  const confidenceToleranceMs = displayConfidenceToleranceMs(
    loopLengthMs,
    medianIntervalMs,
  );
  const confidence = candidateConfidence(
    assignments,
    clusters,
    repeatedTapRatio,
    orderConsistency,
    confidenceToleranceMs,
  );
  const rankScore = candidateRankScore(
    repeatedTapRatio,
    repeatedClusterRatio,
    localAverageErrorMs,
    toleranceMs,
    orderConsistency,
  );

  return reindexCandidateFromFirstTap(taps, {
    loopLengthMs,
    confidence,
    rankScore,
    averageErrorMs,
    repeatedTapRatio,
    orderConsistency,
    clusters,
    assignments,
    repeatCount,
    strideSupported: loopCandidate.strideSupported,
  });
}

/** Reorders cluster IDs so cluster one is the group assigned to the first tap. */
function reindexCandidateFromFirstTap(
  taps: TapEvent[],
  candidate: TapPatternCandidate,
): TapPatternCandidate {
  const firstTap = taps[0];
  const firstAssignment = candidate.assignments.find(
    (assignment) => assignment.tapId === firstTap?.id,
  );
  if (!firstAssignment) {
    return candidate;
  }

  const phaseSortedClusters = [...candidate.clusters].sort(
    (a, b) => a.phaseMs - b.phaseMs,
  );
  const firstClusterIndex = phaseSortedClusters.findIndex(
    (cluster) => cluster.id === firstAssignment.clusterId,
  );
  if (firstClusterIndex < 0) {
    return candidate;
  }

  const rotatedClusters = [
    ...phaseSortedClusters.slice(firstClusterIndex),
    ...phaseSortedClusters.slice(0, firstClusterIndex),
  ];
  const clusterIdMap = new Map(
    rotatedClusters.map((cluster, id) => [cluster.id, id]),
  );

  return {
    ...candidate,
    clusters: rotatedClusters.map((cluster, id) => ({ ...cluster, id })),
    assignments: candidate.assignments.map((assignment) => ({
      ...assignment,
      clusterId: clusterIdMap.get(assignment.clusterId) ?? assignment.clusterId,
    })),
  };
}

/** Scores one loop-length candidate by folding taps into repeated phase clusters. */
function scoreLoopCandidate(
  taps: TapEvent[],
  loopCandidate: LoopCandidate,
  options: TapPatternDetectionOptions,
  medianIntervalMs: number | null,
): TapPatternCandidate | null {
  const keyIdentityCandidate = buildKeyIdentityCandidate(
    taps,
    loopCandidate,
    options,
    medianIntervalMs,
  );
  if (keyIdentityCandidate) {
    return keyIdentityCandidate;
  }

  const orderedStrideCandidate = buildOrderedStrideCandidate(
    taps,
    loopCandidate,
    options,
    medianIntervalMs,
  );
  if (orderedStrideCandidate) {
    return orderedStrideCandidate;
  }

  if (hasOnlyKeyedTaps(taps) && hasMultipleKeyIdentities(taps)) {
    return null;
  }

  const { loopLengthMs } = loopCandidate;
  const toleranceMs = phaseClusterToleranceMs(
    loopLengthMs,
    options.sensitivity,
    medianIntervalMs,
  );
  const clusters = clusterPhases(taps, loopLengthMs, toleranceMs);
  if (clusters.length < MIN_PATTERN_CLUSTER_COUNT) {
    return null;
  }

  const assignments = taps.map((tap) => {
    const phaseMs = phaseOf(tap.timeMs, loopLengthMs);
    const cluster = clusters.reduce((best, next) =>
      circularDistance(phaseMs, next.phaseMs, loopLengthMs) <
      circularDistance(phaseMs, best.phaseMs, loopLengthMs)
        ? next
        : best,
    );
    return {
      tapId: tap.id,
      clusterId: cluster.id,
      repeatIndex: repeatIndexForClusteredPhase(
        tap.timeMs,
        phaseMs,
        cluster.phaseMs,
        loopLengthMs,
      ),
      phaseMs,
      errorMs: circularDistance(phaseMs, cluster.phaseMs, loopLengthMs),
    };
  });
  const orderConsistency = repeatOrderConsistency(assignments);
  if (orderConsistency < 0.98) {
    return null;
  }

  const clusterRepeatIndexes = new Map<number, Set<number>>();
  for (const assignment of assignments) {
    const repeatIndexes =
      clusterRepeatIndexes.get(assignment.clusterId) ?? new Set();
    repeatIndexes.add(assignment.repeatIndex);
    clusterRepeatIndexes.set(assignment.clusterId, repeatIndexes);
  }
  const repeatedClusters = clusters.filter(
    (cluster) => (clusterRepeatIndexes.get(cluster.id)?.size ?? 0) >= 2,
  );
  const repeatedTapCount = repeatedClusters.reduce(
    (total, cluster) => total + cluster.tapIds.length,
    0,
  );
  const averageErrorMs = mean(
    assignments.map((assignment) => assignment.errorMs),
  );
  const repeatCount = repeatCountForAssignments(assignments);

  if (
    repeatCount < MIN_LOOP_REPEAT_COUNT ||
    repeatedClusters.length / clusters.length < 0.6 ||
    averageErrorMs > toleranceMs * 0.75
  ) {
    return null;
  }

  const repeatedTapRatio = repeatedTapCount / taps.length;
  const repeatedClusterRatio = repeatedClusters.length / clusters.length;
  const confidenceToleranceMs = displayConfidenceToleranceMs(
    loopLengthMs,
    medianIntervalMs,
  );
  const confidence = candidateConfidence(
    assignments,
    clusters,
    repeatedTapRatio,
    orderConsistency,
    confidenceToleranceMs,
  );
  const rankScore = candidateRankScore(
    repeatedTapRatio,
    repeatedClusterRatio,
    averageErrorMs,
    toleranceMs,
    orderConsistency,
  );

  return reindexCandidateFromFirstTap(taps, {
    loopLengthMs,
    confidence,
    rankScore,
    averageErrorMs,
    repeatedTapRatio,
    orderConsistency,
    clusters,
    assignments,
    repeatCount,
    strideSupported: loopCandidate.strideSupported,
  });
}

/** Ranks detected candidates with optional loop-granularity preference. */
function compareTapPatternCandidates(
  options: TapPatternDetectionOptions,
): (a: TapPatternCandidate, b: TapPatternCandidate) => number {
  const granularity = granularityPreference(options.granularity);
  const confidenceWindow = 0.04 + Math.abs(granularity) * 0.12;

  return (a, b) => {
    const confidenceDelta =
      (b.rankScore ?? b.confidence) - (a.rankScore ?? a.confidence);
    if (Math.abs(confidenceDelta) > confidenceWindow) {
      return confidenceDelta;
    }

    const orderDelta = b.orderConsistency - a.orderConsistency;
    if (Math.abs(orderDelta) > 0.02) {
      return orderDelta;
    }

    if (granularity > 0.05) {
      return a.loopLengthMs - b.loopLengthMs;
    }

    if (granularity < -0.05) {
      return b.loopLengthMs - a.loopLengthMs;
    }

    if (a.strideSupported !== b.strideSupported) {
      return a.strideSupported ? -1 : 1;
    }

    return a.loopLengthMs - b.loopLengthMs;
  };
}

/** Finds the strongest repeated timing pattern in a set of taps. */
function detectTapPattern(
  taps: TapEvent[],
  options: Partial<TapPatternDetectionOptions> = {},
): TapPatternCandidate | null {
  const detectionOptions = normalizeTapPatternDetectionOptions(options);
  const stats = analyzeTapIntervals(taps);
  const candidates = buildLoopCandidates(taps);

  return (
    candidates
      .map((candidate) =>
        scoreLoopCandidate(taps, candidate, detectionOptions, stats.medianMs),
      )
      .filter(
        (candidate): candidate is TapPatternCandidate => candidate != null,
      )
      .sort(compareTapPatternCandidates(detectionOptions))[0] ?? null
  );
}

/** Produces the full analysis state displayed by the tap pattern panel. */
export function analyzeTapPattern(
  taps: TapEvent[],
  options: Partial<TapPatternDetectionOptions> = {},
): TapPatternAnalysis {
  const orderedTaps = [...taps].sort((a, b) => a.timeMs - b.timeMs);
  const originMs = orderedTaps[0]?.timeMs ?? 0;
  const normalizedTaps = orderedTaps.map((tap) => ({
    ...tap,
    timeMs: tap.timeMs - originMs,
  }));
  const intervalStats = analyzeTapIntervals(normalizedTaps);
  const pulseBpm = bpmFromInterval(intervalStats.medianMs);

  if (normalizedTaps.length < 2) {
    return {
      relativeTapsMs: normalizedTaps.map((tap) => tap.timeMs),
      intervalStats,
      pulseBpm,
      pattern: null,
      status: "waiting",
    };
  }

  if (
    (normalizedTaps.every((tap) => keyIdentityForTap(tap) == null) ||
      (hasOnlyKeyedTaps(normalizedTaps) &&
        !hasMultipleKeyIdentities(normalizedTaps))) &&
    intervalStats.coefficientOfVariation != null &&
    intervalStats.coefficientOfVariation <= STEADY_PULSE_VARIATION_LIMIT
  ) {
    return {
      relativeTapsMs: normalizedTaps.map((tap) => tap.timeMs),
      intervalStats,
      pulseBpm,
      pattern: null,
      status: "pulse",
    };
  }

  const pattern = detectTapPattern(normalizedTaps, options);

  return {
    relativeTapsMs: normalizedTaps.map((tap) => tap.timeMs),
    intervalStats,
    pulseBpm,
    pattern,
    status: pattern ? "pattern" : "searching",
  };
}
