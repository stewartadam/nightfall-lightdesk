// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type * as types from "../../../types";
import {
  formatPatch,
  libraryKey,
  numberingOption,
  withMappingMode,
  withTypeMapping,
} from "./rig-import-model";

/** Builds a library entry with the given modes. */
function libraryFixture(
  model: string,
  modes: string[],
): types.AvailableFixtureInfo {
  return {
    make: "Robe",
    model,
    modes,
    source_format: "gdtf",
    asset_etag: `etag-${model}`,
  } as types.AvailableFixtureInfo;
}

/** Numbering controls turn into the engine's option, clamping bad numbers. */
test("numbering option clamps the number", () => {
  assert.deepEqual(numberingOption("FromFile", 5), { type: "FromFile" });
  assert.deepEqual(numberingOption("Offset", 100.7), {
    type: "Offset",
    data: { by: 100 },
  });
  assert.deepEqual(numberingOption("Sequential", 0), {
    type: "Sequential",
    data: { start: 1 },
  });
  assert.deepEqual(numberingOption("Offset", Number.NaN), {
    type: "Offset",
    data: { by: 0 },
  });
});

/** Patches show one address, or each break when there are several. */
test("patch formatting", () => {
  assert.equal(formatPatch([]), "Unpatched");
  assert.equal(formatPatch([{ dmxBreak: 1, universe: 2, address: 1 }]), "2.1");
  assert.equal(
    formatPatch([
      { dmxBreak: 1, universe: 1, address: 1 },
      { dmxBreak: 2, universe: 1, address: 40 },
    ]),
    "1.1 (break 1), 1.40 (break 2)",
  );
});

/** Choosing a stand-in replaces the previous one with the fixture's first mode; clearing removes it. */
test("type mappings", () => {
  const library = [
    libraryFixture("Esprite", ["Mode 1", "Mode 2"]),
    libraryFixture("Spiider", ["Standard"]),
  ];
  let mappings = withTypeMapping(
    [],
    "Wash.gdtf",
    libraryKey(library[0]),
    library,
  );
  assert.deepEqual(mappings, [
    {
      spec: "Wash.gdtf",
      make: "Robe",
      model: "Esprite",
      revision: "etag-Esprite",
      mode: "Mode 1",
    },
  ]);
  mappings = withMappingMode(mappings, "Wash.gdtf", "Mode 2");
  assert.equal(mappings[0]?.mode, "Mode 2");
  mappings = withTypeMapping(
    mappings,
    "Wash.gdtf",
    libraryKey(library[1]),
    library,
  );
  assert.equal(mappings.length, 1);
  assert.equal(mappings[0]?.model, "Spiider");
  assert.deepEqual(withTypeMapping(mappings, "Wash.gdtf", "", library), []);
});
