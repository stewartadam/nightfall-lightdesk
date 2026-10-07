// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { spawnSync } from "node:child_process";

const PROHIBITED_PACKAGES = new Set([
  "axum",
  "cpal",
  "hyper",
  "midir",
  "mio",
  "rodio",
  "app-runtime",
  "app-tauri",
  "nightfall-websocket",
  "tauri",
  "tokio",
  "wasmtime",
]);

/** Read the resolved browser-runtime dependency graph from Cargo. */
function browserDependencyGraph() {
  const result = spawnSync(
    "cargo",
    [
      "tree",
      "-p",
      "nightfall-browser-runtime",
      "--target",
      "wasm32-unknown-unknown",
      "--prefix",
      "none",
      "--format",
      "{p}",
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  return result.stdout;
}

/** Extract unique Cargo package names from `cargo tree` output. */
function packageNames(graph) {
  return new Set(
    graph
      .split("\n")
      .map((line) => line.match(/^([A-Za-z0-9_-]+) v/)?.[1])
      .filter(Boolean),
  );
}

/** Fail when the wasm32 graph includes a native service or runtime dependency. */
function main() {
  const names = packageNames(browserDependencyGraph());
  const prohibited = [...PROHIBITED_PACKAGES].filter((name) => names.has(name));
  if (prohibited.length > 0) {
    throw new Error(
      `Browser runtime contains prohibited dependencies: ${prohibited.join(", ")}`,
    );
  }
  process.stdout.write(
    `Browser runtime dependency graph passed (${names.size} unique packages).\n`,
  );
}

main();
