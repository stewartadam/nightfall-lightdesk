// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

const repoRoot = process.env.NIGHTFALL_REPO_ROOT ?? "";
if (!repoRoot) {
  throw new Error("NIGHTFALL_REPO_ROOT is required for spec import checks");
}
const e2eRoot = join(repoRoot, "webui", "e2e");

/** Matches a dynamic import of an absolute path, which only Vite's dev server can serve. */
const sourcePathImport =
  /import\(\s*(?:\/\*[^*]*\*\/\s*)?["'`]\/[^"'`]*["'`]\s*\)/g;

/** Lists the Node-side Playwright files: specs and their helpers, not browser harnesses. */
function playwrightSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "fixtures" || entry.name === "harness"
        ? []
        : playwrightSources(path);
    }
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".node.test.ts")
      ? [path]
      : [];
  });
}

/**
 * Specs reach the app through `window.__nightfallTest` and harnesses through
 * `window.__nightfallHarness`, so they also run against the e2e production
 * build. A source-path import would only work on the dev server.
 */
test("Playwright specs do not import app source paths", () => {
  const offenders = playwrightSources(e2eRoot).flatMap((path) =>
    [...readFileSync(path, "utf8").matchAll(sourcePathImport)].map(
      (match) => `${relative(repoRoot, path)}: ${match[0]}`,
    ),
  );
  assert.deepEqual(offenders, []);
});
