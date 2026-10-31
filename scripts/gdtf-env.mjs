// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { join } from "node:path";
import { readEnvMap, resolveEnvPath } from "./worktree-data-dir.mjs";

/** Environment variables the GDTF scripts read, from the shell or the worktree `.env`. */
export const gdtfEnvKeys = [
  "NIGHTFALL_GDTF_BENCH_DIR",
  "NIGHTFALL_GDTF_BENCH_UPDATE",
  "NIGHTFALL_GDTF_CORPUS_DIR",
  "NIGHTFALL_GDTF_CORPUS_REPORT",
  "GDTF_SHARE_USER",
  "GDTF_SHARE_PASSWORD",
];

/**
 * Returns the per-user cache directory the GDTF bench archives default to.
 *
 * The cache lives outside the repository so every worktree shares one fetched
 * copy, and the archives (which cannot be redistributed) never land in git.
 */
export function defaultGdtfBenchDir(
  env = process.env,
  platform = process.platform,
) {
  const home = env.HOME || env.USERPROFILE;
  if (!home) throw new Error("HOME is not set; cannot resolve the cache dir");

  if (platform === "darwin") {
    return join(home, "Library", "Caches", "nightfall", "gdtf-bench");
  }
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA || join(home, "AppData", "Local");
    return join(localAppData, "nightfall", "gdtf-bench");
  }
  return join(
    env.XDG_CACHE_HOME || join(home, ".cache"),
    "nightfall",
    "gdtf-bench",
  );
}

/**
 * Resolves the GDTF script settings for a worktree.
 *
 * Only the GDTF keys are taken from the worktree `.env`, so unrelated settings
 * such as NIGHTFALL_DATA_DIR never reach the Cargo tests. Exported shell values
 * win over `.env`. A relative bench directory resolves against the worktree,
 * and an unset one falls back to {@link defaultGdtfBenchDir}.
 */
export async function gdtfEnvironment(projectRoot, env = process.env) {
  const dotenv = await readEnvMap(join(projectRoot, ".env"));
  /** @type {Record<string, string>} */
  const settings = {};
  for (const key of gdtfEnvKeys) {
    const value = env[key]?.trim() || dotenv[key]?.trim();
    if (value) settings[key] = value;
  }
  settings.NIGHTFALL_GDTF_BENCH_DIR = settings.NIGHTFALL_GDTF_BENCH_DIR
    ? resolveEnvPath(settings.NIGHTFALL_GDTF_BENCH_DIR, projectRoot)
    : defaultGdtfBenchDir(env);
  return settings;
}
