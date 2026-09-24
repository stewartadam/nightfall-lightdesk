// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type * as types from "../../../types";
import {
  type ActionTargetNames,
  actionReferencesEqual,
  actionsAccepting,
  buildActionReference,
  formatActionReference,
  hasRequiredArguments,
} from "./action-catalog";

/** Builds a catalog entry with the given ID, input kind, and parameters. */
function entry(
  id: string,
  label: string,
  input: types.ActionInputKind,
  parameters: types.ActionParameter[] = [],
): types.ActionCatalogEntry {
  return {
    descriptor: { id, label, category: "Tests", input, parameters },
    capabilities: [],
  };
}

const catalog = [
  entry("control.level", "Control level", "absolute" as types.ActionInputKind, [
    {
      name: "control_index",
      label: "Control",
      kind: { type: "Control" },
      required: true,
    },
  ]),
  entry("clip.go", "Go clip", "trigger" as types.ActionInputKind, [
    { name: "clip", label: "Clip", kind: { type: "Clip" }, required: true },
  ]),
  entry(
    "programmer.clear",
    "Clear programmer",
    "trigger" as types.ActionInputKind,
  ),
];

/** Name lookups resolving one known clip. */
const names: ActionTargetNames = {
  clip: (uid) => (uid === "abc123" ? "3: Intro" : undefined),
  master: () => undefined,
  timeline: () => undefined,
  cue: () => undefined,
  panel: () => undefined,
};

test("formatActionReference renders catalog labels with resolved arguments", () => {
  assert.equal(
    formatActionReference(
      { id: "clip.go", arguments: { clip: "ABC-123" } },
      catalog,
      names,
    ),
    "Go clip: 3: Intro",
  );
  assert.equal(
    formatActionReference(
      { id: "control.level", arguments: { control_index: 4 } },
      catalog,
      names,
    ),
    "Control level: Control 4",
  );
});

test("formatActionReference keeps unknown action IDs visible", () => {
  assert.equal(
    formatActionReference({ id: "gone.action", arguments: {} }, catalog, names),
    "gone.action",
  );
});

test("actionsAccepting filters by input kind", () => {
  assert.deepEqual(
    actionsAccepting(catalog, ["trigger" as types.ActionInputKind]).map(
      (candidate) => candidate.descriptor.id,
    ),
    ["programmer.clear", "clip.go"].sort((left, right) =>
      catalog
        .find((candidate) => candidate.descriptor.id === left)!
        .descriptor.label.localeCompare(
          catalog.find((candidate) => candidate.descriptor.id === right)!
            .descriptor.label,
        ),
    ),
  );
});

test("required arguments gate reference construction", () => {
  const descriptor = catalog[1].descriptor;
  assert.equal(hasRequiredArguments(descriptor, {}), false);
  assert.equal(hasRequiredArguments(descriptor, { clip: "abc" }), true);
  assert.deepEqual(
    buildActionReference(descriptor, { clip: "abc", stale: 1 }),
    { id: "clip.go", arguments: { clip: "abc" } },
  );
});

test("actionReferencesEqual ignores UID hyphenation and key order", () => {
  assert.equal(
    actionReferencesEqual(
      {
        id: "clip.go",
        arguments: { clip: "0000000A-0000-0000-0000-000000000001", x: 1 },
      },
      {
        id: "clip.go",
        arguments: { x: 1, clip: "0000000a000000000000000000000001" },
      },
    ),
    true,
  );
  assert.equal(
    actionReferencesEqual(
      { id: "clip.go", arguments: { clip: "a" } },
      { id: "clip.stop", arguments: { clip: "a" } },
    ),
    false,
  );
});
