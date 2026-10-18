// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  getDeliveryLagTone,
  getFpsTone,
  TARGET_FPS,
  UI_TARGET_FPS,
  WEBSOCKET_DELIVERY_ONE_FRAME_MS,
  WEBSOCKET_DELIVERY_THREE_FRAMES_MS,
} from "./metrics";

/** Frame rates grade against their target at the 95% and 80% boundaries, and missing samples are muted. */
test("getFpsTone grades frame rate against its target", () => {
  assert.equal(getFpsTone(undefined), "muted");
  assert.equal(getFpsTone(TARGET_FPS), "success");
  assert.equal(getFpsTone(TARGET_FPS * 0.95), "success");
  assert.equal(getFpsTone(TARGET_FPS * 0.9), "warning");
  assert.equal(getFpsTone(TARGET_FPS * 0.8), "warning");
  assert.equal(getFpsTone(TARGET_FPS * 0.79), "danger");
  assert.equal(getFpsTone(0), "danger");
  assert.equal(getFpsTone(50, UI_TARGET_FPS), "warning");
});

/** Delivery lag grades against one- and three-frame budgets, and missing samples are muted. */
test("getDeliveryLagTone grades delivery lag against frame budgets", () => {
  assert.equal(getDeliveryLagTone(undefined), "muted");
  assert.equal(getDeliveryLagTone(0), "success");
  assert.equal(getDeliveryLagTone(WEBSOCKET_DELIVERY_ONE_FRAME_MS), "success");
  assert.equal(
    getDeliveryLagTone(WEBSOCKET_DELIVERY_ONE_FRAME_MS + 1),
    "warning",
  );
  assert.equal(
    getDeliveryLagTone(WEBSOCKET_DELIVERY_THREE_FRAMES_MS),
    "warning",
  );
  assert.equal(
    getDeliveryLagTone(WEBSOCKET_DELIVERY_THREE_FRAMES_MS + 1),
    "danger",
  );
});
