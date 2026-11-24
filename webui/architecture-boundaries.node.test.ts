// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import test from "node:test";
import { parseSync } from "vite";

type ArchitecturalLayer =
  | "ui"
  | "widgets"
  | "providers"
  | "shell"
  | "overlays"
  | "feature";

interface SourceRole {
  layer: ArchitecturalLayer;
  feature?: string;
}

interface BoundaryViolation {
  source: string;
  target: string;
  rule: string;
}

interface BoundaryException {
  id: string;
  reason: string;
  violations: BoundaryViolation[];
}

const repoRoot = process.env.NIGHTFALL_REPO_ROOT ?? "";
if (!repoRoot) {
  throw new Error(
    "NIGHTFALL_REPO_ROOT is required for architecture boundary tests",
  );
}

const webuiRoot = resolve(repoRoot, "webui");
const exceptionsPath = resolve(
  repoRoot,
  "config",
  "architecture",
  "webui-boundary-exceptions.json",
);

/** Solid 2.0 shaped APIs on 1.x; any layer may import it, like `solid-js`. */
const SOLID_COMPAT_MODULE = "webui/lib/solid-compat";

/** Converts a platform path into a repository-relative slash-separated path. */
function repositoryPath(path: string): string {
  return relative(repoRoot, path).split(sep).join("/");
}

/** Removes a source-file extension so import targets have stable keys. */
function withoutSourceExtension(path: string): string {
  return path.replace(/\.(?:[cm]?[jt]sx?)$/, "");
}

/** Recursively returns TypeScript source files beneath one directory. */
function collectSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(path));
      continue;
    }
    if (
      entry.isFile() &&
      /\.[jt]sx?$/.test(entry.name) &&
      !entry.name.endsWith(".d.ts")
    ) {
      files.push(path);
    }
  }
  return files;
}

/** Classifies files that participate in the target frontend architecture. */
function sourceRole(path: string): SourceRole | undefined {
  const repositoryRelativePath = repositoryPath(path);
  const componentMatch = repositoryRelativePath.match(
    /^webui\/components\/(ui|widgets|providers|shell|overlays)(?:\/|$)/,
  );
  if (componentMatch?.[1]) {
    return { layer: componentMatch[1] as ArchitecturalLayer };
  }

  const featureMatch = repositoryRelativePath.match(
    /^webui\/features\/([^/]+)(?:\/|$)/,
  );
  if (featureMatch?.[1]) {
    return { layer: "feature", feature: featureMatch[1] };
  }
  return undefined;
}

/** Resolves relative module specifiers to stable repository paths. */
function resolvedImportTarget(
  sourceFile: string,
  specifier: string,
): string | undefined {
  if (!specifier.startsWith(".")) {
    return undefined;
  }
  return withoutSourceExtension(
    repositoryPath(resolve(dirname(sourceFile), specifier)),
  );
}

/** Returns the feature name owning a repository path, when applicable. */
function targetFeature(path: string): string | undefined {
  return path.match(/^webui\/features\/([^/]+)(?:\/|$)/)?.[1];
}

/** Returns whether a target is the public entrypoint of one feature. */
function isFeaturePublicEntrypoint(path: string, feature: string): boolean {
  const root = `webui/features/${feature}`;
  return path === root || path === `${root}/index`;
}

/** Describes a forbidden dependency edge for one classified source file. */
function violatedRule(role: SourceRole, target: string): string | undefined {
  if (!target.startsWith("webui/")) {
    return undefined;
  }

  // Framework shim with no app imports, shared by every layer like solid-js itself.
  if (target === SOLID_COMPAT_MODULE) {
    return undefined;
  }

  if (role.layer === "ui") {
    return target.startsWith("webui/components/ui/")
      ? undefined
      : "ui-must-only-depend-on-ui";
  }

  if (role.layer === "widgets") {
    const forbiddenPrefixes = [
      "webui/components/providers/",
      "webui/components/shell/",
      "webui/components/overlays/",
      "webui/features/",
      "webui/state/",
      "webui/lib/engine-runtime",
    ];
    return forbiddenPrefixes.some((prefix) => target.startsWith(prefix))
      ? "widgets-must-not-depend-on-application-runtime"
      : undefined;
  }

  if (role.layer === "providers") {
    return target.startsWith("webui/features/") ||
      target.startsWith("webui/components/shell/") ||
      target.startsWith("webui/components/overlays/")
      ? "providers-must-not-depend-on-presentation"
      : undefined;
  }

  if (
    role.layer === "feature" &&
    (target.startsWith("webui/components/shell/") ||
      target.startsWith("webui/components/overlays/"))
  ) {
    return "features-must-not-depend-on-shell";
  }

  const feature = targetFeature(target);
  if (
    feature &&
    feature !== role.feature &&
    !isFeaturePublicEntrypoint(target, feature)
  ) {
    return "cross-feature-imports-must-use-public-entrypoints";
  }
  return undefined;
}

/** Returns literal module specifiers from static imports, re-exports, and dynamic imports. */
function importedModuleSpecifiers(
  sourceFile: string,
  sourceText: string,
): string[] {
  const module = parseSync(sourceFile, sourceText).module;
  const specifiers = new Set(
    module.staticImports.map((entry) => entry.moduleRequest.value),
  );

  for (const entry of module.staticExports.flatMap(
    (statement) => statement.entries,
  )) {
    if (entry.moduleRequest) {
      specifiers.add(entry.moduleRequest.value);
    }
  }

  for (const entry of module.dynamicImports) {
    const request = sourceText.slice(
      entry.moduleRequest.start,
      entry.moduleRequest.end,
    );
    const quote = request[0];
    if ((quote === '"' || quote === "'") && request.at(-1) === quote) {
      specifiers.add(request.slice(1, -1));
    }
  }

  return [...specifiers];
}

/** Extracts every forbidden relative import from the target architecture. */
function currentViolations(): BoundaryViolation[] {
  const roots = [
    resolve(webuiRoot, "components"),
    resolve(webuiRoot, "features"),
  ];
  const files = roots.flatMap((root) => {
    try {
      return collectSourceFiles(root);
    } catch {
      return [];
    }
  });
  const violations: BoundaryViolation[] = [];

  for (const sourceFile of files) {
    const role = sourceRole(sourceFile);
    if (!role) {
      continue;
    }
    const sourceText = readFileSync(sourceFile, "utf8");
    const imports = importedModuleSpecifiers(sourceFile, sourceText);
    for (const importedFile of imports) {
      const target = resolvedImportTarget(sourceFile, importedFile);
      if (!target) {
        continue;
      }
      const rule = violatedRule(role, target);
      if (rule) {
        violations.push({
          source: repositoryPath(sourceFile),
          target,
          rule,
        });
      }
    }
  }

  return violations.sort((left, right) =>
    violationKey(left).localeCompare(violationKey(right)),
  );
}

/** Returns the stable comparison key for one forbidden dependency edge. */
function violationKey(violation: BoundaryViolation): string {
  return `${violation.source}->${violation.target}:${violation.rule}`;
}

/** Validates configured frontend exception groups and returns their violations. */
function configuredExceptionViolations(contents: {
  exceptions?: BoundaryException[];
}): BoundaryViolation[] {
  if (!Array.isArray(contents.exceptions)) {
    throw new Error(
      "web UI boundary exception configuration requires an exceptions array",
    );
  }

  const exceptionIds = new Set<string>();
  const violationKeys = new Set<string>();
  const violations: BoundaryViolation[] = [];
  for (const exception of contents.exceptions) {
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(exception.id)) {
      throw new Error(
        "web UI boundary exceptions require a stable lowercase kebab-case ID",
      );
    }
    if (exceptionIds.has(exception.id)) {
      throw new Error(
        `duplicate web UI boundary exception ID: ${exception.id}`,
      );
    }
    exceptionIds.add(exception.id);
    if (typeof exception.reason !== "string" || !exception.reason.trim()) {
      throw new Error("web UI boundary exceptions require a reason");
    }
    if (
      !Array.isArray(exception.violations) ||
      exception.violations.length === 0
    ) {
      throw new Error(
        "web UI boundary exceptions require at least one violation",
      );
    }
    for (const violation of exception.violations) {
      const key = violationKey(violation);
      if (violationKeys.has(key)) {
        throw new Error(`duplicate web UI boundary exception: ${key}`);
      }
      violationKeys.add(key);
      violations.push(violation);
    }
  }
  return violations.sort((left, right) =>
    violationKey(left).localeCompare(violationKey(right)),
  );
}

/** Loads the curated set of allowed frontend boundary violations. */
function exceptionViolations(): BoundaryViolation[] {
  const contents = JSON.parse(readFileSync(exceptionsPath, "utf8")) as {
    exceptions?: BoundaryException[];
  };
  return configuredExceptionViolations(contents);
}

/** Ensures frontend layers neither add violations nor retain stale exceptions. */
test("web UI architecture matches its curated boundary exceptions", () => {
  assert.deepEqual(currentViolations(), exceptionViolations());
});

/** Verifies frontend exception groups require durable descriptive metadata. */
test("web UI boundary exceptions validate their metadata", () => {
  assert.throws(
    () => configuredExceptionViolations({}),
    /requires an exceptions array/,
  );
  assert.throws(
    () =>
      configuredExceptionViolations({
        exceptions: [
          {
            id: "Temporary Exception",
            reason: "Migration",
            violations: [{ source: "source", target: "target", rule: "rule" }],
          },
        ],
      }),
    /stable lowercase kebab-case ID/,
  );
});

/** Ensures the shared component root cannot regain domain-owned files or directories. */
test("component root contains only the five shared horizontal layers", () => {
  const entries = readdirSync(resolve(webuiRoot, "components"), {
    withFileTypes: true,
  })
    .filter((entry) => !(entry.isFile() && entry.name === ".DS_Store"))
    .map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }));

  assert.deepEqual(
    entries.sort((left, right) => left.name.localeCompare(right.name)),
    [
      { name: "overlays", isDirectory: true },
      { name: "providers", isDirectory: true },
      { name: "shell", isDirectory: true },
      { name: "ui", isDirectory: true },
      { name: "widgets", isDirectory: true },
    ],
  );
});

/** Directory of the data grid workspace package. */
const DATA_GRID_PACKAGE_ROOT = "packages/data-grid";

/** Source directory of the data grid package. */
const DATA_GRID_SOURCE_ROOT = `${DATA_GRID_PACKAGE_ROOT}/src`;

/** The dependency fields of a package manifest. */
interface PackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

/** Reads a package manifest relative to the repository root. */
function readManifest(path: string): PackageManifest {
  return JSON.parse(
    readFileSync(resolve(repoRoot, path), "utf8"),
  ) as PackageManifest;
}

/** Returns the npm packages the data grid declares as dependencies or peers. */
function declaredDataGridPackages(): Set<string> {
  const manifest = readManifest(`${DATA_GRID_PACKAGE_ROOT}/package.json`);
  return new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ]);
}

/**
 * Lists the npm packages the data grid and the web UI both depend on with
 * different version ranges. Matching ranges keep a single copy installed,
 * which matters most for `solid-js`: a second copy gives the grid its own
 * reactive runtime that never sees the app's signals.
 */
function mismatchedSharedRanges(): string[] {
  const root = readManifest("package.json");
  const rootRanges = { ...root.devDependencies, ...root.dependencies };
  const grid = readManifest(`${DATA_GRID_PACKAGE_ROOT}/package.json`);
  const mismatches: string[] = [];
  for (const field of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
  ] as const) {
    for (const [name, range] of Object.entries(grid[field] ?? {})) {
      const rootRange = rootRanges[name];
      if (rootRange !== undefined && rootRange !== range) {
        mismatches.push(`${field} ${name}: ${range} (web UI: ${rootRange})`);
      }
    }
  }
  return mismatches.sort();
}

/** Returns the npm package name a bare module specifier refers to. */
function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@")
    ? parts.slice(0, 2).join("/")
    : (parts[0] ?? specifier);
}

/**
 * Lists every import that would tie the data grid package to anything it does
 * not declare: relative imports that leave its source directory and npm
 * packages missing from its dependencies and peers. Node builtins are allowed
 * in tests only.
 */
function dataGridImportViolations(): string[] {
  const declared = declaredDataGridPackages();
  const violations: string[] = [];
  for (const sourceFile of collectSourceFiles(
    resolve(repoRoot, DATA_GRID_SOURCE_ROOT),
  )) {
    const source = repositoryPath(sourceFile);
    const isTest = /\.(?:node\.)?test\.[jt]sx?$/.test(source);
    const imports = importedModuleSpecifiers(
      sourceFile,
      readFileSync(sourceFile, "utf8"),
    );
    for (const specifier of imports) {
      const target = resolvedImportTarget(sourceFile, specifier);
      const allowed = target
        ? target.startsWith(`${DATA_GRID_SOURCE_ROOT}/`)
        : declared.has(packageName(specifier)) ||
          (isTest && specifier.startsWith("node:"));
      if (!allowed) violations.push(`${source} -> ${target ?? specifier}`);
    }
  }
  return violations.sort();
}

/** Lists web UI imports that reach into a workspace package by relative path instead of its package name. */
function relativePackageImports(): string[] {
  const violations: string[] = [];
  const sourceFiles = collectSourceFiles(webuiRoot).filter(
    (file) => !repositoryPath(file).startsWith("webui/assets/"),
  );
  for (const sourceFile of sourceFiles) {
    const imports = importedModuleSpecifiers(
      sourceFile,
      readFileSync(sourceFile, "utf8"),
    );
    for (const specifier of imports) {
      const target = resolvedImportTarget(sourceFile, specifier);
      if (target?.startsWith("packages/")) {
        violations.push(`${repositoryPath(sourceFile)} -> ${target}`);
      }
    }
  }
  return violations.sort();
}

/** Keeps the data grid package free of app imports and undeclared dependencies so it can be published on its own. */
test("data grid imports only its own modules and declared packages", () => {
  assert.deepEqual(dataGridImportViolations(), []);
});

/** Keeps the data grid on the same versions of shared packages, such as `solid-js`, as the web UI. */
test("data grid shares the web UI's dependency ranges", () => {
  assert.deepEqual(mismatchedSharedRanges(), []);
});

/** Keeps the web UI consuming workspace packages through their exports, as it would once they are published. */
test("web UI imports workspace packages by package name", () => {
  assert.deepEqual(relativePackageImports(), []);
});

/** Verifies primitives cannot reach application or feature code. */
test("UI primitives reject upward dependencies", () => {
  assert.equal(
    violatedRule({ layer: "ui" }, "webui/features/cues/index"),
    "ui-must-only-depend-on-ui",
  );
});

/** Verifies every layer, including UI primitives, may use the Solid compatibility module. */
test("all layers may import the Solid compatibility module", () => {
  assert.equal(violatedRule({ layer: "ui" }, SOLID_COMPAT_MODULE), undefined);
  assert.equal(
    violatedRule({ layer: "widgets" }, SOLID_COMPAT_MODULE),
    undefined,
  );
});

/** Verifies reusable widgets cannot consume application runtime state. */
test("widgets reject application runtime dependencies", () => {
  assert.equal(
    violatedRule({ layer: "widgets" }, "webui/state/appStores"),
    "widgets-must-not-depend-on-application-runtime",
  );
});

/** Verifies cross-feature consumers use explicit public entrypoints. */
test("features reject private cross-feature imports", () => {
  const role: SourceRole = { layer: "feature", feature: "cues" };
  assert.equal(
    violatedRule(role, "webui/features/sequences/model/private"),
    "cross-feature-imports-must-use-public-entrypoints",
  );
  assert.equal(violatedRule(role, "webui/features/sequences/index"), undefined);
});
