// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { msToDuration } from "../../../lib/duration";
import {
  createDefaultSequence,
  createDefaultSequenceStepCue,
  createShowObjectUid,
  nextAvailableIdentifierId,
} from "../../../lib/sequence-factory";
import type * as types from "../../../types";
import type { TapPatternCluster } from "./tap-pattern-analysis";

export interface TapPatternSequenceGenerationInput {
  clusters: TapPatternCluster[];
  loopLengthMs: number;
  existingSequences: Iterable<types.Sequence>;
}

export interface TapPatternSequenceGenerationResult {
  sequence: types.Sequence;
  cues: types.Cue[];
}

interface OrderedCluster {
  cluster: TapPatternCluster;
  phaseMs: number;
}

/** Returns whether the detected pattern has enough structure to create cues. */
export function canCreateTapPatternSequence(
  pattern: { clusters: TapPatternCluster[] } | null | undefined,
): boolean {
  return (pattern?.clusters.length ?? 0) >= 1;
}

/** Sorts pattern clusters by their phase within the detected loop. */
function orderedClusters(clusters: TapPatternCluster[]): OrderedCluster[] {
  return [...clusters]
    .sort((a, b) => a.phaseMs - b.phaseMs)
    .map((cluster) => ({
      cluster,
      phaseMs: Math.max(0, cluster.phaseMs),
    }));
}

/** Computes the forward loop gap from one phase to the next. */
function forwardLoopGapMs(
  fromPhaseMs: number,
  toPhaseMs: number,
  loopLengthMs: number,
): number {
  const rawGapMs = toPhaseMs - fromPhaseMs;
  return rawGapMs > 0 ? rawGapMs : rawGapMs + loopLengthMs;
}

/** Converts detected tap-pattern phases into a wrapped empty cue sequence. */
export function createTapPatternSequence(
  input: TapPatternSequenceGenerationInput,
): TapPatternSequenceGenerationResult {
  const sortedClusters = orderedClusters(input.clusters);
  if (sortedClusters.length < 1) {
    throw new Error(
      "Tap pattern sequence generation requires at least one step",
    );
  }
  if (!Number.isFinite(input.loopLengthMs) || input.loopLengthMs <= 0) {
    throw new Error(
      "Tap pattern sequence generation requires a positive loop length",
    );
  }

  const sequenceId = nextAvailableIdentifierId(input.existingSequences);
  const cues = sortedClusters.map(({ phaseMs }, index) => {
    const previous =
      sortedClusters[
        (index - 1 + sortedClusters.length) % sortedClusters.length
      ];
    const delayMs = forwardLoopGapMs(
      previous.phaseMs,
      phaseMs,
      input.loopLengthMs,
    );

    return createDefaultSequenceStepCue({
      id: index + 1,
      uid: createShowObjectUid(),
      label: `Step ${index + 1}`,
      trigger: {
        type: "AfterDelay",
        data: msToDuration(delayMs),
      },
    });
  });

  const sequence = {
    ...createDefaultSequence({
      id: sequenceId,
      label: `Tap Pattern ${sequenceId}`,
    }),
    wrap: true,
    steps: cues.map((cue) => cue.identifiers.uid),
  };

  return { sequence, cues };
}
