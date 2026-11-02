// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import * as types from "../../../types";
import {
  DRAFT_STARTERS,
  draftOriginLabel,
  LIBRARY_RESULT_LIMIT,
  matchingLibraryFixtures,
  problemCounts,
} from "./start-page";

/** Builds a library listing entry with one mode. */
function fixture(
  make: string,
  model: string,
  sourceFormat = "GDTF",
): types.AvailableFixtureInfo {
  return {
    make,
    model,
    modes: ["Default"],
    source_format: sourceFormat,
    asset_etag: `${make}-${model}`,
  };
}

/** Verifies every template the backend offers has exactly one starter, after the blank one. */
test("starters cover blank and every template once", () => {
  assert.equal(DRAFT_STARTERS[0]?.source.type, "Blank");
  const templates = DRAFT_STARTERS.flatMap((starter) =>
    starter.source.type === "Template" ? [starter.source.data] : [],
  );
  assert.deepEqual(
    [...templates].sort(),
    Object.values(types.DraftTemplate).sort(),
  );
});

/** Verifies only GDTF fixtures are listed, matched on every query word and sorted by make and model. */
test("library matches are GDTF only, word matched and sorted", () => {
  const library = [
    fixture("Zeta", "Wash"),
    fixture("Acme", "Spot 300"),
    fixture("Acme", "Par", "OFL"),
    fixture("Acme", "Beam 200"),
  ];

  assert.deepEqual(
    matchingLibraryFixtures(library, "").fixtures.map((entry) => entry.model),
    ["Beam 200", "Spot 300", "Wash"],
  );
  assert.deepEqual(
    matchingLibraryFixtures(library, "acme 300").fixtures.map(
      (entry) => entry.model,
    ),
    ["Spot 300"],
  );
  assert.equal(matchingLibraryFixtures(library, "par").fixtures.length, 0);
});

/** Verifies long libraries are capped and the number left out is reported. */
test("library matches are capped at the result limit", () => {
  const library = Array.from({ length: LIBRARY_RESULT_LIMIT + 5 }, (_, index) =>
    fixture("Acme", `Model ${String(index).padStart(3, "0")}`),
  );
  const matches = matchingLibraryFixtures(library, "");
  assert.equal(matches.fixtures.length, LIBRARY_RESULT_LIMIT);
  assert.equal(matches.hidden, 5);
});

/** Verifies each draft origin reads as a short sentence naming its source. */
test("draft origins describe where a draft came from", () => {
  const entry = { make: "Acme", model: "Spot" };
  assert.equal(draftOriginLabel({ type: "Blank" }), "New fixture");
  assert.equal(
    draftOriginLabel({ type: "Template", data: types.DraftTemplate.Rgbw }),
    "New from the RGBW template",
  );
  assert.equal(
    draftOriginLabel({ type: "Duplicate", data: entry }),
    "Copy of Acme Spot",
  );
  assert.equal(
    draftOriginLabel({ type: "Edit", data: entry }),
    "Editing Acme Spot",
  );
});

/** Verifies errors and warnings are counted separately. */
test("problem counts split errors from warnings", () => {
  assert.deepEqual(
    problemCounts([
      { severity: types.ProblemSeverity.Error, message: "a" },
      { severity: types.ProblemSeverity.Warning, message: "b" },
      { severity: types.ProblemSeverity.Error, message: "c" },
    ]),
    { errors: 2, warnings: 1 },
  );
});
