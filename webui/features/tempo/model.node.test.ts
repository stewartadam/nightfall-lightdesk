// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { TempoSnapshot } from "../../types";
import {
  beatInBar,
  extrapolateBeatPosition,
  formatBpm,
  parseBpmInput,
} from "./model";

/** Builds a steady 120 BPM 4/4 snapshot with the beat counter at 10. */
function snapshot(): TempoSnapshot {
  return {
    bpm: 120,
    effective_bpm: 120,
    target_bpm: 120,
    beats_per_bar: 4,
    beat_position: 10,
    bar_origin: 0,
    bars_before_origin: 0,
  };
}

/** Verifies the beat counter advances at the snapshot tempo and never runs backwards. */
test("extrapolateBeatPosition advances from the receive time", () => {
  assert.equal(extrapolateBeatPosition(snapshot(), 1000, 1500), 11);
  assert.equal(extrapolateBeatPosition(snapshot(), 1000, 900), 10);
});

/** Verifies extrapolation follows the corrected rate while the engine eases phase. */
test("extrapolateBeatPosition follows phase correction", () => {
  const correcting = { ...snapshot(), effective_bpm: 90 };
  assert.equal(extrapolateBeatPosition(correcting, 0, 2000), 13);
});

/** Verifies beat-in-bar wraps at the bar length and tolerates degenerate bars. */
test("beatInBar wraps within the bar", () => {
  assert.equal(beatInBar(snapshot(), 0.2), 0);
  assert.equal(beatInBar(snapshot(), 5.9), 1);
  assert.equal(beatInBar(snapshot(), 7), 3);
  assert.equal(beatInBar({ ...snapshot(), beats_per_bar: 0 }, 3), 0);
});

/** Verifies beats are counted from the bar origin after a bar-length change. */
test("beatInBar counts from the bar origin", () => {
  const regrouped = { ...snapshot(), beats_per_bar: 3, bar_origin: 9 };
  assert.equal(beatInBar(regrouped, 9.5), 0);
  assert.equal(beatInBar(regrouped, 13.2), 1);
});

/** Verifies tempos show whole numbers plainly and keep one meaningful decimal. */
test("formatBpm trims needless decimals", () => {
  assert.equal(formatBpm(128), "128");
  assert.equal(formatBpm(127.96), "128");
  assert.equal(formatBpm(127.54), "127.5");
});

/** Verifies only positive finite tempos are accepted from text input. */
test("parseBpmInput rejects blank and non-positive input", () => {
  assert.equal(parseBpmInput(" 128.5 "), 128.5);
  assert.equal(parseBpmInput(""), undefined);
  assert.equal(parseBpmInput("0"), undefined);
  assert.equal(parseBpmInput("abc"), undefined);
});
