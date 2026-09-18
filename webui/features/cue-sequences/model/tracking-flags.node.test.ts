// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { TrackingFlags } from "../../../types";
import {
  isTrackingFlagEnabled,
  setTrackingFlagEnabled,
  trackingFlagsFromMask,
  trackingFlagsMask,
  trackingFlagsSummary,
} from "./tracking-flags";

/**
 * Verifies single enum values map to their Rust enum flag bits.
 */
test("trackingFlagsMask decodes single tracking flag enum values", () => {
  assert.equal(trackingFlagsMask(TrackingFlags.HTP), 1);
  assert.equal(trackingFlagsMask(TrackingFlags.LTP), 2);
  assert.equal(trackingFlagsMask(TrackingFlags.FX), 4);
});

/**
 * Verifies composed Rust enum flag payloads preserve multiple enabled flags.
 */
test("trackingFlagsMask decodes composed tracking flag payloads", () => {
  assert.equal(trackingFlagsMask({ __Composed__: 7 }), 7);
  assert.equal(trackingFlagsMask({ __Composed__: 3 }), 3);
});

/**
 * Verifies toggling a flag returns the composed payload sent back to Rust.
 */
test("setTrackingFlagEnabled updates one tracking flag bit", () => {
  assert.deepEqual(setTrackingFlagEnabled({ __Composed__: 1 }, "LTP", true), {
    __Composed__: 3,
  });
  assert.deepEqual(setTrackingFlagEnabled({ __Composed__: 7 }, "FX", false), {
    __Composed__: 3,
  });
});

/**
 * Verifies helper predicates and summaries use operator-facing labels.
 */
test("tracking flag helpers expose operator-facing state", () => {
  const flags = trackingFlagsFromMask(5);
  assert.equal(isTrackingFlagEnabled(flags, "HTP"), true);
  assert.equal(isTrackingFlagEnabled(flags, "LTP"), false);
  assert.equal(isTrackingFlagEnabled(flags, "FX"), true);
  assert.equal(trackingFlagsSummary(flags), "Intensity and Effects");
  assert.equal(trackingFlagsSummary(trackingFlagsFromMask(0)), "None");
  assert.equal(trackingFlagsSummary(trackingFlagsFromMask(7)), "All");
});
