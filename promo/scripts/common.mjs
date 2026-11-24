// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { existsSync, readdirSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The promo package root and its git-ignored output folder. */
export const promoDir = join(dirname(fileURLToPath(import.meta.url)), "..");
export const outDir = join(promoDir, "out");

/**
 * The reel named by the script's first argument, which must match a folder
 * under `reels/`. Exits with the available names otherwise.
 */
export function reelArgument() {
  const reel = process.argv[2];
  const reelsDir = join(promoDir, "reels");
  const available = readdirSync(reelsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  if (!reel || !available.includes(reel)) {
    console.error(
      `Name a reel: ${available.length ? available.join(", ") : "(none yet; add one under promo/reels/)"}`,
    );
    process.exit(1);
  }
  // The folder name doubles as the Remotion composition id, which only allows these.
  if (!/^[a-zA-Z0-9-]+$/.test(reel)) {
    console.error(
      `Reel folder "${reel}" must use only letters, digits and dashes.`,
    );
    process.exit(1);
  }
  return reel;
}

/** Exits with a hint when the reel has no take yet. */
export function requireRecording(reel) {
  if (!existsSync(join(outDir, reel, "recording.json"))) {
    console.error(
      `No take of "${reel}" yet. Run \`pnpm run record ${reel}\` first.`,
    );
    process.exit(1);
  }
}

/**
 * Chrome for rendering. `PROMO_BROWSER` wins; otherwise Remotion fetches its
 * own headless Chrome on first use.
 */
export function browserExecutable() {
  return process.env.PROMO_BROWSER || undefined;
}

/** Parallel browser tabs to render with, leaving a core for the encoder. */
export function renderWorkers() {
  return Math.max(1, Math.min(4, availableParallelism() - 1));
}
