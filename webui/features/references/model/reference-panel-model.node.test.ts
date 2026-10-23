// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  ReferenceDomain,
  type ReferenceEntry,
  type ReferenceIssue,
  ReferenceIssueReason,
  ReferenceStatus,
} from "../../../types";
import {
  filterReferenceIssues,
  filterReferences,
  matchesReferenceSearch,
  referenceRowKey,
  referenceTargetLabel,
} from "./reference-panel-model";

const PRESENT_REFERENCE: ReferenceEntry = {
  source: {
    domain: ReferenceDomain.Cue,
    id: 2,
    uid: "cue2",
    label: "Warm look",
  },
  path: "instructions[0].selection.source.Resolved[0]",
  target: { type: "Fixture", data: { fixture_id: 1 } },
  status: ReferenceStatus.Ok,
};

const MISSING_REFERENCE: ReferenceEntry = {
  source: {
    domain: ReferenceDomain.Group,
    id: 8,
    uid: "group8",
    label: "Back wash",
  },
  path: "selection.source.Resolved[1]",
  target: { type: "FixtureUid", data: { fixture_uid: "f9" } },
  status: ReferenceStatus.Missing,
};

/** Verifies every structured target formats to the label the panel shows. */
test("reference targets format as fixture, group, Blueprint and output labels", () => {
  assert.equal(
    referenceTargetLabel({
      type: "Fixture",
      data: { fixture_id: 3, element_index: 2 },
    }),
    "Fixture 3.2",
  );
  assert.equal(
    referenceTargetLabel({
      type: "Fixture",
      data: { fixture_id: 3, element_index: null as unknown as undefined },
    }),
    "Fixture 3",
  );
  assert.equal(
    referenceTargetLabel({ type: "GroupLabel", data: { label: "Wash" } }),
    'Group "Wash"',
  );
  assert.equal(
    referenceTargetLabel({ type: "OutputTarget", data: { target: "node" } }),
    "Output transport target node",
  );
});

/** Verifies reference search covers source identity, domain, target, and path text. */
test("reference search matches displayed row text case-insensitively", () => {
  assert.equal(matchesReferenceSearch(PRESENT_REFERENCE, "warm"), true);
  assert.equal(matchesReferenceSearch(PRESENT_REFERENCE, "FIXTURE 1"), true);
  assert.equal(matchesReferenceSearch(PRESENT_REFERENCE, "instructions"), true);
  assert.equal(matchesReferenceSearch(PRESENT_REFERENCE, "cue"), true);
  assert.equal(matchesReferenceSearch(PRESENT_REFERENCE, "unrelated"), false);
});

/** Verifies reference filters combine domain, search, and missing-only state. */
test("reference filters compose all toolbar controls", () => {
  const references = [PRESENT_REFERENCE, MISSING_REFERENCE];
  assert.deepEqual(filterReferences(references, "all", "", true), [
    MISSING_REFERENCE,
  ]);
  assert.deepEqual(
    filterReferences(references, ReferenceDomain.Cue, "warm", false),
    [PRESENT_REFERENCE],
  );
});

/** Verifies health rows use their domain and searchable projection. */
test("health issue filters share reference matching semantics", () => {
  const { status: _status, ...referenceFields } = MISSING_REFERENCE;
  const issue: ReferenceIssue = {
    ...referenceFields,
    reason: ReferenceIssueReason.MissingFixtureUid,
    prunable: true,
  };
  assert.deepEqual(
    filterReferenceIssues([issue], ReferenceDomain.Group, "back"),
    [issue],
  );
  assert.deepEqual(
    filterReferenceIssues([issue], ReferenceDomain.Cue, "back"),
    [],
  );
});

/** Verifies rows at the same path stay distinct when they name different targets. */
test("row keys distinguish targets that share an owner and path", () => {
  const other: ReferenceEntry = {
    ...PRESENT_REFERENCE,
    target: { type: "Fixture", data: { fixture_id: 2 } },
  };
  assert.notEqual(referenceRowKey(PRESENT_REFERENCE), referenceRowKey(other));
  assert.equal(
    referenceRowKey(PRESENT_REFERENCE),
    referenceRowKey({ ...PRESENT_REFERENCE }),
  );
});
