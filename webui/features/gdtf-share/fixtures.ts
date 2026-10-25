// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type {
  AvailableFixtureInfo,
  GdtfShareFixture,
  GdtfShareInstall,
  GdtfShareSearchResults,
} from "../../types";
import { requestGdtfShare } from "./request";

/** Path of the fixture search on the backend. */
const FIXTURES_PATH = "/api/gdtf-share/fixtures";

/**
 * Searches the engine's saved GDTF Share list for fixtures matching every word of
 * `query`, returning the page of `limit` results starting at `offset`. The first search
 * after signing in waits for the engine to fetch the list.
 */
export function searchGdtfShare(
  query: string,
  offset: number,
  limit: number,
  signal?: AbortSignal,
): Promise<GdtfShareSearchResults> {
  const params = new URLSearchParams({
    query,
    offset: String(offset),
    limit: String(limit),
  });
  return requestGdtfShare(`${FIXTURES_PATH}?${params}`, { signal });
}

/** Asks the engine to fetch the GDTF Share list again now. */
export function refreshGdtfShare(): Promise<GdtfShareSearchResults> {
  return requestGdtfShare(`${FIXTURES_PATH}/refresh`, { method: "POST" });
}

/**
 * Downloads one GDTF Share revision into the engine's fixture library folder, resolving
 * with the file it wrote and the fixture type id the archive declares.
 */
export function installGdtfShareFixture(
  fixture: GdtfShareFixture,
): Promise<GdtfShareInstall> {
  return requestGdtfShare(`${FIXTURES_PATH}/${fixture.rid}/install`, {
    method: "POST",
  });
}

/**
 * Returns the library entries of GDTF fixture type `typeId`, matched by the
 * `FixtureTypeID` both the library and GDTF Share report. No id matches nothing.
 */
export function libraryCopiesOf(
  typeId: string | null | undefined,
  library: readonly AvailableFixtureInfo[],
): AvailableFixtureInfo[] {
  if (!typeId) return [];
  return library.filter((entry) => entry.gdtf_fixture_type_id === typeId);
}
