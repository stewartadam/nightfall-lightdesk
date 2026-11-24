// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import solidPlugin from "vite-plugin-solid";

/** This package's manifest, for its dependency names. */
const manifest = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as {
  dependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
};

/** Packages the consumer installs; the build imports them instead of bundling them. */
const externalPackages = [
  ...Object.keys(manifest.dependencies),
  ...Object.keys(manifest.peerDependencies),
];

/** Returns whether an import belongs to a dependency or peer, including its subpaths. */
function isExternal(id: string): boolean {
  return externalPackages.some(
    (name) => id === name || id.startsWith(`${name}/`),
  );
}

/** Returns the absolute path of a file in this package's source directory. */
function source(path: string): string {
  return fileURLToPath(new URL(`./src/${path}`, import.meta.url));
}

/**
 * Builds the published package: compiled ES modules for each export, and one
 * stylesheet with the grid's rules and the Tailwind utilities its markup uses.
 * `tsconfig.build.json` then adds the preserved-JSX source and declarations.
 */
export default defineConfig({
  plugins: [solidPlugin(), tailwindcss()],
  build: {
    target: "es2022",
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    cssCodeSplit: true,
    lib: {
      entry: {
        index: source("index.tsx"),
        "data-grid-types": source("data-grid-types.ts"),
        "dropdown-cell": source("dropdown-cell.ts"),
        styles: source("styles.css"),
      },
      formats: ["es"],
    },
    rolldownOptions: {
      external: isExternal,
      output: {
        assetFileNames: "[name][extname]",
      },
    },
  },
});
