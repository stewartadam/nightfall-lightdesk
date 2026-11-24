// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const packageRoot = join(repoRoot, "packages", "data-grid");
const manifest = JSON.parse(
  readFileSync(join(packageRoot, "package.json"), "utf8"),
);

/** Directory the published layout is built into, standing in for the package root. */
let buildRoot;

/**
 * Builds the package the way `pnpm run build` does, but into a temporary
 * directory so the test never touches a developer's `dist/`.
 */
before(() => {
  buildRoot = mkdtempSync(join(tmpdir(), "nightfall-data-grid-build-"));
  const dist = join(buildRoot, "dist");
  /** Runs a Node entry point in the package root, throwing on a non-zero exit. */
  const run = (args) =>
    execFileSync(process.execPath, args, { cwd: packageRoot, stdio: "pipe" });
  run([
    join(repoRoot, "node_modules", "vite", "bin", "vite.js"),
    "build",
    "--logLevel",
    "error",
    "--outDir",
    dist,
    "--emptyOutDir",
  ]);
  run([
    join(repoRoot, "node_modules", "typescript", "bin", "tsc"),
    "-p",
    "tsconfig.build.json",
    "--outDir",
    join(dist, "source"),
    "--declarationDir",
    join(dist, "types"),
  ]);
});

/** Removes the temporary build. */
after(() => {
  if (buildRoot) rmSync(buildRoot, { recursive: true, force: true });
});

/** Lists every file path the published `exports` map points at, across all conditions. */
function publishedExportTargets() {
  return Object.values(manifest.publishConfig.exports).flatMap((target) =>
    typeof target === "string" ? [target] : Object.values(target),
  );
}

/** Matches the module specifier of static imports, re-exports, side-effect imports and dynamic imports. */
const MODULE_SPECIFIER_PATTERN =
  /(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g;

/** Returns the bare module specifiers an ES module imports or re-exports. */
function bareImports(file) {
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(MODULE_SPECIFIER_PATTERN)]
    .map(([, specifier]) => specifier)
    .filter((specifier) => !specifier.startsWith("."));
}

/** Lists the JavaScript files beneath a directory. */
function javaScriptFiles(directory) {
  return readdirSync(directory, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && /\.jsx?$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
}

/** Every path a consumer can import from the published package exists after a build. */
test("published exports resolve to built files", () => {
  const missing = publishedExportTargets().filter(
    (target) => !existsSync(join(buildRoot, target)),
  );
  assert.deepEqual(missing, []);
});

/** The published tarball ships the README and license next to the build. */
test("published files include the README and license", () => {
  for (const file of ["README.md", "LICENSE"]) {
    assert.ok(manifest.files.includes(file), `${file} is listed in files`);
    assert.ok(existsSync(join(packageRoot, file)), `${file} exists`);
  }
});

/**
 * Compiled modules and the preserved-JSX source import dependencies instead of
 * bundling them, and only the ones the manifest declares, so consumers share
 * one copy of Solid and TanStack.
 */
test("compiled modules import only declared dependencies", () => {
  const declared = [
    ...Object.keys(manifest.dependencies),
    ...Object.keys(manifest.peerDependencies),
  ];
  const dist = join(buildRoot, "dist");
  const builtModules = [
    ...["index.js", "data-grid-types.js", "dropdown-cell.js"].map((file) =>
      join(dist, file),
    ),
    ...javaScriptFiles(join(dist, "source")),
  ];
  const undeclared = builtModules
    .flatMap((file) => bareImports(file))
    .filter(
      (specifier) =>
        !declared.some(
          (name) => specifier === name || specifier.startsWith(`${name}/`),
        ),
    );
  assert.deepEqual(undeclared, []);
  assert.ok(
    bareImports(join(buildRoot, "dist", "index.js")).includes("solid-js"),
    "index.js imports solid-js rather than bundling it",
  );
});

/**
 * The published stylesheet carries the grid's own rules and the Tailwind
 * utilities its markup uses, without Tailwind's preflight reset.
 */
test("published stylesheet holds grid rules and utilities but no preflight", () => {
  const css = readFileSync(join(buildRoot, "dist", "styles.css"), "utf8");
  assert.match(css, /\[role="grid"\]/);
  assert.match(css, /--data-grid-bg:/);
  assert.match(css, /\.whitespace-nowrap\s*\{/);
  assert.doesNotMatch(css, /@layer base/);
});

/**
 * Lays out the built package as an installed dependency of a scratch project:
 * a copy of the build and the published manifest (with `publishConfig.exports` swapped in, as pnpm does
 * on publish), with the package's dependencies linked in. The build is
 * copied, not linked, so its imports resolve from the scratch project.
 */
function installBuiltPackage(projectRoot) {
  const installed = join(
    projectRoot,
    "node_modules",
    "@stewartadam",
    "nightfall-data-grid",
  );
  mkdirSync(dirname(installed), { recursive: true });
  mkdirSync(installed);
  cpSync(join(buildRoot, "dist"), join(installed, "dist"), { recursive: true });
  const { publishConfig, ...published } = manifest;
  writeFileSync(
    join(installed, "package.json"),
    JSON.stringify({ ...published, exports: publishConfig.exports }),
  );
  for (const name of [
    ...Object.keys(manifest.dependencies),
    ...Object.keys(manifest.peerDependencies),
  ]) {
    const target = join(projectRoot, "node_modules", name);
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(realpathSync(join(packageRoot, "node_modules", name)), target);
  }
}

/**
 * The published type declarations resolve under Node's ESM resolution
 * (`moduleResolution: nodenext`), which needs explicit file extensions, and
 * still type-check a consumer's use of the grid.
 */
test("published types resolve under nodenext module resolution", () => {
  const projectRoot = join(buildRoot, "consumer");
  mkdirSync(projectRoot);
  installBuiltPackage(projectRoot);
  writeFileSync(
    join(projectRoot, "package.json"),
    JSON.stringify({ type: "module" }),
  );
  writeFileSync(
    join(projectRoot, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "nodenext",
        moduleResolution: "nodenext",
        target: "es2022",
        lib: ["es2022", "dom"],
        strict: true,
        noEmit: true,
        jsx: "preserve",
        jsxImportSource: "solid-js",
        skipLibCheck: true,
      },
      include: ["app.tsx"],
    }),
  );
  writeFileSync(
    join(projectRoot, "app.tsx"),
    [
      'import DataGrid, { createKeyedDataGridCellProvider, type DataGridProps } from "@stewartadam/nightfall-data-grid";',
      'import { GridCellKind, type GridColumn } from "@stewartadam/nightfall-data-grid/types";',
      'const columns: GridColumn[] = [{ id: "name", title: "Name" }];',
      "const provider = createKeyedDataGridCellProvider({",
      '  rows: ["a"], columns, rowKey: (row) => row, columnKey: (column) => column.id ?? "",',
      "  getCellContent: ({ row }) => ({ kind: GridCellKind.Text, data: row }),",
      "});",
      "const props: DataGridProps = { columns, rows: 1, cellProvider: () => provider };",
      "export const grid = <DataGrid {...props} />;",
      "// @ts-expect-error The declarations are typed, not `any`, so a wrong prop type fails.",
      'export const invalid: DataGridProps["rows"] = "one";',
    ].join("\n"),
  );
  try {
    execFileSync(
      process.execPath,
      [join(repoRoot, "node_modules", "typescript", "bin", "tsc"), "-p", "."],
      { cwd: projectRoot, stdio: "pipe", encoding: "utf8" },
    );
  } catch (error) {
    assert.fail(`Consumer type check failed:\n${error.stdout}${error.stderr}`);
  }
});
