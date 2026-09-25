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
  actionReferenceAllowsSurface,
  actionReferencesEqual,
  actionsAccepting,
  buildActionReference,
  formatActionReference,
  hasRequiredArguments,
} from "./action-catalog";

/** Every action surface, the default set an action may be invoked from. */
const ALL_SURFACES = [
  "timeline",
  "midi",
  "osc",
  "commandPalette",
  "keyboard",
  "websocket",
] as types.ActionSurface[];

/** Builds a catalog entry with the given ID, input kind, parameters, and allowed surfaces. */
function entry(
  id: string,
  label: string,
  input: types.ActionInputKind,
  parameters: types.ActionParameter[] = [],
  surfaces: types.ActionSurface[] = ALL_SURFACES,
): types.ActionCatalogEntry {
  return {
    descriptor: { id, label, category: "Tests", input, parameters, surfaces },
    capabilities: [],
    behaviors: [],
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
    actionsAccepting(
      catalog,
      ["trigger" as types.ActionInputKind],
      "midi" as types.ActionSurface,
    ).map((candidate) => candidate.descriptor.id),
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

/** Verifies pickers only offer actions allowed on the surface being bound. */
test("actionsAccepting hides actions restricted to other surfaces", () => {
  const restricted = [
    ...catalog,
    entry(
      "timeline.fire-cue",
      "Fire cue",
      "trigger" as types.ActionInputKind,
      [],
      ["timeline" as types.ActionSurface],
    ),
  ];
  /** Lists the trigger action IDs a surface may bind. */
  const offered = (surface: string) =>
    actionsAccepting(
      restricted,
      ["trigger" as types.ActionInputKind],
      surface as types.ActionSurface,
    ).map((candidate) => candidate.descriptor.id);

  assert.ok(offered("timeline").includes("timeline.fire-cue"));
  for (const surface of ["midi", "osc", "keyboard", "commandPalette"]) {
    assert.ok(!offered(surface).includes("timeline.fire-cue"), surface);
    assert.ok(offered(surface).includes("clip.go"), surface);
  }
});

/** Verifies unknown references are left to the backend while restricted ones are refused. */
test("actionReferenceAllowsSurface checks catalog restrictions", () => {
  const restricted = [
    entry(
      "timeline.fire-cue",
      "Fire cue",
      "trigger" as types.ActionInputKind,
      [],
      ["timeline" as types.ActionSurface],
    ),
  ];
  const midi = "midi" as types.ActionSurface;

  assert.equal(
    actionReferenceAllowsSurface(
      restricted,
      { id: "timeline.fire-cue", arguments: {} },
      midi,
    ),
    false,
  );
  assert.equal(
    actionReferenceAllowsSurface(
      restricted,
      { id: "ui.panel-Masters", arguments: {} },
      midi,
    ),
    true,
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
