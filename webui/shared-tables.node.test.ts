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
import { parseSync } from "vite";

/** Collects authored JSX sources, excluding tests and generated assets. */
function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "assets" || entry.name === "e2e"
        ? []
        : sourceFiles(path);
    }
    return /\.[jt]sx$/.test(entry.name) && !entry.name.includes(".test.")
      ? [path]
      : [];
  });
}

/** Finds native table declarations in the syntax tree, ignoring comments, strings and member names. */
function nativeTableCount(value: unknown): number {
  if (!value || typeof value !== "object") return 0;
  if (Array.isArray(value)) {
    return value.reduce((count, child) => count + nativeTableCount(child), 0);
  }
  const node = value as Record<string, unknown>;
  const name = node.name as Record<string, unknown> | undefined;
  const ownCount =
    node.type === "JSXOpeningElement" &&
    name?.type === "JSXIdentifier" &&
    name.name === "table"
      ? 1
      : 0;
  return (
    ownCount +
    Object.values(node).reduce<number>(
      (count, child) => count + nativeTableCount(child),
      0,
    )
  );
}

/** Prevents production screens and design-lab examples from bypassing the shared native table component. */
test("native table declarations belong to the shared Table component", () => {
  const root = process.env.NIGHTFALL_REPO_ROOT;
  assert.ok(root, "NIGHTFALL_REPO_ROOT is required");
  const declarations = sourceFiles(join(root, "webui")).flatMap((path) => {
    const count = nativeTableCount(
      parseSync(path, readFileSync(path, "utf8")).program,
    );
    return count > 0 ? [{ file: relative(root, path), count }] : [];
  });
  assert.deepEqual(declarations, [
    { file: "webui/components/ui/table/index.tsx", count: 1 },
  ]);
});
