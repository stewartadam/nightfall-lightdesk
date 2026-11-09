#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { commandFor, readEnvMap, runCapture } from "./worktree-data-dir.mjs";

const PORT_RANGE_START = 3000;
/**
 * Ports reserved per worktree, starting at NIGHTFALL_PORT: backend (+0),
 * web UI (+1), user manual (+2), Developer Guide (+3), and room for future
 * services.
 */
export const PORT_BLOCK_SIZE = 10;
const PORT_BLOCK_COUNT = 100;

/**
 * Returns whether the block starting at `base` overlaps any taken port. Each
 * taken port is assumed to own a full block starting at it, which also covers
 * ports that are not aligned to PORT_BLOCK_SIZE, such as a hand-picked port in
 * the primary checkout.
 */
function overlapsTaken(base, takenPorts) {
  return takenPorts.some(
    (taken) => taken < base + PORT_BLOCK_SIZE && base < taken + PORT_BLOCK_SIZE,
  );
}

/**
 * Picks a random port block in 3000-3999 whose ports no other worktree uses.
 * Blocks are aligned to PORT_BLOCK_SIZE so ports read as worktree base plus
 * service offset. Throws when every block overlaps a taken port.
 */
export function pickPortBlock(takenPorts, random = Math.random) {
  const free = [];
  for (let block = 0; block < PORT_BLOCK_COUNT; block += 1) {
    const base = PORT_RANGE_START + block * PORT_BLOCK_SIZE;
    if (!overlapsTaken(base, takenPorts)) free.push(base);
  }
  if (free.length === 0) {
    throw new Error(
      `No free ${PORT_BLOCK_SIZE}-port block between ${PORT_RANGE_START} and ${PORT_RANGE_START + PORT_BLOCK_SIZE * PORT_BLOCK_COUNT - 1}; set NIGHTFALL_PORT in the worktree's .env by hand`,
    );
  }
  return free[Math.floor(random() * free.length)];
}

/**
 * Chooses the port block for a worktree. A worktree that already has a port
 * keeps it while no other worktree's block overlaps it, so rerunning setup
 * leaves its URLs unchanged; otherwise a free block is picked at random.
 */
export function allocatePort({ currentPort, takenPorts, random }) {
  if (Number.isFinite(currentPort) && !overlapsTaken(currentPort, takenPorts)) {
    return currentPort;
  }
  return pickPortBlock(takenPorts, random);
}

/**
 * Resolves symlinks so the same worktree compares equal however its path is
 * spelled, falling back to the plain absolute path when it can't be resolved.
 */
async function canonicalPath(path) {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Reads the NIGHTFALL_PORT of every worktree of the repository containing
 * `worktreePath`, split into that worktree's own port and everyone else's.
 */
async function worktreePorts(worktreePath) {
  const target = await canonicalPath(worktreePath);
  const listing = await runCapture(commandFor("git"), [
    "-C",
    target,
    "worktree",
    "list",
    "--porcelain",
  ]);
  const paths = await Promise.all(
    listing
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("worktree "))
      .map((line) => canonicalPath(line.slice("worktree ".length))),
  );
  /** Parses one worktree's port from its `.env`, or NaN when it has none. */
  const portOf = async (path) =>
    Number.parseInt(
      (await readEnvMap(join(path, ".env"))).NIGHTFALL_PORT ?? "",
      10,
    );
  const others = await Promise.all(
    paths.filter((path) => path !== target).map(portOf),
  );
  return {
    currentPort: await portOf(target),
    takenPorts: others.filter(Number.isFinite),
  };
}

/**
 * Prints the port block for the worktree given as the first argument (default:
 * the current directory), for Worktrunk to pass to `setup-env.mjs --port`.
 */
async function main() {
  const worktreePath = process.argv[2] ?? process.cwd();
  const port = allocatePort(await worktreePorts(worktreePath));
  process.stdout.write(`${port}\n`);
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
