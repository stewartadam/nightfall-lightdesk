// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { GoboStackTable, MAX_GOBO_STAGES } from "./gobo-stack-table";

/** Static masks and emitters with no active masks do not schedule redundant GPU texture uploads. */
test("unchanged mask stacks leave the texture upload version stable", () => {
  const table = new GoboStackTable();
  const initial = table.texture.version;
  table.update("open", []);
  assert.equal(table.texture.version, initial);
  const masks = [{ slot: 1, rotation: Math.PI / 3 }];
  table.update("mask", masks);
  const version = table.texture.version;
  table.update("mask", masks);
  assert.equal(table.texture.version, version);
  masks[0].rotation += 0.1;
  table.update("mask", masks);
  assert.ok(table.texture.version > version);
  table.dispose();
});

/** Stack addresses survive growth, growth releases the undersized GPU storage, released rows are reused, and open masks consume no sampling budget. */
test("gobo stack storage preserves masks across growth and removal", () => {
  const table = new GoboStackTable();
  let disposals = 0;
  table.texture.addEventListener("dispose", () => disposals++);
  const address = table.update("first", [
    { slot: 3, rotation: 0.25 },
    { slot: 0, rotation: 0 },
  ]);
  for (let i = 0; i < 300; i++) table.reserve(`fixture${i}`);
  assert.equal(disposals, 1);
  assert.equal(table.texture.image.height, 512);
  assert.equal(table.texture.image.data![0], 1);
  assert.equal(table.texture.image.data![4], 3);
  assert.equal(table.texture.image.data![5], 0.25);
  assert.equal(table.update("first", [{ slot: 4, rotation: 0 }]), address);
  table.release("first");
  assert.equal(
    table.update("replacement", [{ slot: 5, rotation: 0 }]),
    address,
  );
  assert.equal(table.update("replacement", []), 0);
  assert.equal(table.texture.image.data![0], 0);
  table.dispose();
});

/** Excess active masks are explicitly counted until the selection or emitter is removed. */
test("gobo stack reduction follows active masks", () => {
  const table = new GoboStackTable();
  const masks = Array.from({ length: MAX_GOBO_STAGES + 1 }, (_, i) => ({
    slot: i + 1,
    rotation: i,
  }));
  table.update("fixture", masks);
  assert.equal(table.reducedStacks, 1);
  assert.equal(table.texture.image.data![0], MAX_GOBO_STAGES);
  masks[0].slot = 0;
  table.update("fixture", masks);
  assert.equal(table.reducedStacks, 0);
  masks[0].slot = 1;
  table.update("fixture", masks);
  table.release("fixture");
  assert.equal(table.reducedStacks, 0);
  table.dispose();
});
