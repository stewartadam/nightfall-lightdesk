// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type HttpProxy, loadEnv, type ProxyOptions } from "vite";
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

/** Matches the cookie a Playwright browser context sets to name its test backend port. */
const playwrightBackendCookie = /(?:^|;\s*)nightfall-playwright-backend=(\d+)/;

/**
 * Sends each proxied request to the backend port its Playwright browser context
 * names in a cookie, so one shared dev server serves every test's backend.
 * Requests without the cookie keep the proxy's configured target.
 */
function routeToPlaywrightBackend(
  proxy: HttpProxy.ProxyServer,
  type: "web" | "ws",
): void {
  proxy.before(
    type,
    "stream",
    (req: IncomingMessage, _res: unknown, options: { target?: unknown }) => {
      const port = req.headers.cookie?.match(playwrightBackendCookie)?.[1];
      if (port) {
        options.target = new URL(
          `${type === "ws" ? "ws" : "http"}://127.0.0.1:${port}`,
        );
      }
    },
  );
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
  const sharedPlaywrightServer =
    process.env.NIGHTFALL_PLAYWRIGHT_SHARED_VITE === "1";

  const proxy: Record<string, string | ProxyOptions> = {
    // Proxy API requests to the backend server
    "/api": {
      target: `http://localhost:${backendPort}`,
      changeOrigin: true,
      configure: sharedPlaywrightServer
        ? (server) => routeToPlaywrightBackend(server, "web")
        : undefined,
    },
    // Proxy websocket traffic to the backend server
    "/ws": {
      target: `ws://localhost:${backendPort}`,
      ws: true,
      changeOrigin: true,
      configure: sharedPlaywrightServer
        ? (server) => routeToPlaywrightBackend(server, "ws")
        : undefined,
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
  readFileSync(
    resolve(projectRoot, "desktop/app-tauri/tauri.conf.json"),
    "utf8",
  ),
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
const embeddedRuntimeModule = resolve(
  projectRoot,
  "webui/assets/browser-runtime/nightfall_browser_runtime.js",
);

/**
 * Decides whether the engine worker bundles the embedded demo runtime.
 *
 * Demo builds always include it. The dev server includes it only when
 * `pnpm run wasm-build:browser-demo` output exists, so native-backend sessions
 * and CI smoke tests do not depend on the demo engine build; without it, the
 * worker reports that the build lacks the embedded demo engine.
 */
function includesEmbeddedRuntime(command: string, mode: string): boolean {
  if (mode === "browser-demo") return true;
  if (command !== "serve") return false;
  if (existsSync(embeddedRuntimeModule)) return true;
  console.warn(
    "Embedded demo engine not found; the dev server serves the native-only worker. Run `pnpm run wasm-build:browser-demo` to enable demo mode.",
  );
  return false;
}

export default defineConfig(({ mode, command }) => {
  // Load env vars from project root (where .env lives)
  const env = loadEnv(mode, resolve(projectRoot), ["NIGHTFALL_"]);

  const tauri = isTauri();

  const warmupPanels =
    (process.env.NIGHTFALL_VITE_WARMUP_PANELS ??
      env.NIGHTFALL_VITE_WARMUP_PANELS) === "1";
  const panelModules = [
    "./features/**/panels/*.tsx",
    "./features/**/panel.tsx",
    "./features/**/*-panel.tsx",
  ];

  const defaultVitePort = 3031;
  const vitePort =
    (tauri
      ? undefined
      : Number(process.env.NIGHTFALL_PORT || env.NIGHTFALL_PORT) + 1) ||
    defaultVitePort;

  return {
    root: "./webui",
    // A Playwright run keeps its own dependency cache so re-optimizing never
    // reloads pages served by a developer's dev server in the same worktree.
    cacheDir:
      process.env.NIGHTFALL_PLAYWRIGHT_SHARED_VITE === "1"
        ? resolve(projectRoot, "node_modules/.vite-playwright")
        : undefined,
    resolve: {
      alias: {
        "#engine-runtime-worker?worker": `${resolve(
          projectRoot,
          includesEmbeddedRuntime(command, mode)
            ? "webui/lib/engine-runtime-demo-worker.ts"
            : "webui/lib/engine-runtime-worker.ts",
        )}?worker`,
      },
    },
    // Desktop connection settings come from native runtime configuration.
    envDir: tauri ? false : resolve(projectRoot),
    envPrefix: ["VITE_", "TAURI_", "NIGHTFALL_"],
    build: {
      reportCompressedSize: false,
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
    plugins: [
      tailwindcss(),
      solidPlugin(),
      distributionNoticesPlugin(),
      {
        name: "startup-build-metadata",
        /** Inserts escaped build metadata into the pre-JavaScript splash. */
        transformIndexHtml(html) {
          const metadata = `v${appVersion} - ${appBuildName} (${appBuildId})`;
          const escaped = metadata
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;");
          return html.replace("<!-- startup-build-metadata -->", escaped);
        },
      },
    ],
    // Scanning lazily loaded panels at startup finds their dependencies before
    // a test opens one, instead of re-optimizing and reloading mid-test.
    optimizeDeps: {
      entries: warmupPanels ? ["*.html", ...panelModules] : undefined,
    },
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
      // Playwright tests open panels right after startup; transforming the app and every lazily loaded panel up
      // front keeps those first opens from queueing behind cold transforms.
      warmup: {
        clientFiles: warmupPanels ? ["./main.tsx", ...panelModules] : [],
      },
    },
  };
});
