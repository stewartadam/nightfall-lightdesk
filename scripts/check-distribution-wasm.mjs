// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Reject missing bridge assets and accidental demo-engine inclusion in native distributions. */
export function checkDistributionWasm(directory, embeddedDemo) {
  const files = readdirSync(directory, { recursive: true });
  const bridge = files.filter((file) =>
    /nightfall_wasm_bridge_bg[^/]*\.wasm$/.test(file),
  );
  const engine = files.filter((file) =>
    /nightfall_browser_runtime_bg[^/]*\.wasm$/.test(file),
  );
  assert.equal(
    bridge.length,
    1,
    "Distribution must contain exactly one shared WASM bridge",
  );
  assert.equal(
    engine.length,
    embeddedDemo ? 1 : 0,
    embeddedDemo
      ? "Demo distribution must contain its WASM engine"
      : "Native distribution must not contain the demo WASM engine",
  );
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const mode = process.argv[2];
  assert.ok(
    mode === "native" || mode === "browser-demo",
    "Expected native or browser-demo",
  );
  checkDistributionWasm(resolve("webui/dist"), mode === "browser-demo");
  process.stdout.write(`Verified ${mode} WASM distribution boundaries.\n`);
}
