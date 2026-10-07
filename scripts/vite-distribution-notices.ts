// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Plugin, ResolvedConfig } from "vite";
import {
  developmentNotices,
  noticesJson,
  noticesText,
  packageNotices,
  renderNotices,
} from "./distribution-notices.mjs";

interface PackageLicense {
  name: string;
  version: string;
  identifier: string;
}

const workerPackages = new Map<string, PackageLicense>();

/** Retain worker-only packages because Vite's main inventory sees workers as emitted assets. */
export function workerNoticesPlugin(): Plugin {
  return {
    name: "nightfall:worker-notices",
    /** Attribute every dependency that contributes modules to a worker chunk. */
    generateBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== "chunk") continue;
        for (const moduleId of chunk.moduleIds) {
          if (!moduleId.includes("node_modules")) continue;
          let directory = dirname(moduleId.split("?")[0]);
          while (directory.includes("node_modules")) {
            const manifest = join(directory, "package.json");
            if (existsSync(manifest)) {
              const pkg = JSON.parse(readFileSync(manifest, "utf8"));
              if (pkg.name && pkg.version) {
                workerPackages.set(`${pkg.name}@${pkg.version}`, {
                  name: pkg.name,
                  version: pkg.version,
                  identifier: pkg.license,
                });
                break;
              }
            }
            directory = dirname(directory);
          }
        }
      }
    },
  };
}

/** Connect Vite's bundled-package license inventory to offline distribution notices. */
export function distributionNoticesPlugin(): Plugin {
  let config: ResolvedConfig;
  let bundleFailed = false;
  return {
    name: "nightfall:distribution-notices",
    enforce: "post",
    /** Retain the resolved output path and deployment base for both server modes. */
    configResolved(resolved) {
      config = resolved;
      workerPackages.clear();
    },
    /** Serve an explicitly labelled installed-package preview without requiring a Rust build. */
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = request.url?.split("?")[0];
        if (
          path !== `/notices/${noticesJson}` &&
          path !== `/notices/${noticesText}`
        )
          return next();
        try {
          const document = developmentNotices();
          response.setHeader(
            "Content-Type",
            path.endsWith(".json")
              ? "application/json"
              : "text/plain; charset=utf-8",
          );
          response.end(
            path.endsWith(".json")
              ? JSON.stringify(document)
              : renderNotices(document),
          );
        } catch (error) {
          next(error);
        }
      });
    },
    /** Remember a failed build so `closeBundle` leaves Rolldown's original error in charge. */
    buildEnd(error) {
      bundleFailed = error !== undefined;
    },
    /** Remember a failed render so `closeBundle` leaves Rolldown's original error in charge. */
    renderError() {
      bundleFailed = true;
    },
    /** Finish notices only after Vite has written the actual bundled-package inventory. */
    closeBundle() {
      // Rolldown still closes a failed bundle, which has written no notices directory.
      if (config.command !== "build" || bundleFailed) return;
      const outDir = resolve(config.root, config.build.outDir);
      // e2e builds never ship; serve the dev server's preview without a Rust license scan.
      if (config.mode === "e2e") {
        const document = developmentNotices();
        writeFileSync(
          join(outDir, "notices", noticesJson),
          JSON.stringify(document),
        );
        writeFileSync(
          join(outDir, "notices", noticesText),
          renderNotices(document),
        );
        return;
      }
      const inventory = join(outDir, "notices/frontend.json");
      const entries = JSON.parse(readFileSync(inventory, "utf8"));
      writeFileSync(
        inventory,
        JSON.stringify([...entries, ...workerPackages.values()], null, 2),
      );
      packageNotices(
        outDir,
        process.env.TAURI_ENV_TARGET_TRIPLE,
        config.mode === "browser-demo",
      );
    },
  };
}
