// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { selectStartupDraftRecovery } from "./showfile-startup";

for (const hasSavedSnapshot of [false, true]) {
  for (const hasDraft of [false, true]) {
    /** Checks every saved/draft combination without relying on modification timestamps. */
    test(`startup availability: saved=${hasSavedSnapshot}, draft=${hasDraft}`, () => {
      const recovery = selectStartupDraftRecovery(
        [
          {
            name: "tour",
            path: "tour.nightfall-show",
            hasSavedSnapshot,
            modifiedMs: null,
            draft: hasDraft
              ? { name: "tour", path: "drafts/tour.nightfall-show" }
              : null,
          },
        ],
        "tour",
      );
      if (!hasSavedSnapshot && !hasDraft) {
        assert.equal(recovery, null);
      } else {
        assert.equal(recovery?.showfileName, "tour");
        assert.equal(recovery?.hasSavedSnapshot, hasSavedSnapshot);
        assert.equal(recovery?.hasDraft, hasDraft);
      }
    });
  }
}

/** A missing last-used showfile must open the picker even when other showfiles exist. */
test("startup ignores other showfiles", () => {
  assert.equal(
    selectStartupDraftRecovery(
      [{ name: "other", path: "other.nightfall-show", hasSavedSnapshot: true }],
      "tour",
    ),
    null,
  );
  assert.equal(selectStartupDraftRecovery([], "tour"), null);
});
