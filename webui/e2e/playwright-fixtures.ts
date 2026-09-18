// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, test as playwrightTest } from "@playwright/test";

import {
  startPlaywrightTestBackend,
  startPlaywrightWorkerSlot,
  stopPlaywrightTestBackend,
  stopPlaywrightWorkerSlot,
} from "../../scripts/playwright-backend-pool.mjs";

type WorkerSlot = {
  backendPort: number;
  baseURL: string;
  claimPaths: string[];
  runRoot: string;
  viteService: unknown;
  workerIndex: number;
};

export type BackendSlot = WorkerSlot & {
  backendService: unknown;
  dataDir: string;
  testId: string;
};

type TestFixtures = {
  experimentalFlows: boolean;
  backendSlot: BackendSlot;
};

type WorkerFixtures = {
  workerSlot: WorkerSlot;
};

/** Returns a required environment value or explains the wrapper requirement. */
function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (value) return value;
  throw new Error(
    `${name} is required; run Playwright through npm run test:webui-playwright`,
  );
}

export const test = playwrightTest.extend<TestFixtures, WorkerFixtures>({
  experimentalFlows: [false, { option: true }],
  /** Keeps one Vite proxy and fixed port pair alive for a Playwright worker. */
  workerSlot: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright requires fixture parameters to use object destructuring.
    async ({}, use, workerInfo) => {
      const workerSlot = await startPlaywrightWorkerSlot({
        runRoot: requiredEnvironment("NIGHTFALL_PLAYWRIGHT_RUN_ROOT"),
        workerIndex: workerInfo.parallelIndex,
      });
      try {
        await use(workerSlot);
      } finally {
        await stopPlaywrightWorkerSlot(workerSlot);
      }
    },
    { scope: "worker", timeout: 120_000 },
  ],

  /** Gives each test a freshly seeded backend and destroys it afterward. */
  backendSlot: [
    async ({ workerSlot, experimentalFlows }, use, testInfo) => {
      const backendSlot = await startPlaywrightTestBackend({
        experimentalFlows,
        seedDataDir: requiredEnvironment("NIGHTFALL_PLAYWRIGHT_SEED_DATA_DIR"),
        testId: `${testInfo.testId}-${testInfo.retry}-${testInfo.repeatEachIndex}`,
        workerSlot,
      });
      try {
        await use(backendSlot);
      } finally {
        await stopPlaywrightTestBackend(backendSlot);
      }
    },
    { timeout: 180_000 },
  ],

  /** Routes relative page URLs through the current worker's Vite proxy. */
  baseURL: async ({ backendSlot }, use) => {
    await use(backendSlot.baseURL);
  },

  /** Seeds startup storage for the current test's dynamically assigned origin. */
  storageState: async ({ backendSlot }, use) => {
    await use({
      cookies: [],
      origins: [
        {
          origin: backendSlot.baseURL,
          localStorage: [
            {
              name: "nightfall.e2eAutoOpenStartupShowfile",
              value: "default",
            },
          ],
        },
      ],
    });
  },
});

/** Playwright fixture that starts only Vite, leaving the backend port deliberately empty. */
export const frontendOnlyTest = playwrightTest.extend<
  Record<never, never>,
  WorkerFixtures
>({
  /** Own one Vite service and port pair for a backend-free browser test worker. */
  workerSlot: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright requires fixture parameters to use object destructuring.
    async ({}, use, workerInfo) => {
      const workerSlot = await startPlaywrightWorkerSlot({
        runRoot: requiredEnvironment("NIGHTFALL_PLAYWRIGHT_RUN_ROOT"),
        workerIndex: workerInfo.parallelIndex,
      });
      try {
        await use(workerSlot);
      } finally {
        await stopPlaywrightWorkerSlot(workerSlot);
      }
    },
    { scope: "worker", timeout: 120_000 },
  ],

  /** Route relative page URLs through the frontend-only Vite process. */
  baseURL: async ({ workerSlot }, use) => {
    await use(workerSlot.baseURL);
  },

  /** Use an empty origin-neutral browser state for the embedded runtime. */
  // biome-ignore lint/correctness/noEmptyPattern: Playwright requires fixture parameters to use object destructuring.
  storageState: async ({}, use) => {
    await use({ cookies: [], origins: [] });
  },
});

export * from "@playwright/test";
export { expect };
