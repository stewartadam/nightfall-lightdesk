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

/** ARIA roles that make an element part of a menu. */
const MENU_ROLES = new Set([
  "menu",
  "menubar",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
]);

/** Directories that own menu semantics: the shared primitives and the context-menu widget. */
const MENU_OWNERS = [
  "webui/components/ui/",
  "webui/components/widgets/context-menu/",
];

type AstNode = Record<string, unknown>;

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

/** Visits every node of a syntax tree depth first. */
function walk(value: unknown, visit: (node: AstNode) => void): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  const node = value as AstNode;
  if (typeof node.type === "string") visit(node);
  for (const child of Object.values(node)) walk(child, visit);
}

/** Parses one source file into its program node. */
function parse(path: string): AstNode {
  return parseSync(path, readFileSync(path, "utf8"))
    .program as unknown as AstNode;
}

/** Returns a string literal's value, looking through a JSX expression container. */
function stringValue(value: unknown): string | undefined {
  const node = value as AstNode | null | undefined;
  if (!node) return undefined;
  if (node.type === "JSXExpressionContainer")
    return stringValue(node.expression);
  return node.type === "Literal" && typeof node.value === "string"
    ? node.value
    : undefined;
}

/** Reports whether an expression mentions `document.body` anywhere. */
function mentionsDocumentBody(value: unknown): boolean {
  let found = false;
  walk(value, (node) => {
    const object = node.object as AstNode | undefined;
    const property = node.property as AstNode | undefined;
    if (
      node.type === "MemberExpression" &&
      object?.type === "Identifier" &&
      object.name === "document" &&
      property?.type === "Identifier" &&
      property.name === "body"
    ) {
      found = true;
    }
  });
  return found;
}

/** Describes each `<Portal>` that omits `mount=` or mounts on `document.body`. */
function unhostedPortals(program: AstNode): string[] {
  const problems: string[] = [];
  walk(program, (node) => {
    const name = node.name as AstNode | undefined;
    if (node.type !== "JSXOpeningElement" || name?.name !== "Portal") return;
    const mount = (node.attributes as AstNode[]).find(
      (attribute) =>
        attribute.type === "JSXAttribute" &&
        (attribute.name as AstNode).name === "mount",
    );
    if (!mount) problems.push("no mount");
    else if (mentionsDocumentBody(mount.value)) problems.push("document.body");
  });
  return problems;
}

/** Lists the menu roles a file assigns through JSX attributes or `role:` object properties. */
function menuRoles(program: AstNode): string[] {
  const roles: string[] = [];
  walk(program, (node) => {
    let role: string | undefined;
    if (
      node.type === "JSXAttribute" &&
      (node.name as AstNode).name === "role"
    ) {
      role = stringValue(node.value);
    } else if (node.type === "Property") {
      const key = node.key as AstNode;
      const keyName = key.type === "Identifier" ? key.name : key.value;
      if (keyName === "role") role = stringValue(node.value);
    }
    if (role && MENU_ROLES.has(role)) roles.push(role);
  });
  return roles;
}

/** Returns the repository root that the node test runner provides. */
function repoRoot(): string {
  const root = process.env.NIGHTFALL_REPO_ROOT;
  assert.ok(root, "NIGHTFALL_REPO_ROOT is required");
  return root;
}

/**
 * Keeps floating UI inside open modal dialogs. A modal `<dialog>` makes
 * everything outside it inert, so portals must choose their host through
 * `overlayHost(anchor)` (or another explicit container) instead of defaulting
 * to, or naming, `document.body`.
 */
test("portals mount through an explicit host, never document.body", () => {
  const root = repoRoot();
  const problems = sourceFiles(join(root, "webui")).flatMap((path) => {
    const found = unhostedPortals(parse(path));
    return found.length > 0
      ? [{ file: relative(root, path), problems: [...new Set(found)].sort() }]
      : [];
  });
  assert.deepEqual(problems, [
    // The shared Modal portals the native <dialog> itself, which showModal()
    // lifts into the browser top layer.
    { file: "webui/components/ui/modal/index.tsx", problems: ["no mount"] },
    // The standalone worktree dashboard page has no dialog stack.
    { file: "webui/worktree-dashboard.tsx", problems: ["no mount"] },
  ]);
});

/**
 * Keeps menus on the shared primitives. Only `components/ui` and the
 * context-menu widget assign menu roles; anywhere else a menu role marks a
 * hand-built menu unless it is listed below with its reason.
 */
test("menu roles are assigned only by the shared menu components", () => {
  const root = repoRoot();
  const uses = sourceFiles(join(root, "webui")).flatMap((path) => {
    const file = relative(root, path);
    if (MENU_OWNERS.some((owner) => file.startsWith(owner))) return [];
    const roles = menuRoles(parse(path));
    return roles.length > 0
      ? [{ file, roles: [...new Set(roles)].sort() }]
      : [];
  });
  assert.deepEqual(uses, [
    // The design lab's popover menu demonstrates checkable shared MenuItems.
    { file: "webui/design-lab/main.tsx", roles: ["menu", "menuitemcheckbox"] },
    // A checkable, searchable attribute list: a shared Popover and ScrollArea
    // holding shared MenuItems that stay open while toggled.
    {
      file: "webui/features/fx/components/fx-attribute-picker.tsx",
      roles: ["menu", "menuitemcheckbox"],
    },
    // Binding choices with descriptions and removable existing bindings, built
    // from a shared Popover, MenuSurface and MenuItems.
    {
      file: "webui/features/io/components/mappable.tsx",
      roles: ["menu", "menuitem"],
    },
  ]);
});
