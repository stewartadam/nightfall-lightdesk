// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, loadEnv, type ProxyOptions } from "vite";
import solidPlugin from "vite-plugin-solid";
import {
  distributionNoticesPlugin,
  workerNoticesPlugin,
} from "./scripts/vite-distribution-notices.ts";

const projectRoot = import.meta.dirname;
const projectLinks = JSON.parse(
  readFileSync(resolve(projectRoot, "config/project-links.json"), "utf8"),
);

/**
 * Returns the value of a Tauri config field as a string, or throws an error if the field is missing.
 */
function requireTauriConfigString(
  value: string | undefined,
  fieldName: string,
): string {
  if (!value) {
    throw new Error(`Missing Tauri config field: ${fieldName}`);
  }
  return value;
}

/**
 * Formats a copyright string for HTML by replacing (c) with &copy;.
 */
function formatCopyrightForHtml(value: string): string {
  return value.replace(/\(c\)/gi, "&copy;");
}

/**
 * Runs a Git command in the project root and returns its trimmed stdout.
 */
function readGitValue(args: string[]): string | undefined {
  try {
    const value = execSync(`git ${args.join(" ")}`, {
      cwd: projectRoot,
      encoding: "utf8",
    }).trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Returns the current Git commit hash as a build ID.
 */
function readBuildId(): string {
  return readGitValue(["rev-parse", "--short=12", "HEAD"]) ?? "unknown";
}

/**
 * Returns the most useful human-readable Git ref name for this build.
 */
function readBuildName(): string {
  return (
    readGitValue(["branch", "--show-current"]) ??
    readGitValue(["name-rev", "--name-only", "--no-undefined", "HEAD"]) ??
    "unknown"
  );
}

/**
 * Returns the browser document title for one app build.
 */
function formatAppTitle(appName: string, appBuildName: string): string {
  return appBuildName === "unknown" ? appName : `${appName} (${appBuildName})`;
}

/**
 * Returns a record of URLs to proxy based on the current mode and whether the worktree is enabled. */
function proxiedUrls(
  mode: string,
  withWorktree: boolean,
): Record<string, string | ProxyOptions> {
  // Load env vars from project root (where .env lives)
  const env = loadEnv(mode, resolve(projectRoot), ["NIGHTFALL_"]);
  const backendPort =
    process.env.NIGHTFALL_PORT || env.NIGHTFALL_PORT || "3030";
  const dashboardHost = env.NIGHTFALL_WORKTREE_DASHBOARD_HOST || "127.0.0.1";
  const dashboardPort = env.NIGHTFALL_WORKTREE_DASHBOARD_PORT || "4780";

  const proxy: Record<string, string | ProxyOptions> = {
    // Proxy API requests to the backend server
    "/api": {
      target: `http://localhost:${backendPort}`,
      changeOrigin: true,
    },
    // Proxy websocket traffic to the backend server
    "/ws": {
      target: `ws://localhost:${backendPort}`,
      ws: true,
      changeOrigin: true,
    },
  };

  if (!withWorktree) {
    // Proxy worktree dashboard API requests to the local dashboard service.
    proxy["/worktree-api"] = {
      target: `http://${dashboardHost}:${dashboardPort}`,
      changeOrigin: true,
      rewrite: (path) => path.replace(/^\/worktree-api/, "/api"),
    };
  }
  return proxy;
}

/**
 * Returns true if the current environment is a Tauri build.
 */
function isTauri(): boolean {
  return process.env.TAURI_ENV_PLATFORM !== undefined;
}

const tauriConfig = JSON.parse(
  readFileSync(resolve(projectRoot, "crates/app/tauri.conf.json"), "utf8"),
) as {
  productName?: string;
  version?: string;
  bundle?: {
    copyright?: string;
    license?: string;
  };
};

const appName = requireTauriConfigString(
  tauriConfig.productName,
  "productName",
).toLowerCase();
const appVersion = requireTauriConfigString(tauriConfig.version, "version");
const appLicense = requireTauriConfigString(
  tauriConfig.bundle?.license,
  "bundle.license",
);
const appCopyright = formatCopyrightForHtml(
  requireTauriConfigString(tauriConfig.bundle?.copyright, "bundle.copyright"),
);
const appBuildId = readBuildId();
const appBuildName = readBuildName();
const appTitle = formatAppTitle(appName, appBuildName);
const viteWatchIgnored = ["**/*.spec.ts"];

export default defineConfig(({ mode }) => {
  // Load env vars from project root (where .env lives)
  const env = loadEnv(mode, resolve(projectRoot), ["NIGHTFALL_"]);

  const tauri = isTauri();

  const defaultVitePort = 3031;
  const vitePort =
    (tauri
      ? undefined
      : Number(process.env.NIGHTFALL_PORT || env.NIGHTFALL_PORT) + 1) ||
    defaultVitePort;

  return {
    root: "./webui",
    // Desktop connection settings come from native runtime configuration.
    envDir: tauri ? false : resolve(projectRoot),
    envPrefix: ["VITE_", "TAURI_", "NIGHTFALL_"],
    build: {
      sourcemap: true,
      license: { fileName: "notices/frontend.json" },
    },
    worker: {
      format: "es",
      plugins: () => [workerNoticesPlugin()],
    },
    define: {
      __NIGHTFALL_PROJECT_LINKS__: JSON.stringify(projectLinks),
      __NIGHTFALL_APP_NAME__: JSON.stringify(appName),
      __NIGHTFALL_APP_TITLE__: JSON.stringify(appTitle),
      __NIGHTFALL_APP_VERSION__: JSON.stringify(appVersion),
      __NIGHTFALL_APP_BUILD_ID__: JSON.stringify(appBuildId),
      __NIGHTFALL_APP_BUILD_NAME__: JSON.stringify(appBuildName),
      __NIGHTFALL_APP_LICENSE__: JSON.stringify(appLicense),
      __NIGHTFALL_APP_COPYRIGHT__: JSON.stringify(appCopyright),
    },
    plugins: [tailwindcss(), solidPlugin(), distributionNoticesPlugin()],
    server: {
      port: vitePort,
      proxy: proxiedUrls(mode, tauri),
      forwardConsole:
        process.env.NIGHTFALL_PLAYWRIGHT_OWN_BACKEND === "1"
          ? false
          : undefined,
      watch: {
        ignored: viteWatchIgnored,
      },
    },
  };
});
