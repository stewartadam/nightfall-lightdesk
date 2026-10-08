// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { parseBuildWasmArgs, wasmPackArgs } from "./build-wasm.mjs";

/** Packages build in the order given, once each, with --dev accepted anywhere. */
test("parses packages in order and the dev flag", () => {
  assert.deepEqual(parseBuildWasmArgs(["bridge", "--dev", "demo", "bridge"]), {
    packages: ["bridge", "demo"],
    dev: true,
  });
  assert.deepEqual(parseBuildWasmArgs(["demo"]), {
    packages: ["demo"],
    dev: false,
  });
});

/** A typo or a bare --dev must fail rather than silently build nothing. */
test("rejects unknown arguments and an empty package list", () => {
  assert.throws(
    () => parseBuildWasmArgs(["brdige"]),
    /Unknown argument brdige/,
  );
  assert.throws(() => parseBuildWasmArgs(["--dev"]), /usage:/);
});

/** Release builds omit --dev; each package writes to its own web asset directory. */
test("builds wasm-pack arguments per package and profile", () => {
  assert.deepEqual(wasmPackArgs("bridge", false), [
    "build",
    "--target",
    "web",
    "--out-dir",
    "../../webui/assets/wasm",
    "crates/wasm-bridge",
  ]);
  assert.deepEqual(wasmPackArgs("demo", true), [
    "build",
    "--dev",
    "--target",
    "web",
    "--out-dir",
    "../../webui/assets/browser-runtime",
    "crates/browser-runtime",
  ]);
});
