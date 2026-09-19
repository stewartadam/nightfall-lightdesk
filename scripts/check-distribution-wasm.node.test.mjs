// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkDistributionWasm } from "./check-distribution-wasm.mjs";

/** Exercise the artifact boundary with absent, native-only and demo-inclusive output trees. */
test("distribution checks require the bridge and scope the embedded engine", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "nightfall-distribution-wasm-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, "assets"));
  assert.throws(
    () => checkDistributionWasm(directory, false),
    /shared WASM bridge/,
  );
  writeFileSync(
    join(directory, "assets/nightfall_wasm_bridge_bg-abc.wasm"),
    "bridge",
  );
  checkDistributionWasm(directory, false);
  assert.throws(
    () => checkDistributionWasm(directory, true),
    /must contain its WASM engine/,
  );
  writeFileSync(
    join(directory, "assets/nightfall_browser_runtime_bg-xyz.wasm"),
    "engine",
  );
  checkDistributionWasm(directory, true);
  assert.throws(
    () => checkDistributionWasm(directory, false),
    /must not contain the demo/,
  );
});
