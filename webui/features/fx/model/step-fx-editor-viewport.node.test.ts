// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_STEP_FX_EDITOR_VIEWPORT,
  sanitizeStepFxEditorViewportState,
  stepFxEditorViewportStorageKey,
} from "./step-fx-editor-viewport";

/** Verifies missing and malformed viewport values fall back to safe defaults. */
test("Step FX editor viewport sanitizes malformed persisted state", () => {
  assert.deepEqual(
    sanitizeStepFxEditorViewportState({
      selectedAttribute: " ",
      trackKind: "sideways",
      centerSelectedFixture: "yes",
      showAllPlayheads: null,
      previewIndex: Number.NaN,
      previewActive: 1,
    }),
    DEFAULT_STEP_FX_EDITOR_VIEWPORT,
  );
});

/** Verifies valid viewport choices survive decoding with a bounded integer index. */
test("Step FX editor viewport preserves valid persisted choices", () => {
  assert.deepEqual(
    sanitizeStepFxEditorViewportState({
      selectedAttribute: "Blue",
      trackKind: "relative",
      centerSelectedFixture: true,
      showAllPlayheads: true,
      previewIndex: 2.9,
      previewActive: false,
    }),
    {
      selectedAttribute: "Blue",
      trackKind: "relative",
      centerSelectedFixture: true,
      showAllPlayheads: true,
      previewIndex: 2,
      previewActive: false,
    },
  );
});

/** Verifies storage keys normalize UUID formatting while remaining effect-specific. */
test("Step FX editor viewport key is stable per effect", () => {
  assert.equal(
    stepFxEditorViewportStorageKey("ABCD-1234"),
    "nightfall.stepFxEditor.viewport.abcd1234",
  );
  assert.notEqual(
    stepFxEditorViewportStorageKey("ABCD-1234"),
    stepFxEditorViewportStorageKey("ABCD-5678"),
  );
});
