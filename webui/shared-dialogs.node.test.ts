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

/** Modal and dialog chrome that screens must reach through the shared `Dialog`, so close behavior is inherited. */
const DIALOG_CHROME = new Set(["DialogBackdrop", "DialogCloseButton", "Modal"]);

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

/** Lists the dialog chrome elements opened in a syntax tree, ignoring comments, strings and imports. */
function dialogChromeUses(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(dialogChromeUses);
  const node = value as Record<string, unknown>;
  const name = node.name as Record<string, unknown> | undefined;
  const own =
    node.type === "JSXOpeningElement" &&
    name?.type === "JSXIdentifier" &&
    DIALOG_CHROME.has(name.name as string)
      ? [name.name as string]
      : [];
  return [...own, ...Object.values(node).flatMap(dialogChromeUses)];
}

/**
 * Prevents screens from hand-building modal chrome instead of inheriting the
 * shared Dialog's close pattern. The palettes and the connection overlay are
 * not dialogs: they have no title row or close button and own their dismissal.
 */
test("dialog chrome is composed only by the shared Dialog", () => {
  const root = process.env.NIGHTFALL_REPO_ROOT;
  assert.ok(root, "NIGHTFALL_REPO_ROOT is required");
  const uses = sourceFiles(join(root, "webui")).flatMap((path) => {
    const elements = dialogChromeUses(
      parseSync(path, readFileSync(path, "utf8")).program,
    );
    return elements.length > 0
      ? [
          {
            file: relative(root, path),
            elements: [...new Set(elements)].sort(),
          },
        ]
      : [];
  });
  assert.deepEqual(uses, [
    {
      file: "webui/components/overlays/connection/index.tsx",
      elements: ["DialogBackdrop"],
    },
    {
      file: "webui/components/shell/command-palette/command-palette.tsx",
      elements: ["DialogBackdrop"],
    },
    {
      file: "webui/components/shell/command-palette/provider.tsx",
      elements: ["Modal"],
    },
    {
      file: "webui/components/ui/dialog/index.tsx",
      elements: ["DialogBackdrop", "DialogCloseButton", "Modal"],
    },
    {
      file: "webui/features/showfile/object-palette/showfile-object-palette.tsx",
      elements: ["DialogBackdrop"],
    },
  ]);
});
