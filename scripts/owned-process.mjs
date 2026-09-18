// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

import fkill from "fkill";

const DEFAULT_SHUTDOWN_GRACE_MS = 2_000;
const PROCESS_EXIT_POLL_MS = 25;
const SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM"];

/** Waits for the requested number of milliseconds. */
function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Returns whether an error reports that a process no longer exists. */
function isMissingProcessError(error) {
  return error && typeof error === "object" && error.code === "ESRCH";
}

/** Returns whether the host denied signaling an otherwise known process group. */
function isProcessPermissionError(error) {
  return error && typeof error === "object" && error.code === "EPERM";
}

/** Returns whether the owned POSIX process group still contains a process. */
function posixProcessGroupExists(processGroupId) {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (isMissingProcessError(error)) return false;
    if (isProcessPermissionError(error)) return true;
    throw error;
  }
}

/** Sends a signal to the owned POSIX process group when it still exists. */
function signalPosixProcessGroup(processGroupId, signal) {
  try {
    process.kill(-processGroupId, signal);
    return true;
  } catch (error) {
    if (isMissingProcessError(error)) return false;
    throw error;
  }
}

/** Waits up to the deadline for an owned POSIX process group to disappear. */
async function waitForPosixProcessGroupExit(processGroupId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (posixProcessGroupExists(processGroupId)) {
    if (Date.now() >= deadline) return false;
    await delay(PROCESS_EXIT_POLL_MS);
  }
  return true;
}

/** Gracefully terminates an owned POSIX process group, then force-kills it. */
async function terminatePosixProcessGroup(
  processGroupId,
  signal,
  shutdownGraceMs,
) {
  try {
    if (!signalPosixProcessGroup(processGroupId, signal)) return;
  } catch (error) {
    if (!isProcessPermissionError(error)) throw error;
    await terminateProcess(processGroupId, signal, shutdownGraceMs);
    return;
  }
  if (await waitForPosixProcessGroupExit(processGroupId, shutdownGraceMs)) {
    return;
  }

  try {
    signalPosixProcessGroup(processGroupId, "SIGKILL");
  } catch (error) {
    if (!isProcessPermissionError(error)) throw error;
    await terminateProcess(processGroupId, "SIGKILL", shutdownGraceMs);
    return;
  }
  await waitForPosixProcessGroupExit(processGroupId, shutdownGraceMs);
}

/** Terminates an owned Windows process tree using the existing fkill utility. */
async function terminateWindowsProcessTree(processId, shutdownGraceMs) {
  await fkill(processId, {
    forceAfterTimeout: shutdownGraceMs,
    silent: true,
    tree: true,
    waitForExit: shutdownGraceMs * 2,
  });
}

/** Returns whether one exact process identifier still exists. */
function processExists(processId) {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    if (isMissingProcessError(error)) return false;
    throw error;
  }
}

/** Waits up to the deadline for one exact process identifier to disappear. */
async function waitForProcessExit(processId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (processExists(processId)) {
    if (Date.now() >= deadline) return false;
    await delay(PROCESS_EXIT_POLL_MS);
  }
  return true;
}

/** Gracefully terminates one exact process, then force-kills it if necessary. */
async function terminateProcess(processId, signal, shutdownGraceMs) {
  try {
    process.kill(processId, signal);
  } catch (error) {
    if (isMissingProcessError(error)) return;
    throw error;
  }
  if (await waitForProcessExit(processId, shutdownGraceMs)) return;
  try {
    process.kill(processId, "SIGKILL");
  } catch (error) {
    if (!isMissingProcessError(error)) throw error;
  }
  await waitForProcessExit(processId, shutdownGraceMs);
}

/** Terminates every process descended from one owned command invocation. */
async function terminateOwnedProcessTree(child, signal, shutdownGraceMs) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    await terminateWindowsProcessTree(child.pid, shutdownGraceMs);
    return;
  }
  await terminatePosixProcessGroup(child.pid, signal, shutdownGraceMs);
}

/** Records a process owned by the current invocation in its private registry. */
export function registerOwnedProcess(registryPath, processId, processGroup) {
  if (!registryPath || !processId) return;
  appendFileSync(
    registryPath,
    `${JSON.stringify({ processGroup, processId })}\n`,
    "utf8",
  );
}

/** Reads valid process ownership entries from one private invocation registry. */
function readOwnedProcessRegistry(registryPath) {
  try {
    return readFileSync(registryPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter(
        (entry) =>
          entry &&
          Number.isInteger(entry.processId) &&
          entry.processId > 0 &&
          typeof entry.processGroup === "boolean",
      );
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

/** Terminates only the process identifiers registered by one invocation. */
export async function terminateRegisteredProcesses(
  registryPath,
  shutdownGraceMs = DEFAULT_SHUTDOWN_GRACE_MS,
) {
  const seen = new Set();
  const entries = readOwnedProcessRegistry(registryPath).reverse();
  const terminations = [];
  for (const entry of entries) {
    const key = `${entry.processGroup}:${entry.processId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (entry.processGroup && process.platform !== "win32") {
      terminations.push(
        terminatePosixProcessGroup(entry.processId, "SIGTERM", shutdownGraceMs),
      );
    } else if (process.platform === "win32") {
      terminations.push(
        terminateWindowsProcessTree(entry.processId, shutdownGraceMs),
      );
    } else {
      terminations.push(
        terminateProcess(entry.processId, "SIGTERM", shutdownGraceMs),
      );
    }
  }
  await Promise.all(terminations);
}

/** Removes shutdown handlers installed for one owned command invocation. */
function removeShutdownHandlers(handlers) {
  for (const [signal, handler] of handlers) {
    process.off(signal, handler);
  }
}

/**
 * Runs a command in an isolated process group and tears down all descendants.
 *
 * The returned outcome preserves either the command's exit code/signal or the
 * signal received by this runner while the command was active.
 */
export async function runOwnedCommand(command, args, options = {}) {
  const shutdownGraceMs = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
  const child = spawn(command, args, {
    ...options.spawnOptions,
    detached: process.platform !== "win32",
  });
  options.onSpawn?.(child);

  let requestShutdown;
  let receivedSignal = null;
  const shutdownRequested = new Promise((resolve) => {
    requestShutdown = resolve;
  });
  const shutdownHandlers = new Map();
  for (const signal of SHUTDOWN_SIGNALS) {
    /** Requests one idempotent shutdown while suppressing signal defaults. */
    const handleShutdownSignal = () => {
      receivedSignal ??= signal;
      requestShutdown({ code: null, signal });
    };
    shutdownHandlers.set(signal, handleShutdownSignal);
    process.on(signal, handleShutdownSignal);
  }

  const childExited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  let outcome;
  try {
    outcome = await Promise.race([childExited, shutdownRequested]);
    await terminateOwnedProcessTree(
      child,
      outcome.signal ?? "SIGTERM",
      shutdownGraceMs,
    );
  } catch (error) {
    await terminateOwnedProcessTree(child, "SIGTERM", shutdownGraceMs);
    throw error;
  } finally {
    removeShutdownHandlers(shutdownHandlers);
  }
  return receivedSignal ? { code: null, signal: receivedSignal } : outcome;
}

/** Exits this runner with the code or signal produced by its owned command. */
export function exitWithOutcome(outcome) {
  if (outcome.signal) {
    process.kill(process.pid, outcome.signal);
    return;
  }
  process.exit(outcome.code ?? 1);
}
