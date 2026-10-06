// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { mkdirSync, rmSync } from "node:fs";

const LOCK_POLL_INTERVAL_MS = 100;

const MODULE_SPECIFIER =
  /(?:\bimport\s*\(\s*|\bfrom\s*|\bimport\s+)(["'])(\/[^"'\s]+)\1/gu;
const SCRIPT_SOURCE = /<script\b[^>]*\bsrc=(["'])(\/[^"']+)\1/gu;

/**
 * Returns the root-relative module URLs that a Vite-served module or HTML page
 * imports, statically or through literal dynamic imports. Vite rewrites source
 * imports to root-relative paths, so bare and relative specifiers never occur.
 */
export function moduleImportUrls(source) {
  const urls = new Set();
  for (const pattern of [MODULE_SPECIFIER, SCRIPT_SOURCE]) {
    for (const match of source.matchAll(pattern)) {
      urls.add(match[2]);
    }
  }
  return [...urls];
}

/**
 * Requests every module reachable from the app's HTML entry so a cold Vite dev
 * server transforms the whole graph, including lazily loaded panels and newly
 * discovered optimized dependencies, before a test's page load starts its
 * timeout. Returns how many URLs were fetched; stops early at the deadline.
 */
export async function warmViteModuleGraph(
  baseURL,
  { concurrency = 8, timeoutMs = 90_000, entry = "/" } = {},
) {
  const deadline = Date.now() + timeoutMs;
  const seen = new Set([entry]);
  const queue = [entry];
  let fetched = 0;
  let inFlight = 0;

  /** Fetches one URL and queues the modules it imports. */
  const visit = async (url) => {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return;
    let source;
    try {
      const response = await fetch(new URL(url, baseURL), {
        signal: AbortSignal.timeout(remainingMs),
      });
      if (!response.ok) return;
      source = await response.text();
    } catch {
      return;
    }
    fetched += 1;
    for (const next of moduleImportUrls(source)) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  };

  /** Drains the shared queue until it is empty or the deadline passes. */
  const worker = async () => {
    while (Date.now() < deadline) {
      const url = queue.shift();
      if (url === undefined) {
        if (inFlight === 0) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
        continue;
      }
      inFlight += 1;
      try {
        await visit(url);
      } finally {
        inFlight -= 1;
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));
  return fetched;
}

/**
 * Runs `task` while holding a directory lock shared by every Playwright worker
 * in a run. Vite dev servers share one optimized-dependency cache, so servers
 * that start together each re-optimize into it and serve each other stale
 * dependency hashes; starting and warming them one at a time lets the first
 * server populate the cache and the rest reuse it. A holder that died is
 * outlasted by `waitMs`, after which the task runs without the lock.
 */
export async function withWorkerLock(
  lockPath,
  task,
  { waitMs = 180_000 } = {},
) {
  const deadline = Date.now() + waitMs;
  let locked = false;
  while (!locked && Date.now() < deadline) {
    try {
      mkdirSync(lockPath);
      locked = true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      await new Promise((resolve) =>
        setTimeout(resolve, LOCK_POLL_INTERVAL_MS),
      );
    }
  }
  try {
    return await task();
  } finally {
    if (locked) rmSync(lockPath, { force: true, recursive: true });
  }
}
