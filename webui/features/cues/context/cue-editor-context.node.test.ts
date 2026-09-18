// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { formatCueEditorTitle } from "../../../lib/cue-editor-title";

/** Verifies setup and release cue titles include their sequence cue number. */
test("formats setup and release cue editor titles with sequence cue numbers", () => {
  assert.equal(
    formatCueEditorTitle({
      cueId: 0,
      sequenceId: 13,
      isSetupCue: true,
    }),
    "Cue 13.0 (Setup)",
  );

  assert.equal(
    formatCueEditorTitle({
      cueId: 0,
      sequenceId: 13,
      isReleaseCue: true,
    }),
    "Cue 13.0 (Release)",
  );
});

/** Verifies cue part suffixes stay attached to the pseudo-cue number. */
test("keeps setup and release cue editor part suffixes next to cue numbers", () => {
  assert.equal(
    formatCueEditorTitle({
      cueId: 0,
      sequenceId: 13,
      partId: 2,
      hasAdditionalParts: true,
      isSetupCue: true,
    }),
    "Cue 13.0p2 (Setup)",
  );

  assert.equal(
    formatCueEditorTitle({
      cueId: 0,
      sequenceId: 13,
      partId: 2,
      hasAdditionalParts: true,
      isReleaseCue: true,
    }),
    "Cue 13.0p2 (Release)",
  );
});

/** Verifies setup and release titles remain readable before sequence metadata loads. */
test("keeps setup and release cue fallback titles without sequence metadata", () => {
  assert.equal(formatCueEditorTitle({ isSetupCue: true }), "Setup Cue");
  assert.equal(
    formatCueEditorTitle({
      partId: 1,
      hasAdditionalParts: true,
      isReleaseCue: true,
    }),
    "Release Cue p1",
  );
});

/** Verifies standard cue title formatting is preserved. */
test("keeps ordinary cue editor title formatting unchanged", () => {
  assert.equal(formatCueEditorTitle({ cueId: 4, sequenceId: 13 }), "Cue 13.4");
  assert.equal(
    formatCueEditorTitle({
      cueId: 4,
      sequenceId: 13,
      partId: 1,
      hasAdditionalParts: true,
    }),
    "Cue 13.4p1",
  );
});
