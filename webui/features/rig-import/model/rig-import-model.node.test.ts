// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import * as types from "../../../types";
import {
  formatPatch,
  importBlockedReason,
  importDoneMessage,
  libraryKey,
  numberingOption,
  rigImportTabCount,
  rigImportTabs,
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

/**
 * The blocked-import banner names what keeps the import from changing the show, most
 * actionable first, and stays empty while the import would change something.
 */
test("import blocked reason", () => {
  const Status = types.FixtureImportStatus;
  const preview = (
    statuses: types.FixtureImportStatus[],
    newFixtures = 0,
    sceneryChanges = 0,
  ) => ({
    newFixtures,
    updatedFixtures: 0,
    sceneryChanges,
    groups: [],
    fixtures: statuses.map((status) => ({ status })),
    scenery: [] as { status: types.SceneryImportStatus }[],
  });
  assert.equal(importBlockedReason(preview([Status.New], 1)), undefined);
  assert.equal(importBlockedReason(preview([], 0, 2)), undefined);
  assert.match(
    importBlockedReason(
      preview([Status.NeedsFixtureType, Status.NeedsFixtureType]),
    ) ?? "",
    /^2 fixtures have a fixture type Nightfall can't load/,
  );
  assert.match(
    importBlockedReason(preview([Status.AlreadyInShow, Status.Unchanged])) ??
      "",
    /^1 fixture in the show differs from the file/,
  );
  assert.equal(
    importBlockedReason(preview([Status.Unchanged])),
    "Nothing to import: the show already matches this file.",
  );
});

/** The import toast names what changed and the file it came from. */
test("import done message", () => {
  const base = { fileName: "rig.mvr", groups: [], sceneryChanges: 0 };
  assert.equal(
    importDoneMessage({ ...base, newFixtures: 2, updatedFixtures: 1 }),
    "Added 2 fixtures and updated 1 fixture from rig.mvr",
  );
  assert.equal(
    importDoneMessage({
      ...base,
      newFixtures: 1,
      updatedFixtures: 0,
      sceneryChanges: 17,
    }),
    "Added 1 fixture and imported 17 scenery objects from rig.mvr",
  );
  assert.equal(
    importDoneMessage({ ...base, newFixtures: 0, updatedFixtures: 0 }),
    "Refreshed the groups from rig.mvr",
  );
});

/** Groups and scenery tabs appear only when the preview has rows for them, and counts follow the rows. */
test("review tabs follow the preview", () => {
  const preview = {
    fixtureTypes: [{}, {}],
    groups: [],
    scenery: [{}],
    fixtures: [{}, {}, {}],
  } as unknown as types.RigImportPreview;
  assert.deepEqual(rigImportTabs(preview), ["types", "scenery", "fixtures"]);
  assert.equal(rigImportTabCount(preview, "types"), 2);
  assert.equal(rigImportTabCount(preview, "scenery"), 1);
  assert.equal(rigImportTabCount(preview, "fixtures"), 3);
  assert.deepEqual(rigImportTabs({ ...preview, scenery: [] }), [
    "types",
    "fixtures",
  ]);
});
