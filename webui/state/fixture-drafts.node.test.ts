// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type * as types from "../types";
import { upsertFixtureDraft } from "./fixture-drafts";

/** Builds a draft view carrying only the fields the store orders and compares by. */
function view(draftId: number, version: number): types.FixtureDraftView {
  return { draft_id: draftId, version } as types.FixtureDraftView;
}

/** Verifies drafts stay in id order and a newer view replaces the held one. */
test("upsert keeps id order and takes newer views", () => {
  const drafts = upsertFixtureDraft([view(3, 0)], view(1, 0));
  assert.deepEqual(
    drafts.map((draft) => draft.draft_id),
    [1, 3],
  );
  assert.equal(upsertFixtureDraft(drafts, view(3, 2))[1]?.version, 2);
});

/** Verifies a command result or broadcast arriving late cannot roll a draft back. */
test("upsert ignores a view older than the held one", () => {
  const drafts = [view(1, 5)];
  assert.equal(upsertFixtureDraft(drafts, view(1, 4))[0]?.version, 5);
});

/** Verifies a view sent before a discard cannot bring the closed draft back. */
test("upsert ignores views of closed drafts", () => {
  assert.deepEqual(upsertFixtureDraft([], view(2, 0), new Set([2])), []);
});
