// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { getRouteIdForAltFollow } from "./route-follow";

test("returns route id for alt+click on route row", () => {
  const row = {
    rowKind: "route",
    route: { id: "output-3" },
  };

  assert.equal(getRouteIdForAltFollow(row, true), "output-3");
});

test("returns null for non-route rows", () => {
  const row = {
    rowKind: "fixture",
  };

  assert.equal(getRouteIdForAltFollow(row, true), null);
});

test("returns null when alt is not pressed", () => {
  const row = {
    rowKind: "route",
    route: { id: "input-1" },
  };

  assert.equal(getRouteIdForAltFollow(row, false), null);
});

test("returns null when row is undefined", () => {
  assert.equal(getRouteIdForAltFollow(undefined, true), null);
});
