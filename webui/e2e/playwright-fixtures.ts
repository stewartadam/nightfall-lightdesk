// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test as playwrightTest } from "@playwright/test";
import { createSampleWav } from "../../scripts/browser-demo-audio.mjs";

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
  /** Ignores installed shows and generates repository-owned sample data for this test. */
  sampleDataOnly: boolean;
  /**
   * Starts the backend with no world loaded (AppState Initialized) even when the
   * seed lacks the stable E2E showfiles, so startup draft and showfile prompts run.
   */
  emptyStartupWorld: boolean;
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
  sampleDataOnly: [false, { option: true }],
  emptyStartupWorld: [false, { option: true }],
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
    async (
      { workerSlot, experimentalFlows, sampleDataOnly, emptyStartupWorld },
      use,
      testInfo,
    ) => {
      const emptySeed = sampleDataOnly
        ? await mkdtemp(join(tmpdir(), "nightfall-owned-sample-"))
        : undefined;
      try {
        const backendSlot = await startPlaywrightTestBackend({
          emptyStartupWorld,
          experimentalFlows,
          seedDataDir:
            emptySeed ??
            requiredEnvironment("NIGHTFALL_PLAYWRIGHT_SEED_DATA_DIR"),
          testId: `${testInfo.testId}-${testInfo.retry}-${testInfo.repeatEachIndex}`,
          workerSlot,
        });
        try {
          await use(backendSlot);
        } finally {
          await stopPlaywrightTestBackend(backendSlot);
        }
      } finally {
        if (emptySeed) await rm(emptySeed, { recursive: true, force: true });
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

  /** Use packaged release resources in preview mode and deterministic fixtures in development. */
  context: async ({ context }, use) => {
    if (process.env.NIGHTFALL_PLAYWRIGHT_VITE_MODE === "preview") {
      await use(context);
      return;
    }
    const showfile = await readFile(
      new URL(
        "../../test-fixtures/browser-show/showfile.json",
        import.meta.url,
      ),
    );
    await context.route(
      "**/nightfall-demo.nightfall-show/showfile.json",
      (route) =>
        route.fulfill({ contentType: "application/json", body: showfile }),
    );
    const audioPath = JSON.parse(showfile.toString()).timelines[0].audio_path;
    await context.route(
      `**/nightfall-demo.nightfall-show/${audioPath}`,
      (route) =>
        route.fulfill({
          contentType: "audio/wav",
          headers: { "accept-ranges": "bytes" },
          body: Buffer.from(createSampleWav()),
        }),
    );
    await use(context);
  },

  /** Use an empty origin-neutral browser state for the embedded runtime. */
  // biome-ignore lint/correctness/noEmptyPattern: Playwright requires fixture parameters to use object destructuring.
  storageState: async ({}, use) => {
    await use({ cookies: [], origins: [] });
  },
});

export * from "@playwright/test";
export { expect };
