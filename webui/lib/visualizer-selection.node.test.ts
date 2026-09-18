// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  applyVisualizerSelectionModifiers,
  combineVisualizerSelectionUids,
  orderedUidListsEqual,
  replaceFixtureUidsInSelection,
  replaceKnownUidsInSelection,
} from "./visualizer-selection";

test("replaceFixtureUidsInSelection replaces fixture selections and preserves non-fixtures", () => {
  assert.deepEqual(
    replaceFixtureUidsInSelection(
      ["fixture-a", "scene-object-a", "fixture-b"],
      ["fixture-a", "fixture-b", "fixture-c"],
      ["fixture-c", "fixture-c"],
    ),
    ["scene-object-a", "fixture-c"],
  );
});

/**
 * Verifies generic visualizer selection replacement preserves unrelated UIDs.
 */
test("replaceKnownUidsInSelection replaces selectable UIDs and preserves other UIDs", () => {
  assert.deepEqual(
    replaceKnownUidsInSelection(
      ["fixture-a", "scene-object-a", "fixture-b"],
      ["scene-object-a", "scene-object-b"],
      ["scene-object-b"],
    ),
    ["fixture-a", "fixture-b", "scene-object-b"],
  );
});

test("orderedUidListsEqual compares UID order and values", () => {
  assert.equal(orderedUidListsEqual(["fixture-a"], ["fixture-a"]), true);
  assert.equal(orderedUidListsEqual(["fixture-a"], ["fixture-b"]), false);
  assert.equal(
    orderedUidListsEqual(["fixture-a"], ["fixture-a", "fixture-b"]),
    false,
  );
});

/**
 * Verifies visualizer scene-object selection follows replace/add/remove modifiers.
 */
test("applyVisualizerSelectionModifiers handles replace add and remove", () => {
  const allSelectableUids = ["scene-a", "scene-b", "scene-c"];

  assert.deepEqual(
    applyVisualizerSelectionModifiers(
      ["scene-a", "stale"],
      allSelectableUids,
      ["scene-b"],
      { shiftKey: false, ctrlOrMetaKey: false },
    ),
    ["scene-b"],
  );

  assert.deepEqual(
    applyVisualizerSelectionModifiers(
      ["scene-a"],
      allSelectableUids,
      ["scene-b", "scene-b"],
      { shiftKey: true, ctrlOrMetaKey: false },
    ),
    ["scene-a", "scene-b"],
  );

  assert.deepEqual(
    applyVisualizerSelectionModifiers(
      ["scene-a", "scene-b"],
      allSelectableUids,
      ["scene-a"],
      { shiftKey: false, ctrlOrMetaKey: true },
    ),
    ["scene-b"],
  );
});

/**
 * Verifies combined visualizer selection preserves fixture-first order.
 */
test("combineVisualizerSelectionUids removes duplicate UIDs", () => {
  assert.deepEqual(
    combineVisualizerSelectionUids(
      ["fixture-a", "shared"],
      ["scene-a", "shared"],
    ),
    ["fixture-a", "shared", "scene-a"],
  );
});
