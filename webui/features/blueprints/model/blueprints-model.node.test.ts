// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { Blueprint } from "../../../types";
import { nextBlueprintId, sortBlueprintsForDisplay } from "./blueprints-model";

/** Builds the blueprint fields consumed by projection tests. */
function blueprint(id: number): Blueprint {
  return {
    identifiers: { id, uid: `blueprint-${id}`, label: `Blueprint ${id}` },
  } as Blueprint;
}

/** Verifies blueprint ordering and first-gap ID allocation. */
test("orders blueprints and allocates the first free ID", () => {
  const input = [blueprint(3), blueprint(1)];
  assert.deepEqual(
    sortBlueprintsForDisplay(input).map((entry) => entry.identifiers.id),
    [1, 3],
  );
  assert.equal(nextBlueprintId(input), 2);
  assert.deepEqual(
    input.map((entry) => entry.identifiers.id),
    [3, 1],
  );
});
