// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { msToDuration } from "../../../lib/utils";
import type * as types from "../../../types";
import {
  getBeatInfo,
  msPerBars,
  msPerBeat,
  quantizeSeekPositionMs,
  seekPositionByBars,
  seekPositionFromTimelineX,
  snapPositionMs,
  timelineSnapConfig,
} from "./grid-utils";

/**
 * Verifies beat length keeps its fractional milliseconds, so bar 100 at 128 BPM starts where
 * the engine puts it rather than ~300 ms early.
 */
test("msPerBeat keeps fractional beat lengths", () => {
  assert.equal(msPerBeat(128), 468.75);
  const bar100StartMs = 99 * 4 * msPerBeat(128);
  assert.equal(bar100StartMs, 185_625);
  assert.deepEqual(getBeatInfo(bar100StartMs, 128), {
    beat: 396,
    bar: 100,
    beatInBar: 0,
  });
});

/**
 * Verifies a fractional beat's start counts as that beat both exactly and when rounded to the
 * whole millisecond a timeline position stores.
 */
test("getBeatInfo counts exact and rounded fractional beat starts as the new beat", () => {
  const beatMs = msPerBeat(130);
  for (let beat = 1; beat < 2000; beat++) {
    assert.equal(getBeatInfo(beat * beatMs, 130).beat, beat);
    assert.equal(getBeatInfo(Math.round(beat * beatMs), 130).beat, beat);
  }
});

/** Verifies bar jumps use the exact bar length rather than one rounded to whole milliseconds. */
test("msPerBars keeps fractional bar lengths", () => {
  assert.equal(msPerBars(130, 4, 99), 99 * 4 * msPerBeat(130));
});

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

/** Verifies snapping past the last detected marker continues the grid from the markers. */
test("beatgrid snapping extrapolates past the final detected marker", () => {
  const snappedMs = snapPositionMs(2600, 100, {
    enabled: true,
    interval: 500,
    threshold: 15,
    isBeat: true,
    beatsPerBar: 4,
    markers: [1000, 1500, 2000],
    anchorMs: 1000,
  });

  assert.equal(snappedMs, 2500);
});

/**
 * Verifies beat snapping returns the exact beat time at every zoom level, including zoomed
 * out where one pixel spans 25 ms.
 */
test("beat snapping returns exact beat times at any zoom", () => {
  const config = {
    enabled: true,
    interval: 60000 / 128,
    threshold: 15,
    isBeat: true,
    beatsPerBar: 4,
  };

  assert.equal(snapPositionMs(470, 100, config), 468.75);
  assert.equal(snapPositionMs(930, 40, config), 937.5);
});

/**
 * Verifies the shared snap config anchors beats on the detected beatgrid, so inserting and
 * dragging actions snap to the beats the ruler draws rather than a grid starting at 0 ms.
 */
test("timelineSnapConfig anchors beat snapping on the detected beatgrid", () => {
  const markers = [237, 737].map((ms, index) => ({
    time: msToDuration(ms),
    beat_index: index,
    is_downbeat: index === 0,
  }));
  const config = timelineSnapConfig({
    snapEnabled: () => true,
    useBeatgrid: () => true,
    bpm: () => 120,
    beatsPerBar: () => 4,
    beatgrid: () => ({ markers }) as unknown as types.BeatgridData,
  });

  assert.equal(config.anchorMs, 237);
  assert.deepEqual(config.markers, [237, 737]);
  assert.equal(snapPositionMs(1720, 100, config), 1737);
});

/** Verifies the shared snap config falls back to whole seconds outside beat mode. */
test("timelineSnapConfig snaps to seconds without the beatgrid", () => {
  const config = timelineSnapConfig({
    snapEnabled: () => true,
    useBeatgrid: () => false,
    bpm: () => 120,
    beatsPerBar: () => 4,
    beatgrid: () => undefined,
  });

  assert.equal(snapPositionMs(2040, 100, config), 2000);
});
