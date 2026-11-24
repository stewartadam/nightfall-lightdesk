// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { defineConfig } from "@playwright/test";
import base from "../../playwright.config";

/**
 * Playwright setup for promo recordings: the repository's settings with a
 * portrait 720x1280 viewport at 1.5x, which captures at 1080x1920 while the
 * app keeps its docked desktop layout (it switches to the phone shell below
 * 640 CSS pixels). Run through the repository wrapper so the embedded demo
 * engine and dev server are built and served the usual way:
 *
 *   pnpm --dir promo run record <reel>
 */
export default defineConfig({
  ...base,
  testDir: "../reels",
  testMatch: "**/*.record.ts",
  timeout: 180_000,
  retries: 0,
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
  outputDir: "../../test-results/promo",
  use: {
    ...base.use,
    viewport: { width: 720, height: 1280 },
    deviceScaleFactor: 1.5,
    video: "off",
    trace: "off",
    screenshot: "off",
  },
});
