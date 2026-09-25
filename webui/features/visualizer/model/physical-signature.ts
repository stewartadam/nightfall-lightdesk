// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { FixturePhysical } from "../../../types";

const signatures = new WeakMap<FixturePhysical, string>();

/**
 * Returns a string that changes whenever a fixture's photometry changes, so
 * renderers can decide to rebuild it. Store updates replace `physical`
 * objects rather than mutating them, so the serialization is cached per
 * object and computed once per definition instead of on every sync.
 */
export function fixturePhysicalSignature(
  physical: FixturePhysical | undefined,
): string {
  if (!physical) return "null";
  let signature = signatures.get(physical);
  if (signature === undefined) {
    signature = JSON.stringify(physical);
    signatures.set(physical, signature);
  }
  return signature;
}
