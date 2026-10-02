// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  type AvailableShowfile,
  deleteShowfileMessage,
  draftShowfileName,
  hasSavedShowfileRevision,
  modifiedTimeMs,
  mostRecentlyUpdatedShowfileNames,
  newestDeletedShowfile,
  savedShowfileRevisionName,
  showfileGroupModifiedTimeMs,
  showfileLoadError,
  showfileRevisionPathLabel,
} from "./showfile-discovery";

/** Verifies group recency includes saved, draft, and backup timestamps. */
test("showfile group recency uses its newest represented revision", () => {
  const showfile: AvailableShowfile = {
    name: "tour",
    path: "/shows/tour.nightfall-show",
    modified_ms: 10,
    draft: { name: "tour", path: "/drafts/tour", modified_ms: 30 },
    revisions: [{ name: "backup", path: "/backups/backup", modified_ms: 20 }],
  };
  assert.equal(showfileGroupModifiedTimeMs(showfile), 30);
});

/** Verifies most-recent badges include every showfile tied at the newest time. */
test("most recent showfile names preserve timestamp ties", () => {
  const showfiles: AvailableShowfile[] = [
    { name: "default", path: "/default", modified_ms: 10 },
    { name: "tour", path: "/tour", modified_ms: 20 },
    { name: "backup", path: "/backup", modifiedMs: 20 },
  ];
  assert.deepEqual([...mostRecentlyUpdatedShowfileNames(showfiles)].sort(), [
    "backup",
    "tour",
  ]);
});

/** Verifies backend snake-case and compatibility camel-case fields normalize. */
test("showfile discovery normalizes response field spellings", () => {
  assert.equal(modifiedTimeMs({ name: "a", path: "/a", modifiedMs: 12 }), 12);
  assert.equal(
    draftShowfileName(
      { name: "draft", path: "/draft", showfileName: "tour" },
      "default",
    ),
    "tour",
  );
  assert.equal(
    hasSavedShowfileRevision({
      name: "tour",
      path: "/tour",
      hasSavedSnapshot: false,
      modified_ms: 10,
    }),
    false,
  );
  assert.equal(
    showfileLoadError({ name: "broken", path: "/broken", loadError: "bad" }),
    "bad",
  );
});

/** Verifies revision labels retain meaningful backup roots and folder names. */
test("showfile revision labels compact filesystem paths", () => {
  assert.equal(
    showfileRevisionPathLabel("/data/backups/tour/revision", "fallback"),
    "backups/tour/revision",
  );
  assert.equal(
    savedShowfileRevisionName({
      name: "tour",
      path: "/data/tour.nightfall-show/showfile.json",
    }),
    "showfile.json",
  );
});

/** Verifies undo targets the latest trash entry for a name when it was deleted repeatedly. */
test("newest deleted showfile picks the latest entry for a name", () => {
  const trash = [
    { id: "tour-1", name: "tour", deletedAtMs: 10, expiresAtMs: 20 },
    { id: "tour-2", name: "tour", deletedAtMs: 30, expiresAtMs: 40 },
    { id: "other", name: "other", deletedAtMs: 50, expiresAtMs: 60 },
  ];
  assert.equal(newestDeletedShowfile(trash, "tour")?.id, "tour-2");
  assert.equal(newestDeletedShowfile(trash, "missing"), undefined);
});

/** Verifies the delete prompt names the draft and backups that move with the show. */
test("delete showfile message lists what moves to the trash", () => {
  assert.equal(
    deleteShowfileMessage({ name: "tour", path: "/tour" }),
    '"tour" will move to Recently deleted. You can restore it for 7 days.',
  );
  assert.equal(
    deleteShowfileMessage({
      name: "tour",
      path: "/tour",
      draft: { name: "tour", path: "/drafts/tour" },
      revisions: [
        { name: "a", path: "/backups/a" },
        { name: "b", path: "/backups/b" },
      ],
    }),
    '"tour", along with its unsaved draft and 2 backups, will move to Recently deleted. You can restore it for 7 days.',
  );
});
