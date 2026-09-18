// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type {
  ReferenceEntry,
  ReferenceIssue,
} from "../../../lib/reference-audit";
import {
  filterReferenceIssues,
  filterReferences,
  matchesReferenceSearch,
} from "./reference-panel-model";

const PRESENT_REFERENCE = {
  source: {
    domain: "cue",
    kindLabel: "Cue",
    id: 2,
    uid: "cue-2",
    label: "Warm look",
  },
  path: "selection.fixtures[0]",
  targetLabel: "Fixture 1",
  status: "ok",
} as ReferenceEntry;

const MISSING_REFERENCE = {
  ...PRESENT_REFERENCE,
  source: {
    ...PRESENT_REFERENCE.source,
    domain: "group",
    kindLabel: "Group",
    id: 8,
    label: "Back wash",
  },
  targetLabel: "Missing fixture 9",
  status: "missing",
} as ReferenceEntry;

/** Verifies reference search covers source identity, target, and path text. */
test("reference search matches projected row text case-insensitively", () => {
  assert.equal(matchesReferenceSearch(PRESENT_REFERENCE, "warm"), true);
  assert.equal(matchesReferenceSearch(PRESENT_REFERENCE, "FIXTURE 1"), true);
  assert.equal(matchesReferenceSearch(PRESENT_REFERENCE, "selection"), true);
  assert.equal(matchesReferenceSearch(PRESENT_REFERENCE, "unrelated"), false);
});

/** Verifies reference filters combine domain, search, and missing-only state. */
test("reference filters compose all toolbar controls", () => {
  const references = [PRESENT_REFERENCE, MISSING_REFERENCE];
  assert.deepEqual(filterReferences(references, "all", "", true), [
    MISSING_REFERENCE,
  ]);
  assert.deepEqual(filterReferences(references, "cue", "warm", false), [
    PRESENT_REFERENCE,
  ]);
});

/** Verifies health rows use their domain and searchable projection. */
test("health issue filters share reference matching semantics", () => {
  const { status: _status, ...referenceFields } = MISSING_REFERENCE;
  const issue = {
    ...referenceFields,
    reason: "missing-fixture-uid",
    prunable: true,
  } as ReferenceIssue;
  assert.deepEqual(filterReferenceIssues([issue], "group", "back"), [issue]);
  assert.deepEqual(filterReferenceIssues([issue], "cue", "back"), []);
});
