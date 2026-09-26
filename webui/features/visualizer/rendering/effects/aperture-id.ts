// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Identifies an emitter aperture across the shared optical batch as "fixtureUid:emitterName".
 * Fixture UIDs never contain ':', so the first separator splits the two parts even when
 * emitter names do.
 */

const SEPARATOR = ":";

/** Builds the batch identifier of one fixture emitter's aperture. */
export function apertureId(fixtureUid: string, emitterName: string): string {
  return `${fixtureUid}${SEPARATOR}${emitterName}`;
}

/** Splits an aperture identifier back into its fixture UID and emitter name. */
export function parseApertureId(id: string): {
  fixtureUid: string;
  emitterName: string;
} {
  const separator = id.indexOf(SEPARATOR);
  return {
    fixtureUid: id.slice(0, separator),
    emitterName: id.slice(separator + 1),
  };
}
