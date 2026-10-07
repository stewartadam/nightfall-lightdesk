// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type * as types from "../types/index";

/** Library revision a component asked the fixture library to describe. */
export type FixtureProfileRequest = {
  make: string;
  model: string;
  /** Revision fingerprint; the library's default revision when omitted. */
  asset_etag?: string;
};

/**
 * Returns whether a fixture profile response describes the requested library
 * revision.
 *
 * Several components share one profile store, so a response may describe a
 * different fixture or revision than the one a component shows. The make and
 * model must match, and the revision must match when the request names one.
 * Mode matching is left to callers, which differ in how strictly they treat
 * responses for a substituted mode.
 */
export function profileMatchesRevision(
  profile: types.GetFixtureProfileResponse | null | undefined,
  request: FixtureProfileRequest | null | undefined,
): profile is types.GetFixtureProfileResponse {
  if (!profile || !request) return false;
  if (
    profile.info.make !== request.make ||
    profile.info.model !== request.model
  ) {
    return false;
  }
  return (
    request.asset_etag === undefined ||
    profile.info.asset_etag === request.asset_etag
  );
}
