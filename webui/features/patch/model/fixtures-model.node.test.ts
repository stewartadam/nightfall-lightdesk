// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { OutputRoute, OutputSource } from "../../../types";
import { fixtureOutputOccupancyKey } from "./fixtures-model";

const FIXTURE = "0f8fad5b-d9cb-469f-a165-70867728950e";
const FIXTURE_KEY = FIXTURE.replace(/-/g, "");
const OTHER = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

/** Builds a transport output route for `source` at one universe and address. */
function transportRoute(source: OutputSource, address: number): OutputRoute {
  return {
    source,
    target: {
      type: "Transport",
      data: { target: "artnet", universe: { start: 1, end: 1 }, address },
    },
    priority: 0,
    clone: false,
  };
}

/** Builds an additional-break source for the test fixture. */
function breakSource(dmxBreak: number, uid = FIXTURE): OutputSource {
  return { type: "FixtureBreak", data: { uids: [uid], dmx_break: dmxBreak } };
}

/** Verifies two breaks of one fixture patched to the same address share an occupancy key. */
test("breaks patched to the same address collide", () => {
  const primary = transportRoute(
    { type: "Fixture", data: { uids: [FIXTURE] } },
    1,
  );
  const second = transportRoute(breakSource(2), 1);
  const primaryKey = fixtureOutputOccupancyKey(primary, FIXTURE_KEY);
  assert.notEqual(primaryKey, null);
  assert.equal(fixtureOutputOccupancyKey(second, FIXTURE_KEY), primaryKey);
});

/** Verifies breaks patched to different addresses do not share an occupancy key. */
test("breaks patched to different addresses do not collide", () => {
  const second = transportRoute(breakSource(2), 1);
  const third = transportRoute(breakSource(3), 101);
  assert.notEqual(
    fixtureOutputOccupancyKey(second, FIXTURE_KEY),
    fixtureOutputOccupancyKey(third, FIXTURE_KEY),
  );
});

/** Verifies routes for other fixtures occupy nothing for the fixture. */
test("other fixtures have no occupancy key", () => {
  assert.equal(
    fixtureOutputOccupancyKey(
      transportRoute(breakSource(2, OTHER), 1),
      FIXTURE_KEY,
    ),
    null,
  );
});
