// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type * as types from "../../../types";
import { createDraftQueue } from "./draft-queue";

/** Builds a draft view at a version with a given fixture name. */
function view(version: number, name = "Par"): types.FixtureDraftView {
  return {
    draft_id: 1,
    origin: { type: "Blank" },
    dirty: true,
    version,
    can_undo: version > 0,
    can_redo: false,
    info: {
      name,
      short_name: name,
      long_name: name,
      manufacturer: "Acme",
      description: "",
    },
    modes: [],
    wheels: [],
    attributes: [],
    geometries: [],
    problems: [],
    lost_content: [],
  };
}

/**
 * A fake backend holding one draft: each accepted edit bumps the version
 * and renames the fixture, and an edit against an old version is refused.
 */
function backend(start = view(0)) {
  let current: types.FixtureDraftView | undefined = start;
  const sent: { base: number; edit: types.DraftEdit }[] = [];
  return {
    sent,
    draft: () => current,
    /** Applies a change made by another window. */
    elsewhere(name: string) {
      if (current) current = view(current.version + 1, name);
    },
    close() {
      current = undefined;
    },
    send: async (base: types.FixtureDraftView, edit: types.DraftEdit) => {
      sent.push({ base: base.version, edit });
      await Promise.resolve();
      if (!current || base.version !== current.version) {
        throw new Error("stale");
      }
      const name = edit.type === "SetInfo" ? edit.data.name : current.info.name;
      current = view(current.version + 1, name);
      return current;
    },
  };
}

/** Renames the fixture, keeping the other names as they are on the latest view. */
const rename = (name: string) => (draft: types.FixtureDraftView) =>
  ({
    type: "SetInfo",
    data: { ...draft.info, name },
  }) as types.DraftEdit;

/** Edits made in a quick run all apply, each built from the view the one before produced. */
test("sends a run of edits against the versions they produced", async () => {
  const fake = backend();
  const queue = createDraftQueue(fake);
  const seen = view(0);
  const results = await Promise.all([
    queue.edit(seen, rename("One")),
    queue.edit(seen, rename("Two")),
  ]);
  assert.deepEqual(
    fake.sent.map((entry) => entry.base),
    [0, 1],
  );
  assert.equal(results[1]?.info.name, "Two");
});

/** An edit made before another window changed the draft is refused rather than misapplied. */
test("keeps the stale check when another window changed the draft", async () => {
  const fake = backend();
  const queue = createDraftQueue(fake);
  const seen = view(0);
  fake.elsewhere("Theirs");
  await assert.rejects(queue.edit(seen, rename("Mine")), /stale/);
  assert.equal(fake.sent[0]?.base, 0);
  assert.equal(fake.draft()?.info.name, "Theirs");
});

/** Undo and other commands count as this window's own progress. */
test("counts commands as own progress", async () => {
  const fake = backend();
  const queue = createDraftQueue(fake);
  const seen = view(0);
  const undo = queue.command(1, async () => {
    fake.elsewhere("Undone");
    return fake.draft() as types.FixtureDraftView;
  });
  const edit = queue.edit(seen, rename("After"));
  await undo;
  assert.equal((await edit)?.info.name, "After");
});

/** Nothing is sent for a draft that closed before its turn. */
test("skips drafts that closed", async () => {
  const fake = backend();
  const queue = createDraftQueue(fake);
  fake.close();
  assert.equal(await queue.edit(view(0), rename("Gone")), undefined);
  assert.equal(await queue.command(1, async () => view(9)), undefined);
  assert.equal(fake.sent.length, 0);
});
