// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type * as types from "../types/index";
import { profileMatchesRevision } from "./fixture-profile-match";

/** Builds a minimal profile response for one make/model revision. */
function profile(asset_etag: string): types.GetFixtureProfileResponse {
  return {
    info: { make: "Acme", model: "Spot", asset_etag },
  } as unknown as types.GetFixtureProfileResponse;
}

/**
 * Verifies a response for the default revision does not satisfy a request for
 * another revision, which blocked patching non-default revisions.
 */
test("profileMatchesRevision rejects a different revision of the same fixture", () => {
  const request = { make: "Acme", model: "Spot", asset_etag: "rev-b" };
  assert.equal(profileMatchesRevision(profile("rev-a"), request), false);
  assert.equal(profileMatchesRevision(profile("rev-b"), request), true);
});

/** Verifies requests without a revision accept whichever revision is default. */
test("profileMatchesRevision accepts any revision when none is requested", () => {
  assert.equal(
    profileMatchesRevision(profile("rev-a"), { make: "Acme", model: "Spot" }),
    true,
  );
});

/** Verifies responses for another make/model or missing inputs never match. */
test("profileMatchesRevision rejects other fixtures and missing values", () => {
  const request = { make: "Acme", model: "Wash", asset_etag: "rev-a" };
  assert.equal(profileMatchesRevision(profile("rev-a"), request), false);
  assert.equal(profileMatchesRevision(null, request), false);
  assert.equal(profileMatchesRevision(profile("rev-a"), null), false);
});
