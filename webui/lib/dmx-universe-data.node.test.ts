// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { DmxIoMode, type OutboundDmxUniverse } from "../types/index";
import {
  formatFrameAgeMs,
  getInputFreshness,
  normalizeDmxUniverseData,
} from "./dmx-universe-data";

test("normalizeDmxUniverseData preserves freshness metadata for input universes", () => {
  const raw: OutboundDmxUniverse[] = [
    {
      universe_id: 1,
      channels: [0, 0],
      io_mode: DmxIoMode.Output,
      transport: undefined,
      frame_age_ms: undefined,
      is_stale: undefined,
      is_self: undefined,
    },
    {
      universe_id: 2,
      channels: [255, 0],
      io_mode: DmxIoMode.Input,
      transport: "sACN",
      frame_age_ms: 123,
      is_stale: false,
      is_self: true,
    },
  ];

  const normalized = normalizeDmxUniverseData(raw);
  assert.equal(normalized.length, 2);
  assert.equal(normalized[1].frame_age_ms, 123);
  assert.equal(normalized[1].is_stale, false);
  assert.equal(normalized[1].is_self, true);
});

test("getInputFreshness returns live/stale status for input universes", () => {
  const live = getInputFreshness({
    universe_id: 2,
    channels: [0],
    io_mode: DmxIoMode.Input,
    transport: "sACN",
    frame_age_ms: 120,
    is_stale: false,
    is_self: false,
  });
  assert.equal(live.dot, "live");
  assert.equal(live.badgeLabel, "Live");
  assert.equal(live.ageLabel, "120 ms");

  const stale = getInputFreshness({
    universe_id: 3,
    channels: [0],
    io_mode: DmxIoMode.Input,
    transport: "sACN",
    frame_age_ms: 2300,
    is_stale: true,
    is_self: false,
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
