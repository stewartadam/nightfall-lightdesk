// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { DmxIoMode, type DmxUniverseSummary } from "../types/index";
import {
  dmxUniverseKeyId,
  dmxUniverseSnapshot,
  formatFrameAgeMs,
  getInputFreshness,
} from "./dmx-universe-data";

/** Returns a listed input universe on sACN with the given number. */
function inputSummary(universeId: number): DmxUniverseSummary {
  return {
    universe_id: universeId,
    io_mode: DmxIoMode.Input,
    transport: "sACN",
    output_transport: undefined,
    is_stale: false,
    is_self: true,
  };
}

/** Pairs a listed universe only with channel values sent for the same key. */
test("dmxUniverseSnapshot merges the matching channel values", () => {
  const summary = inputSummary(2);
  const channels = [
    {
      universe_id: 2,
      io_mode: DmxIoMode.Output,
      transport: "sACN",
      channels: new Uint8Array([9]),
      frame_age_ms: undefined,
    },
    {
      universe_id: 2,
      io_mode: DmxIoMode.Input,
      transport: "sACN",
      channels: new Uint8Array([255, 0]),
      frame_age_ms: 123,
    },
  ];

  const snapshot = dmxUniverseSnapshot(summary, channels);

  assert.deepEqual(snapshot?.channels, [255, 0]);
  assert.equal(snapshot?.frame_age_ms, 123);
  assert.equal(snapshot?.is_self, true);
  const pending = dmxUniverseSnapshot(inputSummary(3), channels);
  assert.equal(pending.channels.length, 512);
  assert.ok(pending.channels.every((value) => value === null));
  assert.equal(pending.frame_age_ms, undefined);
});

/** Key ids distinguish I/O mode, numbering space and universe number. */
test("dmxUniverseKeyId separates mode, transport and number", () => {
  const ids = new Set([
    dmxUniverseKeyId(inputSummary(1)),
    dmxUniverseKeyId({ ...inputSummary(1), io_mode: DmxIoMode.Output }),
    dmxUniverseKeyId({ ...inputSummary(1), transport: "Art-Net" }),
    dmxUniverseKeyId(inputSummary(2)),
  ]);
  assert.equal(ids.size, 4);
});

test("getInputFreshness returns live/stale status for input universes", () => {
  const live = getInputFreshness({
    io_mode: DmxIoMode.Input,
    frame_age_ms: 120,
    is_stale: false,
  });
  assert.equal(live.dot, "live");
  assert.equal(live.badgeLabel, "Live");
  assert.equal(live.ageLabel, "120 ms");

  const stale = getInputFreshness({
    io_mode: DmxIoMode.Input,
    frame_age_ms: 2300,
    is_stale: true,
  });
  assert.equal(stale.dot, "stale");
  assert.equal(stale.badgeLabel, "Stale");
  assert.equal(stale.ageLabel, "2.3 s");
});

test("formatFrameAgeMs formats undefined ages as unknown", () => {
  assert.equal(formatFrameAgeMs(undefined), "unknown");
});

test("formatFrameAgeMs renders ms for sub-second values", () => {
  assert.equal(formatFrameAgeMs(999), "999 ms");
});

test("formatFrameAgeMs renders seconds for values >= 1s and < 1m", () => {
  assert.equal(formatFrameAgeMs(1000), "1 s");
  assert.equal(formatFrameAgeMs(1250), "1.3 s");
  assert.equal(formatFrameAgeMs(59_900), "59.9 s");
});

test("formatFrameAgeMs renders minutes and seconds for values >= 1m", () => {
  assert.equal(formatFrameAgeMs(60_000), "1m 0s");
  assert.equal(formatFrameAgeMs(100_832), "1m 40s");
});
