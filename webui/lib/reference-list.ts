// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  type OwnerReferenceList,
  ReferenceDomain,
  type ReferenceEntry,
  type ReferenceOwner,
} from "../types";

/**
 * References the backend reported for each object, keyed by {@link referenceOwnerKey}, as table
 * rows that each carry their owner.
 */
export type ReferenceListByOwner = ReadonlyMap<string, ReferenceEntry[]>;

/** Order objects are listed in, matching the backend's domain order. */
const DOMAIN_ORDER: readonly ReferenceDomain[] = [
  ReferenceDomain.Group,
  ReferenceDomain.Cue,
  ReferenceDomain.Sequence,
  ReferenceDomain.Fx,
  ReferenceDomain.StepFx,
  ReferenceDomain.FxModule,
  ReferenceDomain.Flow,
  ReferenceDomain.Master,
  ReferenceDomain.PatchBinding,
];

/** Builds the key that identifies one object across list and update messages. */
export function referenceOwnerKey(
  owner: Pick<OwnerReferenceList, "domain" | "uid">,
): string {
  return `${owner.domain}:${owner.uid}`;
}

/** Builds the per-object reference map from a full `ReferenceList` message. */
export function referenceListFromOwners(
  owners: readonly OwnerReferenceList[],
): ReferenceListByOwner {
  return applyReferenceListUpdate(new Map(), owners);
}

/**
 * Returns a copy of `current` with each object in a `ReferenceListUpdate` replaced. The backend
 * describes each owner once, so every row of an object shares one owner record. An object reported
 * with no references held none or was deleted, so it is dropped.
 */
export function applyReferenceListUpdate(
  current: ReferenceListByOwner,
  owners: readonly OwnerReferenceList[],
): ReferenceListByOwner {
  const next = new Map(current);
  for (const owner of owners) {
    const key = referenceOwnerKey(owner);
    if (owner.references.length === 0) {
      next.delete(key);
    } else {
      const source: ReferenceOwner = {
        domain: owner.domain,
        uid: owner.uid,
        id: owner.id,
        label: owner.label,
      };
      next.set(
        key,
        owner.references.map((reference) => ({ source, ...reference })),
      );
    }
  }
  return next;
}

/**
 * Flattens the per-object map into table rows, ordered by object domain and ID with each
 * object's references in the order the backend found them.
 */
export function flattenReferenceList(
  list: ReferenceListByOwner,
): ReferenceEntry[] {
  const owners = [...list.values()].sort((left, right) => {
    const leftSource = left[0].source;
    const rightSource = right[0].source;
    return (
      DOMAIN_ORDER.indexOf(leftSource.domain) -
        DOMAIN_ORDER.indexOf(rightSource.domain) ||
      leftSource.id - rightSource.id ||
      leftSource.uid.localeCompare(rightSource.uid)
    );
  });
  return owners.flat();
}
