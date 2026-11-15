// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type * as types from "../types/index";

/**
 * Abbreviates a library revision's content fingerprint to its leading characters, like an
 * abbreviated commit hash.
 */
export function shortRevisionEtag(etag: string): string {
  return etag.slice(0, 8);
}

/**
 * Returns a short label telling library revisions of one make/model apart: "built-in" for
 * definitions shipped with the app, the GDTF file's revision name, such as "Release 2.0",
 * or else the leading characters of the content fingerprint, like an abbreviated commit hash.
 */
export function libraryRevisionLabel(
  info: Pick<types.AvailableFixtureInfo, "asset_etag" | "gdtf_revision">,
): string {
  if (info.asset_etag.startsWith("builtin:")) return "built-in";
  return info.gdtf_revision || shortRevisionEtag(info.asset_etag);
}

/**
 * Returns the day a GDTF file's latest revision was made as `YYYY-MM-DD`, which sorts in
 * order as text, the archive's own text when it isn't a date, or "" when it records none.
 */
export function libraryRevisionDate(
  info: Pick<types.AvailableFixtureInfo, "gdtf_revision_date">,
): string {
  const date = info.gdtf_revision_date?.trim() ?? "";
  return /^\d{4}-\d{2}-\d{2}/.test(date) ? date.slice(0, 10) : date;
}
