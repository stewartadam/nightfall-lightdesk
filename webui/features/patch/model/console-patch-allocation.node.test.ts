// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  type ConsoleOccupancy,
  findConsolePatchProblem,
  findFirstFreeConsolePatch,
  formatConsolePatchSpan,
  layoutConsolePatch,
} from "./console-patch-allocation";

/** Builds an occupancy map with `label` on channels `start..=end` of `universe`. */
function occupy(
  occupied: ConsoleOccupancy,
  universe: number,
  start: number,
  end: number,
  label = `U${universe}`,
): ConsoleOccupancy {
  for (let address = start; address <= end; address += 1) {
    occupied.set(`${universe}:${address}`, { label });
  }
  return occupied;
}

/** Fixtures pack back to back and move whole to the next universe instead of splitting. */
test("layoutConsolePatch wraps a fixture that does not fit to the next universe", () => {
  assert.deepEqual(layoutConsolePatch({ universe: 1, address: 489 }, 12, 3), [
    { universe: 1, address: 489 },
    { universe: 1, address: 501 },
    { universe: 2, address: 1 },
  ]);
});

/** A start address too close to the end of the universe is an overrun, not a silent move. */
test("findConsolePatchProblem reports a first fixture that runs past channel 512", () => {
  const placements = layoutConsolePatch({ universe: 1, address: 505 }, 12, 1);
  assert.deepEqual(findConsolePatchProblem(new Map(), placements, 12), {
    kind: "overrun",
    universe: 1,
    address: 513,
  });
});

/** Conflicts name the first used channel and the fixture that uses it. */
test("findConsolePatchProblem reports the first channel another fixture uses", () => {
  const occupied = occupy(new Map(), 2, 1, 4, "Spot 1");
  const placements = layoutConsolePatch({ universe: 1, address: 489 }, 12, 3);
  assert.deepEqual(findConsolePatchProblem(occupied, placements, 12), {
    kind: "conflict",
    universe: 2,
    address: 1,
    label: "Spot 1",
  });
});

/** An empty patch puts the first fixture at 1.1. */
test("findFirstFreeConsolePatch starts at universe 1 address 1 when nothing is patched", () => {
  assert.deepEqual(findFirstFreeConsolePatch(new Map(), 12, 4, 1), {
    universe: 1,
    address: 1,
  });
});

/** The search skips past used channels to the first gap wide enough for every fixture. */
test("findFirstFreeConsolePatch finds the first gap that fits every fixture", () => {
  const occupied = occupy(new Map(), 1, 1, 10);
  occupy(occupied, 1, 30, 40);
  assert.equal(findFirstFreeConsolePatch(occupied, 12, 1, 1)?.address, 11);
  assert.deepEqual(findFirstFreeConsolePatch(occupied, 12, 2, 1), {
    universe: 1,
    address: 41,
  });
});

/**
 * Regression for the Auto button picking the first free channel of universe 1 even
 * though the remaining fixtures spilled into channels already used in universe 2.
 */
test("findFirstFreeConsolePatch moves to a later universe when the rest of the patch would collide", () => {
  const occupied = occupy(new Map(), 1, 1, 480);
  occupy(occupied, 2, 1, 320);
  assert.deepEqual(findFirstFreeConsolePatch(occupied, 12, 4, 1), {
    universe: 2,
    address: 321,
  });
});

/** A full universe sends the patch to the first universe past every used channel. */
test("findFirstFreeConsolePatch falls through to the universe after the last used one", () => {
  const occupied = occupy(new Map(), 1, 1, 512);
  occupy(occupied, 2, 1, 512);
  assert.deepEqual(findFirstFreeConsolePatch(occupied, 12, 1, 1), {
    universe: 3,
    address: 1,
  });
});

/** Restricting the search to one universe returns null when nothing fits there. */
test("findFirstFreeConsolePatch within one universe returns null when it is full", () => {
  const occupied = occupy(new Map(), 1, 1, 505);
  assert.equal(
    findFirstFreeConsolePatch(occupied, 12, 1, 1, { withinUniverse: true }),
    null,
  );
  assert.deepEqual(
    findFirstFreeConsolePatch(occupied, 12, 1, 2, { withinUniverse: true }),
    { universe: 2, address: 1 },
  );
});

/** Tries every start address in order, as a reference for the skipping search. */
function naiveFirstFree(
  occupied: ConsoleOccupancy,
  footprint: number,
  quantity: number,
  lastUniverse: number,
) {
  for (let universe = 1; universe <= lastUniverse; universe += 1) {
    for (let address = 1; address + footprint - 1 <= 512; address += 1) {
      const placements = layoutConsolePatch(
        { universe, address },
        footprint,
        quantity,
      );
      if (!findConsolePatchProblem(occupied, placements, footprint)) {
        return { universe, address };
      }
    }
  }
  return null;
}

/** The address-skipping search agrees with trying every start on random patches. */
test("findFirstFreeConsolePatch matches an exhaustive search on random patches", () => {
  let seed = 7;
  /** Deterministic pseudo-random integer in `[0, max)`. */
  const random = (max: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % max;
  };
  for (let round = 0; round < 200; round += 1) {
    const occupied: ConsoleOccupancy = new Map();
    for (let block = 0; block < 1 + random(12); block += 1) {
      const universe = 1 + random(3);
      const start = 1 + random(512);
      occupy(occupied, universe, start, Math.min(512, start + random(80)));
    }
    const footprint = 1 + random(40);
    const quantity = 1 + random(30);
    assert.deepEqual(
      findFirstFreeConsolePatch(occupied, footprint, quantity, 1),
      naiveFirstFree(occupied, footprint, quantity, 5),
      `round ${round}: footprint ${footprint}, quantity ${quantity}`,
    );
  }
});

/** Fixtures wider than a universe can never be placed. */
test("findFirstFreeConsolePatch rejects footprints wider than a universe", () => {
  assert.equal(findFirstFreeConsolePatch(new Map(), 513, 1, 1), null);
});

/** Spans read as `start-end` in one universe and `u.start-u.end` across universes. */
test("formatConsolePatchSpan shows the universe only when the patch spans several", () => {
  assert.equal(
    formatConsolePatchSpan(
      layoutConsolePatch({ universe: 1, address: 1 }, 12, 2),
      12,
    ),
    "1-24",
  );
  assert.equal(
    formatConsolePatchSpan(
      layoutConsolePatch({ universe: 1, address: 489 }, 12, 3),
      12,
    ),
    "1.489-2.12",
  );
  assert.equal(
    formatConsolePatchSpan(
      layoutConsolePatch({ universe: 3, address: 7 }, 1, 1),
      1,
      { qualified: true },
    ),
    "3.7",
  );
  assert.equal(
    formatConsolePatchSpan(
      layoutConsolePatch({ universe: 3, address: 7 }, 12, 2),
      12,
      { qualified: true },
    ),
    "3.7–3.30",
  );
});
