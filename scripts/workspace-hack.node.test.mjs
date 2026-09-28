// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const HACK = "nightfall-workspace-hack";
const NATIVE_ONLY = 'cfg(not(target_arch = "wasm32"))';

/** Reads the workspace members hakari excludes, which must not depend on the workspace-hack. */
function traversalExcludedMembers() {
  const config = readFileSync(
    new URL("../.config/hakari.toml", import.meta.url),
    "utf8",
  );
  const list = config.match(/^workspace-members\s*=\s*\[([^\]]*)\]/m)?.[1];
  return new Set([...(list ?? "").matchAll(/"([^"]+)"/g)].map(([, n]) => n));
}

/** Reads the workspace packages from Cargo metadata without resolving dependencies. */
function workspacePackages() {
  return JSON.parse(
    execFileSync("cargo", ["metadata", "--no-deps", "--format-version=1"], {
      encoding: "utf8",
    }),
  ).packages;
}

/**
 * Keeps the hakari workspace-hack out of wasm32 builds: it unifies native-only
 * features (such as Tokio networking via mio) that do not compile for wasm32, so
 * every traversed crate must declare it only as a native-target normal dependency.
 */
test("every crate depends on the workspace-hack for native targets only", () => {
  const excluded = traversalExcludedMembers();
  assert.ok(
    !excluded.has("app-tauri"),
    "app-tauri must stay traversed so its shared-crate features do not re-key other builds",
  );
  const members = workspacePackages().filter(
    (pkg) => pkg.name !== HACK && !excluded.has(pkg.name),
  );
  assert.ok(members.length > 0);
  for (const pkg of members) {
    const declarations = pkg.dependencies.filter((dep) => dep.name === HACK);
    assert.deepEqual(
      declarations.map(({ kind, target }) => ({ kind, target })),
      [{ kind: null, target: NATIVE_ONLY }],
      `${pkg.name} must declare ${HACK} once under [target.'${NATIVE_ONLY}'.dependencies]`,
    );
  }
});

/**
 * Proc macros compile for the host even in a wasm32 build, where the native-only
 * gate holds, so a workspace-hack dependency would build the whole native feature
 * union for every browser build; they must be excluded from hakari's traversal.
 */
test("proc-macro crates are excluded from the workspace-hack", () => {
  const excluded = traversalExcludedMembers();
  const procMacros = workspacePackages().filter((pkg) =>
    pkg.targets.some((target) => target.kind.includes("proc-macro")),
  );
  assert.ok(procMacros.length > 0);
  for (const pkg of procMacros) {
    assert.ok(
      excluded.has(pkg.name),
      `${pkg.name} is a proc-macro crate; add it to [traversal-excludes] workspace-members in .config/hakari.toml`,
    );
  }
});
