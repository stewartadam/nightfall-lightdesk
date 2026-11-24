// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { defineConfig } from "@playwright/test";
import base from "../../../playwright.config";
import { CAPTURE_SCALE, VIEWPORT } from "./capture";

/**
 * Playwright setup for promo recordings: the repository's settings with a
 * portrait 720x1280 viewport at the capture scale (see capture.ts), which
 * captures at 2160x3840 by default while the app keeps its docked desktop
 * layout (it switches to the phone shell below 640 CSS pixels). Run through the repository wrapper so the embedded demo
 * engine and dev server are built and served the usual way:
 *
 *   pnpm --dir reels run record <reel>
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
  outputDir: "../../../test-results/reels",
  use: {
    ...base.use,
    viewport: VIEWPORT,
    deviceScaleFactor: CAPTURE_SCALE,
    video: "off",
    trace: "off",
    screenshot: "off",
  },
});
