// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { frozenLeadingColumnCount } from "./crud-frozen-columns";

/** Builds column stubs from IDs in display order. */
const columns = (...ids: string[]) => ids.map((id) => ({ id }));

/** Verifies the ID and Label pair is pinned, including behind a leading cue marker. */
test("frozenLeadingColumnCount pins leading marker, ID and Label columns", () => {
  assert.equal(frozenLeadingColumnCount(columns("id", "label", "type")), 2);
  assert.equal(
    frozenLeadingColumnCount(columns("marker", "id", "label", "cues")),
    3,
  );
});

/** Verifies only the leading run is pinned, and that a list always pins its first column. */
test("frozenLeadingColumnCount stops at the first other column and pins at least one", () => {
  assert.equal(frozenLeadingColumnCount(columns("id", "type", "label")), 1);
  assert.equal(frozenLeadingColumnCount(columns("name", "id")), 1);
  assert.equal(frozenLeadingColumnCount(columns("label")), 1);
});
