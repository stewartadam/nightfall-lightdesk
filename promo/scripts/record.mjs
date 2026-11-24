// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { promoDir, reelArgument } from "./common.mjs";

/**
 * Records a fresh take of the named reel through the repository's Playwright
 * wrapper, which builds the embedded demo engine and serves a production
 * build of the web UI. Extra arguments (such as `--headed`) pass through to
 * Playwright.
 */
const reel = reelArgument();
const result = spawnSync(
  "pnpm",
  [
    "run",
    "test:webui-playwright",
    "--target",
    "embedded-demo",
    "--vite-mode",
    "e2e",
    "--config",
    "promo/record/playwright.config.ts",
    `promo/reels/${reel}/`,
    ...process.argv.slice(3),
  ],
  { cwd: join(promoDir, ".."), stdio: "inherit" },
);
process.exit(result.status ?? 1);
