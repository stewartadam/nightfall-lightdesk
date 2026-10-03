// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { GoboAtlas } from "./gobo-atlas";

/** Builds an atlas whose image requests never settle, so tests observe tile bookkeeping only. */
function atlas(maxSide?: number): GoboAtlas {
  globalThis.fetch = () => new Promise<Response>(() => {});
  return new GoboAtlas(maxSide);
}

/** A tile is shared while any emitter holds its image and is reused once the last hold is released. */
test("released gobo tiles are reused", () => {
  const gobos = atlas();
  const first = gobos.load("gobo://first");
  const second = gobos.load("gobo://second");
  assert.equal(first.index, 1);
  assert.equal(second.index, 2);
  assert.equal(gobos.load("gobo://first"), first);

  gobos.release("gobo://first");
  assert.equal(gobos.load("gobo://third").index, 3);
  gobos.release("gobo://first");
  assert.equal(first.status, "failed");
  assert.equal(gobos.load("gobo://reimported").index, 1);
  gobos.dispose();
});

/** A full atlas reports an open beam for new images until a release frees a tile. */
test("a full gobo atlas recovers capacity after a release", () => {
  const gobos = atlas(1024);
  const capacity = (1024 / 256) ** 2 - 1;
  for (let i = 0; i < capacity; i++)
    assert.ok(gobos.load(`gobo://${i}`).index > 0);
  const overflow = gobos.load("gobo://overflow");
  assert.equal(overflow.index, 0);
  assert.equal(overflow.status, "failed");
  gobos.release("gobo://overflow");

  gobos.release("gobo://4");
  assert.equal(gobos.load("gobo://overflow").index, 5);
  gobos.dispose();
});
