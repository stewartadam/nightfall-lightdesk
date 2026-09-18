// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { getBindingIdForAltFollow } from "./binding-follow";

test("returns binding id for alt+click on binding row", () => {
  const row = {
    rowKind: "binding",
    binding: { id: "output-3" },
  };

  assert.equal(getBindingIdForAltFollow(row, true), "output-3");
});

test("returns null for non-binding rows", () => {
  const row = {
    rowKind: "fixture",
  };

  assert.equal(getBindingIdForAltFollow(row, true), null);
});

test("returns null when alt is not pressed", () => {
  const row = {
    rowKind: "binding",
    binding: { id: "input-1" },
  };

  assert.equal(getBindingIdForAltFollow(row, false), null);
});

test("returns null when row is undefined", () => {
  assert.equal(getBindingIdForAltFollow(undefined, true), null);
});
