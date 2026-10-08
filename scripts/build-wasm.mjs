// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** wasm-pack crate and output directory (relative to the crate) per package. */
export const WASM_PACKAGES = {
  bridge: { crate: "crates/wasm-bridge", outDir: "../../webui/assets/wasm" },
  demo: {
    crate: "crates/browser-runtime",
    outDir: "../../webui/assets/browser-runtime",
  },
};

/** Returns the usage text listing the packages and options. */
function usage() {
  return `usage: node scripts/build-wasm.mjs <${Object.keys(WASM_PACKAGES).join("|")}>... [--dev]

Builds each named WebAssembly package with wasm-pack. Release builds are the
default; --dev builds unoptimized packages with debug assertions.`;
}

/**
 * Parses package names and the --dev flag, rejecting anything else so a typo
 * fails instead of silently building nothing.
 * @param {string[]} argv
 * @returns {{ packages: string[], dev: boolean }}
 */
export function parseBuildWasmArgs(argv) {
  const packages = [];
  let dev = false;
  for (const arg of argv) {
    if (arg === "--dev") {
      dev = true;
    } else if (Object.hasOwn(WASM_PACKAGES, arg)) {
      if (!packages.includes(arg)) packages.push(arg);
    } else {
      throw new Error(`Unknown argument ${arg}\n\n${usage()}`);
    }
  }
  if (packages.length === 0) throw new Error(usage());
  return { packages, dev };
}

/**
 * Returns the wasm-pack arguments that build one package.
 * @param {string} name
 * @param {boolean} dev
 */
export function wasmPackArgs(name, dev) {
  const { crate, outDir } = WASM_PACKAGES[name];
  return [
    "build",
    ...(dev ? ["--dev"] : []),
    "--target",
    "web",
    "--out-dir",
    outDir,
    crate,
  ];
}

/** Builds the requested packages in order and exits with the first failure. */
function main() {
  let parsed;
  try {
    parsed = parseBuildWasmArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }
  for (const name of parsed.packages) {
    const result = spawnSync("wasm-pack", wasmPackArgs(name, parsed.dev), {
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main();
}
