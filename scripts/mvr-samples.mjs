#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  commandFor,
  readEnvMap,
  resolveEnvPath,
} from "./worktree-data-dir.mjs";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const manifestPath = join(
  projectRoot,
  "crates/mvr/tests/samples/manifest.json",
);

/**
 * Returns the command-line usage text for the sample runner.
 */
function usage() {
  return `usage: pnpm run mvr:samples [fetch]

Downloads the real MVR exports listed in crates/mvr/tests/samples/manifest.json
into NIGHTFALL_MVR_SAMPLES_DIR, verifying each file's pinned SHA-256, then runs
the MVR reader and rig import tests against them. With "fetch", only downloads.

Environment (exported or set in the worktree .env):
  NIGHTFALL_MVR_SAMPLES_DIR  Directory the samples are stored in
                             (default: ${defaultMvrSamplesDir()})

Files already present with the pinned hash are not downloaded again.
`;
}

/**
 * Returns the per-user cache directory the MVR samples default to.
 *
 * The cache lives outside the repository so every worktree shares one copy, and the
 * samples (which embed third-party GDTF files and models) never land in git.
 */
export function defaultMvrSamplesDir(
  env = process.env,
  platform = process.platform,
) {
  const home = env.HOME || env.USERPROFILE;
  if (!home) throw new Error("HOME is not set; cannot resolve the cache dir");
  if (platform === "darwin") {
    return join(home, "Library", "Caches", "nightfall", "mvr-samples");
  }
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA || join(home, "AppData", "Local");
    return join(localAppData, "nightfall", "mvr-samples");
  }
  return join(
    env.XDG_CACHE_HOME || join(home, ".cache"),
    "nightfall",
    "mvr-samples",
  );
}

/**
 * Resolves the samples directory: the shell value, then the worktree `.env` value
 * (relative paths resolve against the worktree), then the per-user cache.
 */
export async function mvrSamplesDir(root = projectRoot, env = process.env) {
  const dotenv = await readEnvMap(join(root, ".env"));
  const configured =
    env.NIGHTFALL_MVR_SAMPLES_DIR?.trim() ||
    dotenv.NIGHTFALL_MVR_SAMPLES_DIR?.trim();
  return configured
    ? resolveEnvPath(configured, root)
    : defaultMvrSamplesDir(env);
}

/**
 * Returns the lowercase hex SHA-256 of a buffer.
 */
export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Builds the download URL of a sample at the manifest's pinned commit.
 */
export function sampleUrl(source, sample) {
  const repository = source.repository.replace(/^https:\/\/github\.com\//, "");
  return `https://raw.githubusercontent.com/${repository}/${source.commit}/${source.path}/${encodeURIComponent(sample.file)}`;
}

/**
 * Lists the manifest samples missing from `dir` or present with a different hash.
 */
export function missingSamples(manifest, dir) {
  return manifest.samples.filter((sample) => {
    const path = join(dir, sample.file);
    return !existsSync(path) || sha256(readFileSync(path)) !== sample.sha256;
  });
}

/**
 * Downloads every missing sample into `dir`, refusing any whose hash differs from the
 * pin. Each file is written to a temporary name and renamed, so an interrupted run
 * never leaves a partial sample behind.
 */
export async function fetchSamples(manifest, dir, fetchImpl = fetch) {
  const missing = missingSamples(manifest, dir);
  if (missing.length === 0) return [];
  await mkdir(dir, { recursive: true });
  for (const sample of missing) {
    const url = sampleUrl(manifest.source, sample);
    const response = await fetchImpl(url);
    if (!response.ok) {
      throw new Error(`Downloading ${url} failed: HTTP ${response.status}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const actual = sha256(bytes);
    if (actual !== sample.sha256) {
      throw new Error(
        `${sample.file} has SHA-256 ${actual}, expected ${sample.sha256}`,
      );
    }
    const target = join(dir, sample.file);
    const partial = `${target}.partial`;
    await writeFile(partial, bytes);
    await rename(partial, target);
    process.stdout.write(`Fetched ${sample.file}\n`);
  }
  return missing.map((sample) => sample.file);
}

/**
 * Runs the ignored sample tests of the MVR reader and rig import with the samples
 * directory set.
 */
function runSampleTests(dir, extra) {
  const args = [
    "test",
    "-p",
    "nightfall-mvr",
    "-p",
    "nightfall-mvr-import",
    "--",
    "--ignored",
    ...extra,
  ];
  const child = spawn(commandFor("cargo"), args, {
    cwd: projectRoot,
    env: { ...process.env, NIGHTFALL_MVR_SAMPLES_DIR: dir },
    stdio: "inherit",
  });
  child.on("error", (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 1);
  });
}

/**
 * Fetches the samples, then runs the tests unless only fetching was asked for.
 */
async function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(usage());
    return;
  }
  const fetchOnly = argv[0] === "fetch";
  const extra = fetchOnly ? argv.slice(1) : argv;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const dir = await mvrSamplesDir();
  await fetchSamples(manifest, dir);
  if (!fetchOnly) runSampleTests(dir, extra);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}
