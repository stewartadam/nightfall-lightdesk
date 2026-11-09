// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type {
  Fixture,
  GdtfRevisionNote,
  LibraryRevisionMode,
} from "../../types";
import {
  defaultModeFor,
  patchedModeGroups,
  revisionChangesSince,
} from "./revision-update";

/** Builds the fields of a patched fixture the grouping reads. */
function fixture(
  id: number,
  mode: string,
  etag: string | undefined,
  model = "Wash",
): Fixture {
  return {
    identifiers: { id, uid: `uid-${id}`, label: `Fixture ${id}` },
    make: "Acme",
    model,
    mode,
    library_asset_etag: etag,
  } as unknown as Fixture;
}

/** Builds a revision mode, convertible unless `broken`. */
function mode(name: string, broken = false): LibraryRevisionMode {
  return broken
    ? { name, error: "unsupported" }
    : { name, fixture: {} as Fixture };
}

/** Builds a revision note dated at the start of 2024. */
function note(text: string): GdtfRevisionNote {
  return { text, date: "2024-01-01T00:00:00" };
}

/**
 * Groups every library fixture of the make and model that isn't on the target revision,
 * by mode, each group sorted by fixture ID.
 */
test("patchedModeGroups groups other revisions' fixtures by mode", () => {
  const groups = patchedModeGroups(
    [
      fixture(12, "Basic", "old"),
      fixture(3, "Extended", "old"),
      fixture(4, "Basic", "older"),
      fixture(5, "Basic", "new"),
      fixture(6, "Basic", "old", "Spot"),
      fixture(7, "Basic", undefined),
    ],
    "Acme",
    "Wash",
    "new",
  );
  assert.deepEqual(
    groups.map((group) => [
      group.mode,
      group.fixtures.map((f) => f.identifiers.id),
    ]),
    [
      ["Basic", [4, 12]],
      ["Extended", [3]],
    ],
  );
});

/** Prefers the same mode name, ignoring case and spaces, and skips broken modes. */
test("defaultModeFor keeps the mode name when the new revision has it", () => {
  const modes = [mode("Basic"), mode(" extended "), mode("Pixel", true)];
  assert.equal(defaultModeFor("Extended", modes), " extended ");
  assert.equal(defaultModeFor("Pixel", modes), "Basic");
  assert.equal(defaultModeFor("Basic", [mode("Basic", true)]), undefined);
});

/** Returns notes after the installed revision, or only the newest when it isn't listed. */
test("revisionChangesSince lists notes written after the installed revision", () => {
  const notes = [note("Created"), note("Fixed pan"), note("Added strobe")];
  assert.deepEqual(revisionChangesSince(notes, " fixed PAN "), {
    notes: [note("Added strobe")],
    sinceInstalled: true,
  });
  assert.deepEqual(revisionChangesSince(notes, "Unknown"), {
    notes: [note("Added strobe")],
    sinceInstalled: false,
  });
  assert.deepEqual(revisionChangesSince(notes, "Added strobe"), {
    notes: [],
    sinceInstalled: true,
  });
});
