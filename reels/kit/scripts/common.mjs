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

/** The reels package root and its git-ignored output folder. */
export const reelsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
export const outDir = join(reelsDir, "out");

/**
 * The reel named by the script's first argument, which must match a folder
 * of `reels/` holding a `*.record.ts` take script. Exits with the available
 * names otherwise.
 */
export function reelArgument() {
  const reel = process.argv[2];
  const available = readdirSync(reelsDir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        readdirSync(join(reelsDir, entry.name)).some((file) =>
          file.endsWith(".record.ts"),
        ),
    )
    .map((entry) => entry.name);
  if (!reel || !available.includes(reel)) {
    console.error(
      `Name a reel: ${available.length ? available.join(", ") : "(none yet; add one as reels/<reel>/)"}`,
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
 * Chrome for rendering. `REELS_BROWSER` wins; otherwise Remotion fetches its
 * own headless Chrome on first use.
 */
export function browserExecutable() {
  return process.env.REELS_BROWSER || undefined;
}

/** Parallel browser tabs to render with, leaving a core for the encoder. */
export function renderWorkers() {
  return Math.max(1, Math.min(4, availableParallelism() - 1));
}
