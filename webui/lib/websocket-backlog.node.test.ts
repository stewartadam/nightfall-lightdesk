// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  createInitialWebsocketBacklogSnapshot,
  normalizeDeliveryLag,
  refreshWebsocketBacklogSnapshot,
  updateWebsocketBacklogSnapshot,
} from "./websocket-backlog";

/** Verifies invalid clock samples do not poison backlog lag statistics. */
test("normalizeDeliveryLag clamps invalid samples", () => {
  assert.equal(normalizeDeliveryLag(Number.NaN), 0);
  assert.equal(normalizeDeliveryLag(-42), 0);
  assert.equal(normalizeDeliveryLag(18.5), 18.5);
});

/** Verifies backlog updates warn only when crossing into lagging state. */
test("updateWebsocketBacklogSnapshot latches lag warnings until recovered", () => {
  const thresholds = {
    lagWarningMs: 50,
    idleRecoveryMs: 2000,
    emaAlpha: 0.5,
  };
  const initial = createInitialWebsocketBacklogSnapshot();

  const below = updateWebsocketBacklogSnapshot(initial, 50, 1000, thresholds);
  assert.equal(below.snapshot.lagging, false);
  assert.equal(below.shouldWarn, false);

  const crossed = updateWebsocketBacklogSnapshot(
    below.snapshot,
    51,
    1100,
    thresholds,
  );
  assert.equal(crossed.snapshot.lagging, true);
  assert.equal(crossed.shouldWarn, true);

  const stillLagging = updateWebsocketBacklogSnapshot(
    crossed.snapshot,
    120,
    1200,
    thresholds,
  );
  assert.equal(stillLagging.snapshot.lagging, true);
  assert.equal(stillLagging.shouldWarn, false);

  const recovered = updateWebsocketBacklogSnapshot(
    stillLagging.snapshot,
    49,
    1300,
    thresholds,
  );
  assert.equal(recovered.snapshot.lagging, false);
  assert.equal(recovered.shouldWarn, false);

  const crossedAgain = updateWebsocketBacklogSnapshot(
    recovered.snapshot,
    70,
    1400,
    thresholds,
  );
  assert.equal(crossedAgain.snapshot.lagging, true);
  assert.equal(crossedAgain.shouldWarn, true);
});

/** Verifies backlog lag uses an exponential moving average. */
test("updateWebsocketBacklogSnapshot smooths delivery lag", () => {
  const thresholds = {
    lagWarningMs: 1000,
    idleRecoveryMs: 2000,
    emaAlpha: 0.25,
  };

  const first = updateWebsocketBacklogSnapshot(
    createInitialWebsocketBacklogSnapshot(),
    100,
    1000,
    thresholds,
  );
  const second = updateWebsocketBacklogSnapshot(
    first.snapshot,
    200,
    1100,
    thresholds,
  );

  assert.equal(second.snapshot.avgDeliveryLagMs, 125);
  assert.equal(second.snapshot.maxDeliveryLagMs, 200);
});

/** Verifies zero-lag samples still seed and participate in the EMA. */
test("updateWebsocketBacklogSnapshot includes zero samples in the moving average", () => {
  const thresholds = {
    lagWarningMs: 1000,
    idleRecoveryMs: 2000,
    emaAlpha: 0.2,
  };

  const first = updateWebsocketBacklogSnapshot(
    createInitialWebsocketBacklogSnapshot(),
    0,
    1000,
    thresholds,
  );
  const second = updateWebsocketBacklogSnapshot(
    first.snapshot,
    100,
    1100,
    thresholds,
  );

  assert.equal(second.snapshot.avgDeliveryLagMs, 20);
  assert.equal(second.snapshot.sampleCount, 2);
});

/** Verifies stale lagging state recovers when websocket delivery goes idle. */
test("refreshWebsocketBacklogSnapshot clears stale lagging state after idle recovery", () => {
  const thresholds = {
    lagWarningMs: 50,
    idleRecoveryMs: 2000,
    emaAlpha: 0.5,
  };

  const lagging = updateWebsocketBacklogSnapshot(
    createInitialWebsocketBacklogSnapshot(),
    80,
    1000,
    thresholds,
  );
  const stillLagging = refreshWebsocketBacklogSnapshot(
    lagging.snapshot,
    2999,
    thresholds,
  );
  const recovered = refreshWebsocketBacklogSnapshot(
    lagging.snapshot,
    3000,
    thresholds,
  );

  assert.equal(stillLagging.lagging, true);
  assert.equal(recovered.lagging, false);
  assert.equal(recovered.avgDeliveryLagMs, 80);
  assert.equal(recovered.maxDeliveryLagMs, 80);
});
