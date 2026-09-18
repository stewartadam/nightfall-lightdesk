// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const repoRoot = process.env.NIGHTFALL_REPO_ROOT ?? "";

/** The controller consumes its injected context so HMR cannot split provider identity. */
test("Sequence Editor controller does not look up its injected context", () => {
  const controllerSource = readFileSync(
    resolve(
      repoRoot,
      "webui/features/sequences/controllers/sequence-editor-controller.tsx",
    ),
    "utf8",
  );

  assert.doesNotMatch(controllerSource, /useSequenceEditorContext/);
  assert.match(controllerSource, /const ctx = props\.contextValue;/);
});
