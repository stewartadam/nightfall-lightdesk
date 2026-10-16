// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import * as types from "../types/index";
import {
  applyReferenceListUpdate,
  flattenReferenceList,
  referenceListFromOwners,
} from "./reference-list";

/** Builds the references of one object, one entry per path. */
function owner(
  domain: types.ReferenceDomain,
  id: number,
  paths: string[],
): types.OwnerReferenceList {
  const uid = `${domain}-${id}`;
  return {
    domain,
    uid,
    id,
    label: `Object ${id}`,
    references: paths.map(
      (path): types.ListedReference => ({
        path,
        target: { type: "Fixture", data: { fixture_id: 1 } },
        status: types.ReferenceStatus.Ok,
      }),
    ),
  };
}

/** Returns `uid:path` for each flattened row, to assert order compactly. */
function rows(list: ReturnType<typeof referenceListFromOwners>): string[] {
  return flattenReferenceList(list).map(
    (entry) => `${entry.source.uid}:${entry.path}`,
  );
}

test("flattens objects in domain and ID order, keeping each object's path order", () => {
  const list = referenceListFromOwners([
    owner(types.ReferenceDomain.Cue, 2, ["b", "a"]),
    owner(types.ReferenceDomain.Group, 9, ["x"]),
    owner(types.ReferenceDomain.Cue, 1, ["c"]),
  ]);

  assert.deepEqual(rows(list), ["group-9:x", "cue-1:c", "cue-2:b", "cue-2:a"]);
});

test("updates replace changed objects and drop objects with no references", () => {
  const list = referenceListFromOwners([
    owner(types.ReferenceDomain.Cue, 1, ["a"]),
    owner(types.ReferenceDomain.Cue, 2, ["b"]),
  ]);

  const updated = applyReferenceListUpdate(list, [
    owner(types.ReferenceDomain.Cue, 1, ["a", "a2"]),
    owner(types.ReferenceDomain.Cue, 2, []),
    owner(types.ReferenceDomain.Master, 3, ["m"]),
  ]);

  assert.deepEqual(rows(updated), ["cue-1:a", "cue-1:a2", "master-3:m"]);
  assert.deepEqual(flattenReferenceList(updated)[2].source, {
    domain: types.ReferenceDomain.Master,
    uid: "master-3",
    id: 3,
    label: "Object 3",
  });
  assert.deepEqual(rows(list), ["cue-1:a", "cue-2:b"]);
});
