// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { msToDuration } from "../../../lib/utils";
import {
  beatPositionAtMs,
  formatTimelineBeatPosition,
  formatTimelineTimestamp,
  positionMsForBeatPosition,
  resolveTimelineJumpTarget,
  resolveTimelineJumpTargets,
} from "./timeline-jump";

/** Verifies timeline timestamps omit unnecessary precision while preserving milliseconds. */
test("formatTimelineTimestamp renders compact labels", () => {
  assert.equal(formatTimelineTimestamp(3_905_000), "1:05:05");
  assert.equal(formatTimelineTimestamp(65_250), "1:05.250");
  assert.equal(formatTimelineTimestamp(4_000), "0:04");
});

/** Verifies timestamp jump queries parse prefixed and bare colon-shaped inputs. */
test("resolveTimelineJumpTarget parses timestamp queries", () => {
  const config = { bpm: 120, beatsPerBar: 4 };

  assert.deepEqual(resolveTimelineJumpTarget("t 1:05:05", config), {
    kind: "timestamp",
    positionMs: 3_905_000,
    label: "Jump to time 1:05:05",
    typeLabel: "Timestamp",
    beatPosition: { bar: 1953, beat: 3 },
  });
  assert.equal(resolveTimelineJumpTarget("05:04", config)?.positionMs, 304_000);
  assert.equal(resolveTimelineJumpTarget("t 65.5", config)?.positionMs, 65_500);
});

/** Verifies ambiguous bare numeric queries offer both timestamp and beat targets. */
test("resolveTimelineJumpTargets offers timestamp and beat rows for ambiguous input", () => {
  const targets = resolveTimelineJumpTargets("3:02", {
    bpm: 120,
    beatsPerBar: 4,
    markers: [{ time: msToDuration(1_000), beat_index: 0, is_downbeat: true }],
  });

  assert.equal(targets.length, 2);
  assert.equal(targets[0]?.kind, "timestamp");
  assert.equal(targets[0]?.positionMs, 182_000);
  assert.equal(targets[1]?.kind, "beat");
  assert.equal(targets[1]?.positionMs, 5_500);
});

/** Verifies bar-beat jump queries resolve through the active meter and BPM. */
test("resolveTimelineJumpTarget parses bar beat queries", () => {
  const target = resolveTimelineJumpTarget("b 45:04", {
    bpm: 120,
    beatsPerBar: 4,
  });

  assert.equal(target?.kind, "beat");
  assert.equal(target?.positionMs, 89_500);
  assert.equal(target?.label, "Jump to Beat 45:04");
  assert.equal(target?.typeLabel, "Beat");
});

/** Verifies prefixed flat beat queries resolve as absolute one-based beat numbers. */
test("resolveTimelineJumpTarget parses prefixed absolute beat queries", () => {
  const target = resolveTimelineJumpTarget("b 64", {
    bpm: 120,
    beatsPerBar: 4,
  });

  assert.equal(target?.kind, "beat");
  assert.equal(target?.positionMs, 31_500);
  assert.equal(target?.label, "Jump to Beat 64");
  assert.deepEqual(target?.beatPosition, { bar: 16, beat: 4 });
});

/** Verifies unprefixed bar-beat shorthand does not require zero-padded beat values. */
test("resolveTimelineJumpTarget parses unpadded bar beat queries", () => {
  const target = resolveTimelineJumpTarget("64:3", {
    bpm: 120,
    beatsPerBar: 4,
  });

  assert.equal(target?.kind, "beat");
  assert.equal(target?.positionMs, 127_000);
  assert.equal(target?.label, "Jump to Beat 64:03");
});

/** Verifies flat numeric beat fallback is opt-in for callers without better matches. */
test("resolveTimelineJumpTargets offers bare absolute beat fallback when requested", () => {
  const targets = resolveTimelineJumpTargets(
    "64",
    {
      bpm: 120,
      beatsPerBar: 4,
    },
    { includeBareNumericBeat: true },
  );

  assert.equal(
    resolveTimelineJumpTargets("64", { bpm: 120, beatsPerBar: 4 }).length,
    0,
  );
  assert.equal(targets.length, 1);
  assert.equal(targets[0]?.kind, "beat");
  assert.equal(targets[0]?.positionMs, 31_500);
  assert.equal(targets[0]?.label, "Jump to Beat 64");
});

/** Verifies bar-beat positions honor explicit beatgrid marker anchors. */
test("positionMsForBeatPosition resolves from detected beatgrid anchors", () => {
  const config = {
    bpm: 120,
    beatsPerBar: 4,
    markers: [
      { time: msToDuration(1_000), beat_index: 0, is_downbeat: true },
      { time: msToDuration(3_000), beat_index: 4, is_downbeat: true },
      { time: msToDuration(5_000), beat_index: 8, is_downbeat: true },
    ],
  };

  assert.equal(positionMsForBeatPosition({ bar: 3, beat: 2 }, config), 5_500);
  assert.equal(positionMsForBeatPosition({ bar: 1, beat: 1 }, config), 1_000);
});

/** Verifies marker rows can disambiguate duplicate labels with beat positions. */
test("beatPositionAtMs exposes duplicate-label disambiguation metadata", () => {
  const config = {
    bpm: 120,
    beatsPerBar: 4,
    markers: [{ time: msToDuration(1_000), beat_index: 0, is_downbeat: true }],
  };

  assert.equal(
    formatTimelineBeatPosition(beatPositionAtMs(1_000, config)),
    "1:01",
  );
  assert.equal(
    formatTimelineBeatPosition(beatPositionAtMs(5_500, config)),
    "3:02",
  );
});

/** Verifies invalid numeric jump queries are left for label searching. */
test("resolveTimelineJumpTarget rejects invalid numeric jumps", () => {
  const config = { bpm: 120, beatsPerBar: 4 };

  assert.equal(resolveTimelineJumpTarget("b 2:8", config), undefined);
  assert.equal(resolveTimelineJumpTarget("t 1:99", config), undefined);
  assert.equal(resolveTimelineJumpTarget("t 1x:02", config), undefined);
  assert.equal(resolveTimelineJumpTarget("verse 1", config), undefined);
});
