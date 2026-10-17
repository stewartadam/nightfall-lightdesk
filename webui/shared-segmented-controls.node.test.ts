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

/** Roles that the shared SegmentedControl and SegmentedTabs components own. */
const SEGMENTED_ROLES = new Set(["radiogroup", "radio", "tablist", "tab"]);

/**
 * Files outside `components/ui` allowed to declare these roles, each with the roles it
 * uses. Remove an entry once its file moves onto a shared component.
 */
const ALLOWED: Record<string, string[]> = {
  // Compact shell navigation is a bottom tab bar switching workspaces; SegmentedTabs is a
  // scrolling strip for in-panel content and does not fit the shell's fixed bar.
  "webui/components/shell/compact/compact-navigation.tsx": ["tab", "tablist"],
  // Step FX contribution tabs are closable, which SegmentedTabs does not support yet.
  "webui/features/fx/components/step-fx-editor/step-fx-contribution-tabs.tsx": [
    "tab",
    "tablist",
  ],
  // The step FX attribute sidebar is a vertical tab list with remove actions.
  "webui/features/fx/components/step-fx-editor/step-fx-attribute-sidebar.tsx": [
    "tab",
    "tablist",
  ],
};

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

/** Returns a node's string value when it is a string literal, unwrapping JSX expression containers. */
function stringValue(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const node = value as Record<string, unknown>;
  if (node.type === "JSXExpressionContainer")
    return stringValue(node.expression);
  if (
    (node.type === "Literal" || node.type === "StringLiteral") &&
    typeof node.value === "string"
  )
    return node.value;
  return undefined;
}

/** Returns the name of a JSX attribute or object property key, if it is a plain identifier or string. */
function keyName(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const node = value as Record<string, unknown>;
  if (node.type === "JSXIdentifier" || node.type === "Identifier")
    return node.name as string;
  return stringValue(node);
}

/**
 * Finds `role` attributes and `role:` object properties whose literal value is a segmented
 * role, in the syntax tree so comments, strings and selectors such as `'[role="tab"]'` are
 * ignored.
 */
function segmentedRoles(value: unknown, found: Set<string>): Set<string> {
  if (!value || typeof value !== "object") return found;
  if (Array.isArray(value)) {
    for (const child of value) segmentedRoles(child, found);
    return found;
  }
  const node = value as Record<string, unknown>;
  const declared =
    node.type === "JSXAttribute" && keyName(node.name) === "role"
      ? stringValue(node.value)
      : node.type === "Property" && keyName(node.key) === "role"
        ? stringValue(node.value)
        : undefined;
  if (declared && SEGMENTED_ROLES.has(declared)) found.add(declared);
  for (const child of Object.values(node)) segmentedRoles(child, found);
  return found;
}

/** Keeps radio group and tab semantics in the shared segmented components so every instance shares keyboard handling and styling. */
test("radio group and tab roles belong to shared components", () => {
  const root = process.env.NIGHTFALL_REPO_ROOT;
  assert.ok(root, "NIGHTFALL_REPO_ROOT is required");
  const declarations = Object.fromEntries(
    sourceFiles(join(root, "webui")).flatMap((path) => {
      const file = relative(root, path);
      if (file.startsWith("webui/components/ui/")) return [];
      const roles = segmentedRoles(
        parseSync(path, readFileSync(path, "utf8")).program,
        new Set(),
      );
      return roles.size > 0 ? [[file, [...roles].sort()]] : [];
    }),
  );
  assert.deepEqual(declarations, ALLOWED);
});
