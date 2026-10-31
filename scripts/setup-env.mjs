#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nightfallTestDataDir } from "./nightfall-test-data-dir.mjs";
import { sharedBrowsersPath } from "./playwright-path.mjs";
import {
  commandFor,
  readEnvMap,
  resolveMainWorktree,
  runCapture,
} from "./worktree-data-dir.mjs";

const PORT_RANGE_START = 3000;
/**
 * Ports reserved per worktree, starting at NIGHTFALL_PORT: backend (+0),
 * web UI (+1), user manual (+2), Developer Guide (+3), and room for future
 * services.
 */
export const PORT_BLOCK_SIZE = 10;
const PORT_BLOCK_COUNT = 100;

/**
 * Picks a random port block in 3000-3999 whose ports no other worktree uses.
 * Blocks are aligned to PORT_BLOCK_SIZE so ports read as worktree base plus
 * service offset. Each taken port is assumed to own a full block starting at
 * it, which also covers older worktrees whose ports are not aligned.
 */
export function pickPortBlock(takenPorts, random = Math.random) {
  const free = [];
  for (let block = 0; block < PORT_BLOCK_COUNT; block += 1) {
    const base = PORT_RANGE_START + block * PORT_BLOCK_SIZE;
    const overlaps = takenPorts.some(
      (taken) =>
        taken < base + PORT_BLOCK_SIZE && base < taken + PORT_BLOCK_SIZE,
    );
    if (!overlaps) free.push(base);
  }
  if (free.length === 0) {
    throw new Error(
      `No free ${PORT_BLOCK_SIZE}-port block between ${PORT_RANGE_START} and ${PORT_RANGE_START + PORT_BLOCK_SIZE * PORT_BLOCK_COUNT - 1}; set NIGHTFALL_PORT explicitly`,
    );
  }
  return free[Math.floor(random() * free.length)];
}

/**
 * Lists the NIGHTFALL_PORT of every other worktree of this repository that
 * has a `.env`, so a new worktree can avoid their ports.
 */
async function otherWorktreePorts(projectRoot) {
  let listing = "";
  try {
    listing = await runCapture(commandFor("git"), [
      "-C",
      projectRoot,
      "worktree",
      "list",
      "--porcelain",
    ]);
  } catch {
    return [];
  }
  const paths = listing
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => resolve(line.slice("worktree ".length)))
    .filter((path) => path !== resolve(projectRoot));
  const ports = await Promise.all(
    paths.map(async (path) => {
      const value = (await readEnvMap(join(path, ".env"))).NIGHTFALL_PORT;
      return Number.parseInt(value ?? "", 10);
    }),
  );
  return ports.filter(Number.isFinite);
}

const ASSIGNMENT_KEY = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/u;

/**
 * Preserves inherited dotenv text while applying worktree-specific overrides.
 *
 * An overridden key keeps the position of its first assignment in the seed,
 * later assignments of that key are dropped, and keys absent from the seed are
 * appended, so rerunning setup never accumulates duplicate keys.
 */
export function buildEnvLines({ port, projectRoot, mainWorktree, seed = "" }) {
  const overrides = new Map([
    ["NIGHTFALL_PORT", String(port)],
    ["PLAYWRIGHT_BROWSERS_PATH", sharedBrowsersPath],
  ]);

  if (mainWorktree && mainWorktree !== projectRoot) {
    overrides.set("NIGHTFALL_DATA_DIR", nightfallTestDataDir(projectRoot));
    overrides.set("NIGHTFALL_OUTPUT_SACN_ENABLED", "false");
    overrides.set("NIGHTFALL_OUTPUT_ARTNET", "false");
    overrides.set("NIGHTFALL_INPUT_SACN_ENABLED", "false");
    overrides.set("NIGHTFALL_INPUT_ARTNET", "false");
  }

  const written = new Set();
  const envLines = [];
  for (const line of seed ? seed.trimEnd().split(/\r?\n/u) : []) {
    const key = line.match(ASSIGNMENT_KEY)?.[1];
    if (!key || !overrides.has(key)) {
      envLines.push(line);
    } else if (!written.has(key)) {
      envLines.push(`${key}=${overrides.get(key)}`);
      written.add(key);
    }
  }
  for (const [key, value] of overrides) {
    if (!written.has(key)) envLines.push(`${key}=${value}`);
  }

  return envLines;
}

/**
 * Writes the worktree-local `.env` file.
 */
async function main() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const projectRoot = dirname(scriptDir);
  const envFile = join(projectRoot, ".env");
  const mainWorktree = await resolveMainWorktree(projectRoot);
  let seed = "";
  try {
    seed = await readFile(join(mainWorktree || projectRoot, ".env"), "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const portRaw = process.env.NIGHTFALL_PORT?.trim();
  const port =
    portRaw && Number.isFinite(Number(portRaw))
      ? Number.parseInt(portRaw, 10)
      : pickPortBlock(await otherWorktreePorts(projectRoot));
  const envLines = buildEnvLines({ port, projectRoot, mainWorktree, seed });

  await writeFile(envFile, `${envLines.join("\n")}\n`, "utf8");
  process.stdout.write(
    `OK: Generated ${envFile} with NIGHTFALL_PORT=${port}\n`,
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
