// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  clauseDisplayLabel,
  committedBreadcrumbLabel,
  frontierBreadcrumbLabel,
} from "./breadcrumbs";

/** Ambiguous continuations display their common ancestry without listing alternatives. */
test("frontierBreadcrumbLabel limits ambiguity to the shared clause instances", () => {
  const root = { clause: "programmer", instance: 0 };
  const selection = { clause: "programmer_selection", instance: 0 };
  assert.equal(
    frontierBreadcrumbLabel({
      state: "ambiguous_clause_path",
      paths: [
        [root, selection],
        [root, { clause: "programmer_timings", instance: 0 }],
      ],
    }),
    "Programmer",
  );
  assert.equal(
    frontierBreadcrumbLabel({
      state: "ambiguous_clause_path",
      paths: [
        [root, selection],
        [
          root,
          selection,
          { clause: "programmer_selection_identifier", instance: 0 },
        ],
      ],
    }),
    "Programmer > Selection",
  );
  assert.equal(
    frontierBreadcrumbLabel({
      state: "ambiguous_clause_path",
      paths: [
        [root, selection],
        [root, { ...selection, instance: 1 }],
      ],
    }),
    "Programmer",
  );
  assert.equal(
    frontierBreadcrumbLabel({
      state: "ambiguous_clause_path",
      paths: [[root], [{ clause: "store", instance: 0 }]],
    }),
    null,
  );
  assert.equal(
    frontierBreadcrumbLabel({ state: "ambiguous_clause_path", paths: [] }),
    null,
  );
  assert.equal(
    frontierBreadcrumbLabel({
      state: "current_clause_path",
      path: [root, selection],
    }),
    "Programmer > Selection",
  );
  assert.equal(frontierBreadcrumbLabel({ state: "none" }), null);
});

/** Verifies known grammar clauses receive concise operator-facing labels. */
test("clauseDisplayLabel maps known clauses and preserves unknown clauses", () => {
  assert.equal(clauseDisplayLabel("programmer_selection"), "Selection");
  assert.equal(clauseDisplayLabel("future_clause"), "future_clause");
});

/** Verifies committed grammar paths render in traversal order. */
test("committedBreadcrumbLabel formats committed command paths", () => {
  assert.equal(
    committedBreadcrumbLabel([
      { clause: "programmer", instance: 0 },
      { clause: "programmer_selection", instance: 0 },
    ]),
    "Programmer > Selection",
  );
  assert.equal(committedBreadcrumbLabel([]), null);
});
