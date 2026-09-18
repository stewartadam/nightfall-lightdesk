// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { existsSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";

import { defineConfig } from "@playwright/test";

function readBackendPort(): number {
  const environmentPort = process.env.NIGHTFALL_PORT?.trim();
  if (environmentPort) return Number.parseInt(environmentPort, 10);

  const envPath = join(process.cwd(), ".env");
  if (!existsSync(envPath)) return 3030;

  const envFile = readFileSync(envPath, "utf8");
  const match = envFile.match(/^NIGHTFALL_PORT=(\d+)$/m);
  return match ? Number.parseInt(match[1], 10) : 3030;
}

const backendPort = readBackendPort();
const webPort = backendPort + 1;
const baseURL = `http://127.0.0.1:${webPort}`;
const usesBackendPool = process.env.NIGHTFALL_PLAYWRIGHT_BACKEND_POOL === "1";
const browserName =
  process.env.NIGHTFALL_PLAYWRIGHT_BROWSER === "firefox"
    ? ("firefox" as const)
    : ("chromium" as const);

/** Returns the configured pool size or a bounded host-aware default. */
function readWorkerCount(): number {
  const configuredWorkers = process.env.NIGHTFALL_PLAYWRIGHT_WORKERS?.trim();
  if (!configuredWorkers) return Math.min(6, availableParallelism());
  const workerCount = Number.parseInt(configuredWorkers, 10);
  if (!Number.isInteger(workerCount) || workerCount < 1) {
    throw new Error("NIGHTFALL_PLAYWRIGHT_WORKERS must be a positive integer");
  }
  return workerCount;
}

export default defineConfig({
  testDir: "./webui/e2e",
  timeout: 30_000,
  workers: usesBackendPool ? readWorkerCount() : 1,
  expect: {
    timeout: 8_000,
  },
  fullyParallel: usesBackendPool,
  retries: process.env.CI ? 2 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  outputDir: "test-results/playwright",
  use: {
    browserName,
    channel: browserName === "chromium" ? "chromium" : undefined,
    headless: true,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    viewport: { width: 1366, height: 900 },
    baseURL,
    launchOptions:
      browserName === "chromium" ? { args: ["--mute-audio"] } : undefined,
  },
  webServer: usesBackendPool
    ? undefined
    : {
        command: "node scripts/run-playwright-vite.mjs",
        gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
