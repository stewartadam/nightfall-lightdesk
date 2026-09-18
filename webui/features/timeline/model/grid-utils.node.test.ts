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
  msPerBars,
  quantizeSeekPositionMs,
  seekPositionByBars,
  seekPositionFromTimelineX,
  snapToGrid,
} from "./grid-utils";

/** Verifies bar jump duration scales by BPM, meter, and jump count. */
test("msPerBars calculates whole-bar jump durations", () => {
  assert.equal(msPerBars(120, 4, 1), 2_000);
  assert.equal(msPerBars(120, 4, 4), 8_000);
  assert.equal(msPerBars(120, 4, 8), 16_000);
  assert.equal(msPerBars(100, 3, 2), 3_600);
});

/** Verifies snapped bar seeks step to the first boundary in the direction. */
test("seekPositionByBars snaps to the first directional bar boundary", () => {
  const config = {
    snapEnabled: true,
    useBeatgrid: false,
    bpm: 120,
    beatsPerBar: 4,
  };

  assert.equal(seekPositionByBars(22_500, -1, 1, config), 22_000);
  assert.equal(seekPositionByBars(23_100, -1, 1, config), 22_000);
  assert.equal(seekPositionByBars(22_000, -1, 1, config), 20_000);
  assert.equal(seekPositionByBars(22_500, 1, 1, config), 24_000);
  assert.equal(seekPositionByBars(22_000, 1, 1, config), 24_000);
});

/** Verifies grouped snapped seeks align first, then jump from the boundary. */
test("seekPositionByBars aligns before applying grouped jumps", () => {
  const config = {
    snapEnabled: true,
    useBeatgrid: false,
    bpm: 120,
    beatsPerBar: 4,
  };

  assert.equal(seekPositionByBars(26_500, -1, 1, config), 26_000);
  assert.equal(seekPositionByBars(26_500, -1, 4, config), 26_000);
  assert.equal(seekPositionByBars(26_500, -1, 8, config), 26_000);
  assert.equal(seekPositionByBars(26_000, -1, 1, config), 24_000);
  assert.equal(seekPositionByBars(26_000, -1, 4, config), 18_000);
  assert.equal(seekPositionByBars(26_000, -1, 8, config), 10_000);
  assert.equal(seekPositionByBars(26_500, 1, 1, config), 28_000);
  assert.equal(seekPositionByBars(26_500, 1, 4, config), 28_000);
  assert.equal(seekPositionByBars(26_500, 1, 8, config), 28_000);
  assert.equal(seekPositionByBars(28_000, 1, 1, config), 30_000);
  assert.equal(seekPositionByBars(28_000, 1, 4, config), 36_000);
  assert.equal(seekPositionByBars(28_000, 1, 8, config), 44_000);
});

/** Verifies unsnapped bar seeks preserve relative offsets. */
test("seekPositionByBars preserves offsets when snapping is disabled", () => {
  const config = {
    snapEnabled: false,
    useBeatgrid: false,
    bpm: 120,
    beatsPerBar: 4,
  };

  assert.equal(seekPositionByBars(22_500, -1, 1, config), 20_500);
  assert.equal(seekPositionByBars(22_500, 1, 1, config), 24_500);
});

/** Verifies snapped bar seeks honor explicit downbeat markers. */
test("seekPositionByBars snaps to detected downbeat markers", () => {
  const config = {
    snapEnabled: true,
    useBeatgrid: true,
    bpm: 120,
    beatsPerBar: 4,
    markers: [
      { time: msToDuration(1_000), beat_index: 0, is_downbeat: true },
      { time: msToDuration(1_500), beat_index: 1, is_downbeat: false },
      { time: msToDuration(2_000), beat_index: 2, is_downbeat: false },
      { time: msToDuration(2_500), beat_index: 3, is_downbeat: false },
      { time: msToDuration(3_100), beat_index: 4, is_downbeat: true },
      { time: msToDuration(5_050), beat_index: 8, is_downbeat: true },
    ],
  };

  assert.equal(seekPositionByBars(3_200, -1, 1, config), 3_100);
  assert.equal(seekPositionByBars(3_100, -1, 1, config), 1_000);
  assert.equal(seekPositionByBars(3_100, 1, 1, config), 5_050);
});

/** Verifies a lone downbeat anchor does not trap backward seeks at bar 1. */
test("seekPositionByBars falls back to anchored BPM with one downbeat marker", () => {
  const config = {
    snapEnabled: true,
    useBeatgrid: true,
    bpm: 120,
    beatsPerBar: 4,
    markers: [{ time: msToDuration(1_000), beat_index: 0, is_downbeat: true }],
  };

  assert.equal(seekPositionByBars(11_200, -1, 1, config), 11_000);
  assert.equal(seekPositionByBars(11_000, -1, 1, config), 9_000);
});

test("seekPositionFromTimelineX returns exact position in time mode", () => {
  const position = seekPositionFromTimelineX({
    x: 175,
    start: 2_000,
    zoom: 100,
    useBeatgrid: false,
    snapEnabled: false,
    bpm: 120,
  });

  assert.equal(position, 3_750);
});

test("seekPositionFromTimelineX snaps to nearest beat in beatgrid mode when snapping is enabled", () => {
  const position = seekPositionFromTimelineX({
    x: 173,
    start: 0,
    zoom: 100,
    useBeatgrid: true,
    snapEnabled: true,
    bpm: 120,
  });

  assert.equal(position, 1_500);
});

/** Verifies beatgrid mode keeps exact click positions when snap is disabled. */
test("seekPositionFromTimelineX does not snap in beatgrid mode when snapping is disabled", () => {
  const position = seekPositionFromTimelineX({
    x: 173,
    start: 0,
    zoom: 100,
    useBeatgrid: true,
    snapEnabled: false,
    bpm: 120,
  });

  assert.equal(position, 1_730);
});

test("seekPositionFromTimelineX applies beat snapping with non-zero timeline start", () => {
  const position = seekPositionFromTimelineX({
    x: 63,
    start: 5_000,
    zoom: 100,
    useBeatgrid: true,
    snapEnabled: true,
    bpm: 120,
  });

  assert.equal(position, 5_500);
});

test("seekPositionFromTimelineX snaps from a shifted beatgrid marker anchor", () => {
  const position = seekPositionFromTimelineX({
    x: 173,
    start: 0,
    zoom: 100,
    useBeatgrid: true,
    snapEnabled: true,
    bpm: 120,
    markers: [{ time: msToDuration(1100), beat_index: 0, is_downbeat: true }],
  });

  assert.equal(position, 1600);
});

test("beatgrid mode does not quantize seek positions when snap is disabled", () => {
  const positionMs = 1234;

  const quantized = quantizeSeekPositionMs(positionMs, {
    snapEnabled: false,
    useBeatgrid: true,
    bpm: 120,
    markers: [{ time: msToDuration(1000), beat_index: 0, is_downbeat: true }],
  });

  assert.equal(quantized, positionMs);
});

test("beatgrid mode quantizes seek positions to explicit markers when snap is enabled", () => {
  const quantized = quantizeSeekPositionMs(1420, {
    snapEnabled: true,
    useBeatgrid: true,
    bpm: 120,
    markers: [
      { time: msToDuration(1000), beat_index: 0, is_downbeat: true },
      { time: msToDuration(1500), beat_index: 1, is_downbeat: false },
      { time: msToDuration(2000), beat_index: 2, is_downbeat: false },
    ],
  });

  assert.equal(quantized, 1500);
});

test("beatgrid mode extrapolates quantized seeks past the final detected marker", () => {
  const quantized = quantizeSeekPositionMs(2600, {
    snapEnabled: true,
    useBeatgrid: true,
    bpm: 120,
    markers: [
      { time: msToDuration(1000), beat_index: 0, is_downbeat: true },
      { time: msToDuration(1500), beat_index: 1, is_downbeat: false },
      { time: msToDuration(2000), beat_index: 2, is_downbeat: false },
    ],
  });

  assert.equal(quantized, 2500);
});

test("beatgrid mode quantizes seek positions to bpm beats when snap is enabled", () => {
  const quantized = quantizeSeekPositionMs(1260, {
    snapEnabled: true,
    useBeatgrid: true,
    bpm: 120,
    markers: [{ time: msToDuration(1000), beat_index: 0, is_downbeat: true }],
  });

  assert.equal(quantized, 1500);
});

test("beatgrid snapping extrapolates past the final detected marker", () => {
  const snappedPx = snapToGrid(260, 100, 0, {
    enabled: true,
    interval: 500,
    threshold: 15,
    isBeat: true,
    beatsPerBar: 4,
    markers: [1000, 1500, 2000],
    anchorMs: 1000,
  });

  assert.equal(snappedPx, 250);
});
