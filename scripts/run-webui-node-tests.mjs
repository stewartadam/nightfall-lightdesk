// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    cwd: options.cwd,
    env: {
      ...process.env,
      NODE_PATH: join(process.cwd(), "node_modules"),
      NIGHTFALL_REPO_ROOT: process.cwd(),
    },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function collectNodeTestFiles(dir) {
  const testFiles = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      testFiles.push(...collectNodeTestFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".node.test.js")) {
      testFiles.push(fullPath);
    }
  }
  return testFiles;
}

const outDir = mkdtempSync(join(tmpdir(), "nightfall-webui-node-tests-"));
const tscEntrypoint = join("node_modules", "typescript", "bin", "tsc");
const extensionLoader = join(
  process.cwd(),
  "scripts",
  "node-test-extension-loader.mjs",
);

try {
  run(process.execPath, [
    tscEntrypoint,
    "-p",
    "tsconfig.node-tests.json",
    "--outDir",
    outDir,
  ]);

  cpSync(
    join(process.cwd(), "webui", "assets", "wasm"),
    join(outDir, "webui", "assets", "wasm"),
    {
      recursive: true,
    },
  );

  const testFiles = collectNodeTestFiles(join(outDir, "webui")).sort();
  if (testFiles.length === 0) {
    throw new Error("No compiled .node.test.js files found");
  }
  const extensionLoaderUrl = pathToFileURL(extensionLoader).href;
  const relativeTestFiles = testFiles.map((testFile) =>
    relative(outDir, testFile),
  );

  run(
    process.execPath,
    [
      "--no-warnings",
      "--loader",
      extensionLoaderUrl,
      "--test",
      ...relativeTestFiles,
    ],
    { cwd: outDir },
  );
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
