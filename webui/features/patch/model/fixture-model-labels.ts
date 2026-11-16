// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  libraryRevisionLabel,
  shortRevisionEtag,
} from "../../../lib/library-revision";
import type { AvailableFixtureInfo, Fixture } from "../../../types";

/** Fixture fields the model label reads. */
type LabeledFixture = Pick<Fixture, "make" | "model" | "library_asset_etag">;

/** Library fields the model label reads. */
type LabeledRevision = Pick<
  AvailableFixtureInfo,
  "asset_etag" | "gdtf_revision"
>;

/**
 * Returns the model text to show for each fixture, keyed by the fixture's position in
 * `fixtures`. A model is shown alone unless the patched fixtures of its make and model come
 * from more than one library revision; then each gets its revision appended, such as
 * `Wash (Release 2.0)`. The revision reads as the library names it, or as the start of
 * its fingerprint when the library doesn't list it or two revisions share a name, or as the
 * whole fingerprint when even those starts match.
 */
export function fixtureModelLabels(
  fixtures: readonly LabeledFixture[],
  library: readonly LabeledRevision[],
): string[] {
  const revisionsByModel = new Map<string, Set<string>>();
  for (const fixture of fixtures) {
    if (!fixture.library_asset_etag) continue;
    const key = modelKey(fixture);
    const revisions = revisionsByModel.get(key) ?? new Set<string>();
    revisions.add(fixture.library_asset_etag);
    revisionsByModel.set(key, revisions);
  }
  const libraryByEtag = new Map(
    library.map((info) => [info.asset_etag, info] as const),
  );
  // Each way of naming a revision, from friendliest to the always distinct fingerprint.
  const namings: ((etag: string) => string)[] = [
    (etag) => {
      const info = libraryByEtag.get(etag);
      return info ? libraryRevisionLabel(info) : shortRevisionEtag(etag);
    },
    shortRevisionEtag,
    (etag) => etag,
  ];
  const revisionNames = new Map<string, Map<string, string>>();
  for (const [key, revisions] of revisionsByModel) {
    if (revisions.size < 2) continue;
    for (const naming of namings) {
      const names = new Map([...revisions].map((etag) => [etag, naming(etag)]));
      revisionNames.set(key, names);
      if (new Set(names.values()).size === names.size) break;
    }
  }
  return fixtures.map((fixture) => {
    const etag = fixture.library_asset_etag;
    const name = etag && revisionNames.get(modelKey(fixture))?.get(etag);
    return name ? `${fixture.model} (${name})` : fixture.model;
  });
}

/** Identifies a make and model; the separator can't occur in either name. */
function modelKey(fixture: LabeledFixture): string {
  return `${fixture.make}\u0000${fixture.model}`;
}

/**
 * Returns the library file each fixture was patched from, keyed by the fixture's position in
 * `fixtures`: the file name the library lists for its revision, "built-in" for a listed
 * definition shipped with the app, or "" when the fixture has no revision or the library no
 * longer lists it.
 */
export function fixtureFileNames(
  fixtures: readonly Pick<Fixture, "library_asset_etag">[],
  library: readonly Pick<AvailableFixtureInfo, "asset_etag" | "file_name">[],
): string[] {
  const libraryByEtag = new Map(
    library.map((info) => [info.asset_etag, info] as const),
  );
  return fixtures.map((fixture) => {
    const etag = fixture.library_asset_etag;
    const info = etag ? libraryByEtag.get(etag) : undefined;
    if (!info) return "";
    return info.file_name ?? "built-in";
  });
}
