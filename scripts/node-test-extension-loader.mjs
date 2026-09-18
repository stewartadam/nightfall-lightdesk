// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { transformWithOxc } from "vite";

const knownExtensionPattern = /\.(?:mjs|cjs|js|jsx|json|node)$/i;
const repoRoot = process.env.NIGHTFALL_REPO_ROOT ?? process.cwd();
const repoPackageUrl = pathToFileURL(path.join(repoRoot, "package.json")).href;
const phosphorSolidPackageSegment = `${path.sep}node_modules${path.sep}@squidlab${path.sep}phosphor-solid${path.sep}src${path.sep}`;

/** Returns whether a specifier already names an extension supported by this loader. */
function hasKnownExtension(specifier) {
  return knownExtensionPattern.test(specifier);
}

/** Returns whether a specifier should be resolved through package exports. */
function isBareSpecifier(specifier) {
  return (
    !specifier.startsWith("#") &&
    !specifier.startsWith("./") &&
    !specifier.startsWith("../") &&
    !specifier.startsWith("/") &&
    !specifier.startsWith("file:") &&
    !specifier.startsWith("node:")
  );
}

/** Returns whether the URL points at source shipped by @squidlab/phosphor-solid. */
function isPhosphorSolidSourceUrl(url) {
  if (!url?.startsWith("file:")) {
    return false;
  }
  return fileURLToPath(url).includes(phosphorSolidPackageSegment);
}

/**
 * Resolve extensionless relative imports emitted by TypeScript for node test bundles.
 */
export async function resolve(specifier, context, nextResolve) {
  if (isBareSpecifier(specifier)) {
    try {
      return await nextResolve(specifier, {
        ...context,
        parentURL: repoPackageUrl,
      });
    } catch (_error) {
      // Fall through to default resolver.
    }
  }

  const isRelative = specifier.startsWith("./") || specifier.startsWith("../");

  if (isRelative && !hasKnownExtension(specifier)) {
    const suffixes = [".js", ".jsx", "/index.js", "/index.jsx"];
    if (isPhosphorSolidSourceUrl(context.parentURL)) {
      suffixes.push(".tsx", ".ts");
    }
    for (const suffix of suffixes) {
      try {
        return await nextResolve(`${specifier}${suffix}`, context);
      } catch (_error) {
        // Try the next emitted file or source package extension.
      }
    }
  }

  return nextResolve(specifier, context);
}

/** Transpiles preserved JSX and source-only package TypeScript for node tests. */
export async function load(url, context, nextLoad) {
  if (!url.startsWith("file:")) {
    return nextLoad(url, context);
  }

  const fileName = fileURLToPath(url);
  const extension = path.extname(fileName).toLowerCase();
  if (
    extension === ".jsx" ||
    (isPhosphorSolidSourceUrl(url) &&
      (extension === ".ts" || extension === ".tsx"))
  ) {
    const source = await readFile(fileName, "utf8");
    const transpiled = await transformWithOxc(source, fileName, {
      jsx: {
        importSource: "solid-js/h",
        runtime: "automatic",
      },
      lang: extension.slice(1),
      sourceType: "module",
      target: "es2022",
    });

    return {
      format: "module",
      shortCircuit: true,
      source: transpiled.code,
    };
  }

  return nextLoad(url, context);
}
