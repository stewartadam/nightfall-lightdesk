// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type {
  Fixture,
  GdtfRevisionNote,
  LibraryRevisionMode,
} from "../../types";

/** Patched fixtures of one library revision that share a mode. */
export interface PatchedModeGroup {
  /** Mode the fixtures use now. */
  mode: string;
  /** The fixtures, by fixture ID. */
  fixtures: Fixture[];
}

/**
 * Returns the patched library fixtures of `make` and `model` on any revision other than
 * `targetEtag`, grouped by the mode they use, modes and fixtures in ascending order.
 *
 * Every older revision is included, not just one, because the engine refuses an update
 * that would leave a mode on two revisions.
 */
export function patchedModeGroups(
  fixtures: Iterable<Fixture>,
  make: string,
  model: string,
  targetEtag: string,
): PatchedModeGroup[] {
  const groups = new Map<string, Fixture[]>();
  for (const fixture of fixtures) {
    if (
      fixture.make !== make ||
      fixture.model !== model ||
      !fixture.library_asset_etag ||
      fixture.library_asset_etag === targetEtag
    ) {
      continue;
    }
    const group = groups.get(fixture.mode) ?? [];
    group.push(fixture);
    groups.set(fixture.mode, group);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([mode, members]) => ({
      mode,
      fixtures: members.sort((a, b) => a.identifiers.id - b.identifiers.id),
    }));
}

/**
 * Picks the new revision's mode to offer first for fixtures in `currentMode`: the mode
 * of the same name (ignoring case and surrounding spaces) when it converts, otherwise the
 * first mode that converts. No convertible mode picks nothing.
 */
export function defaultModeFor(
  currentMode: string,
  modes: readonly LibraryRevisionMode[],
): string | undefined {
  const usable = modes.filter((mode) => mode.fixture);
  const wanted = normalized(currentMode);
  return (usable.find((mode) => normalized(mode.name) === wanted) ?? usable[0])
    ?.name;
}

/** What changed between two revisions, as far as the new file's notes tell. */
export interface RevisionChanges {
  /** Notes written after the installed revision, oldest first. */
  notes: GdtfRevisionNote[];
  /** Whether the installed revision was found in the new file's notes. */
  sinceInstalled: boolean;
}

/**
 * Returns the new file's revision notes written after `installedRevision`, the text of
 * the installed file's latest revision. When the new file doesn't list that text, the
 * installed revision can't be placed, so only the newest note is returned.
 */
export function revisionChangesSince(
  notes: readonly GdtfRevisionNote[],
  installedRevision: string | null | undefined,
): RevisionChanges {
  const wanted = installedRevision ? normalized(installedRevision) : undefined;
  let installedAt = -1;
  notes.forEach((note, index) => {
    if (wanted && normalized(note.text) === wanted) installedAt = index;
  });
  if (installedAt >= 0) {
    return { notes: notes.slice(installedAt + 1), sinceInstalled: true };
  }
  return { notes: notes.slice(-1), sinceInstalled: false };
}

/** Compares names the way GDTF editors tend to vary them: case and surrounding spaces. */
function normalized(text: string): string {
  return text.trim().toLowerCase();
}
