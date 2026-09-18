// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

const repoRoot = process.env.NIGHTFALL_REPO_ROOT ?? process.cwd();
const componentsDir = join(repoRoot, "webui", "components");
const providerPath = join(
  componentsDir,
  "providers",
  "panel-capabilities",
  "context.tsx",
);

/** Returns TypeScript source files under a directory tree. */
function collectTypeScriptFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTypeScriptFiles(fullPath));
      continue;
    }
    if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * Verifies panel capability hooks stay imported from the non-JSX core module so
 * Solid refresh cannot recreate the provider module while remounting panels.
 */
test("panel capability hooks stay outside the provider module boundary", () => {
  const providerSource = readFileSync(providerPath, "utf8");
  assert.doesNotMatch(providerSource, /\buseContext\b/);
  assert.doesNotMatch(providerSource, /\bonCleanup\b/);
  assert.match(providerSource, /from "\.\/context-core"/);

  const corePath = join(
    componentsDir,
    "providers",
    "panel-capabilities",
    "context-core.ts",
  );
  const coreSource = readFileSync(corePath, "utf8");
  assert.match(coreSource, /import\.meta\.hot\?\.data/);
  assert.match(
    coreSource,
    /hotData\.panelCapabilityRegistryContext\s*\?\?=\s*PanelCapabilityRegistryContext/,
  );

  const providerHookImports = collectTypeScriptFiles(componentsDir)
    .filter((filePath) => filePath !== providerPath)
    .flatMap((filePath) => {
      const source = readFileSync(filePath, "utf8");
      const matches = source.matchAll(
        /import\s+\{(?<names>[^}]+)\}\s+from\s+"(?<module>[^"]*panel-capabilities\/context)";/g,
      );
      return Array.from(matches, (match) => ({
        names: match.groups?.names ?? "",
        path: relative(repoRoot, filePath),
      }));
    })
    .filter(({ names }) =>
      /\buse(?:PanelCapability|RevealObjectCapability)/.test(names),
    );

  assert.deepEqual(providerHookImports, []);
});
