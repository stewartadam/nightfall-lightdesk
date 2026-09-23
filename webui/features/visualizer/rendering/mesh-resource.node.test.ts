// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { meshResourceKey, meshResourcePath } from "./mesh-resource";

/** Changed file contents get a new cache entry; copied archives and different modes reuse identical mesh bytes. */
test("mesh identity follows archive content and model", () => {
  const source = {
    path: "/fixtures/unit.gdtf",
    archiveSha256: "a".repeat(64),
    mode: "Basic",
  };
  assert.notEqual(
    meshResourceKey(source, "body"),
    meshResourceKey({ ...source, archiveSha256: "b".repeat(64) }, "body"),
  );
  assert.notEqual(
    meshResourceKey(source, "body"),
    meshResourceKey(source, "head"),
  );
  assert.equal(
    meshResourceKey(source, "body"),
    meshResourceKey(
      { ...source, path: "/copy/unit.gdtf", mode: "Extended" },
      "body",
    ),
  );
});

/** URL path components preserve Unicode server paths and model punctuation without dropping the revision. */
test("mesh URL carries UTF-8 source path and exact revision", () => {
  const source = {
    path: "/fixtures/灯 — modèle.gdtf",
    archiveSha256: "a".repeat(64),
    mode: "Basic",
  };
  const path = meshResourcePath(source, "Body + lens");
  const parts = path.split("/");
  assert.equal(parts.length, 6);
  assert.equal(
    Buffer.from(parts[3], "base64url").toString("utf8"),
    source.path,
  );
  assert.equal(parts[4], source.archiveSha256);
  assert.equal(decodeURIComponent(parts[5]), "Body + lens");
});
