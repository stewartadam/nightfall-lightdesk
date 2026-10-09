// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  beatInBar,
  extrapolateBeatPosition,
  formatBpm,
  parseBpmInput,
} from "./model";

/** Verifies the beat counter advances at the snapshot tempo and never runs backwards. */
test("extrapolateBeatPosition advances from the receive time", () => {
  const snapshot = {
    bpm: 120,
    target_bpm: 120,
    beats_per_bar: 4,
    beat_position: 10,
  };
  assert.equal(extrapolateBeatPosition(snapshot, 1000, 1500), 11);
  assert.equal(extrapolateBeatPosition(snapshot, 1000, 900), 10);
});

/** Verifies beat-in-bar wraps at the bar length and tolerates degenerate bars. */
test("beatInBar wraps within the bar", () => {
  assert.equal(beatInBar(0.2, 4), 0);
  assert.equal(beatInBar(5.9, 4), 1);
  assert.equal(beatInBar(7, 4), 3);
  assert.equal(beatInBar(3, 0), 0);
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
