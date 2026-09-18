#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function commandFor(base) {
  if (process.platform === "win32") {
    return `${base}.exe`;
  }
  return base;
}

function runCapture(command, args, options = {}) {
  return new Promise((resolveOutput, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? process.cwd(),
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolveOutput(stdout);
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(" ")} failed (code=${code ?? "null"}, signal=${signal ?? "null"}): ${stderr.trim()}`,
        ),
      );
    });
  });
}

function run(command, args, options = {}) {
  return new Promise((resolveExit, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? process.cwd(),
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: options.stdio ?? "inherit",
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      resolveExit({ code: code ?? 1, signal });
    });
  });
}

async function runChecked(command, args, options = {}) {
  const result = await run(command, args, options);
  if (result.code !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (code=${result.code}, signal=${result.signal ?? "null"})`,
    );
  }
}

function trimLine(value) {
  return value.replace(/\r/g, "").trim();
}

async function maybeWslPathToUnix(pathValue) {
  try {
    const converted = await runCapture("wslpath", ["-u", pathValue]);
    return trimLine(converted);
  } catch {
    return null;
  }
}

function convertWindowsPathToWsl(pathValue) {
  const withForwardSlashes = pathValue.replace(/\\/g, "/");
  const match = withForwardSlashes.match(/^([A-Za-z]):\/(.*)$/u);
  if (!match) {
    return withForwardSlashes;
  }
  const drive = match[1].toLowerCase();
  return `/mnt/${drive}/${match[2]}`;
}

async function normalizeGitPath(pathValue, projectRoot, wslMode) {
  const trimmed = trimLine(pathValue);
  if (!trimmed) {
    return "";
  }

  if (wslMode && /^[A-Za-z]:[\\/]/u.test(trimmed)) {
    const viaWslpath = await maybeWslPathToUnix(trimmed);
    if (viaWslpath) {
      return viaWslpath;
    }
    return convertWindowsPathToWsl(trimmed);
  }

  const withSlashes = trimmed.replace(/\\/g, "/");
  if (/^[A-Za-z]:\//u.test(withSlashes)) {
    return withSlashes;
  }

  if (withSlashes.startsWith("/")) {
    return withSlashes;
  }

  return resolve(projectRoot, withSlashes);
}

async function resolveCommonGitDir(projectRoot, wslMode) {
  const git = commandFor("git");
  let common = "";

  try {
    common = trimLine(
      await runCapture(git, [
        "-C",
        projectRoot,
        "rev-parse",
        "--git-common-dir",
      ]),
    );
  } catch {
    common = "";
  }

  if (!common && wslMode) {
    try {
      const projectRootWin = trimLine(
        await runCapture("wslpath", ["-w", projectRoot]),
      );
      common = trimLine(
        await runCapture("git.exe", [
          "-C",
          projectRootWin,
          "rev-parse",
          "--git-common-dir",
        ]),
      );
    } catch {
      common = "";
    }
  }

  if (!common) {
    return "";
  }

  return normalizeGitPath(common, projectRoot, wslMode);
}

async function copyWithPreferredMode(
  sourceTarget,
  targetDir,
  platform,
  wslMode,
) {
  if (platform === "linux") {
    process.stdout.write(
      "INFO: Copy method: reflink (cp --reflink=always -a)\n",
    );
    const result = await run(
      "cp",
      ["--reflink=always", "-a", sourceTarget, targetDir],
      { stdio: "ignore" },
    );
    if (result.code === 0) {
      process.stdout.write(
        `OK: Seeded target/ from ${sourceTarget} via reflink\n`,
      );
      return true;
    }
    return false;
  }

  if (platform === "darwin") {
    process.stdout.write("INFO: Copy method: clonefile (cp -cR)\n");
    const result = await run("cp", ["-cR", sourceTarget, targetDir], {
      stdio: "ignore",
    });
    if (result.code === 0) {
      process.stdout.write(
        `OK: Seeded target/ from ${sourceTarget} via clonefile\n`,
      );
      return true;
    }
    return false;
  }

  if (platform === "win32" && !wslMode) {
    process.stdout.write("INFO: Copy method: robocopy optimized\n");
    const sourceWin = sourceTarget.replace(/\//g, "\\");
    const targetWin = targetDir.replace(/\//g, "\\");
    const result = await run("robocopy", [
      sourceWin,
      targetWin,
      "/E",
      "/COPY:DAT",
      "/DCOPY:DAT",
      "/R:1",
      "/W:1",
      "/NFL",
      "/NDL",
      "/NJH",
      "/NJS",
      "/NP",
    ]);
    if (result.code <= 7) {
      process.stdout.write(
        `OK: Seeded target/ from ${sourceTarget} via robocopy\n`,
      );
      return true;
    }
    return false;
  }

  return false;
}

async function copyWithFallbackMode(
  sourceTarget,
  targetDir,
  platform,
  wslMode,
) {
  if (platform === "win32" && !wslMode) {
    process.stdout.write("INFO: Copy method: robocopy fallback\n");
    const sourceWin = sourceTarget.replace(/\//g, "\\");
    const targetWin = targetDir.replace(/\//g, "\\");
    const result = await run("robocopy", [
      sourceWin,
      targetWin,
      "/E",
      "/COPY:DAT",
      "/DCOPY:DAT",
      "/R:1",
      "/W:1",
    ]);
    if (result.code <= 7) {
      process.stdout.write(
        `OK: Seeded target/ from ${sourceTarget} via robocopy fallback\n`,
      );
      return true;
    }
    return false;
  }

  process.stdout.write("INFO: Copy method: standard copy (cp -a)\n");
  const resultA = await run("cp", ["-a", sourceTarget, targetDir], {
    stdio: "ignore",
  });
  if (resultA.code === 0) {
    process.stdout.write(
      `OK: Seeded target/ from ${sourceTarget} via standard copy\n`,
    );
    return true;
  }

  process.stdout.write("INFO: Copy method: recursive copy (cp -R)\n");
  const resultR = await run("cp", ["-R", sourceTarget, targetDir], {
    stdio: "ignore",
  });
  if (resultR.code === 0) {
    process.stdout.write(
      `OK: Seeded target/ from ${sourceTarget} via recursive copy\n`,
    );
    return true;
  }

  return false;
}

async function main() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const projectRoot = dirname(scriptDir);
  const wslMode =
    process.platform === "linux" &&
    (Boolean(process.env.WSL_DISTRO_NAME) ||
      existsSync("/proc/sys/fs/binfmt_misc/WSLInterop"));

  const commonGitDir = await resolveCommonGitDir(projectRoot, wslMode);
  let mainWorktree = "";
  if (commonGitDir) {
    mainWorktree = dirname(commonGitDir);
  }

  const sourceTarget = join(mainWorktree, "target");
  const targetDir = join(projectRoot, "target");

  if (!mainWorktree) {
    process.stdout.write(
      "WARN: Could not resolve main worktree; skipping target seed\n",
    );
    return;
  }
  if (mainWorktree === projectRoot) {
    process.stdout.write(
      "INFO: Running in main worktree; skipping target seed\n",
    );
    return;
  }
  if (!existsSync(sourceTarget)) {
    process.stdout.write(
      `INFO: No source target/ at ${sourceTarget}; skipping seed\n`,
    );
    return;
  }
  if (existsSync(targetDir)) {
    process.stdout.write("INFO: target/ already exists; skipping seed\n");
    return;
  }

  const cleanupScript = join(scriptDir, "cargo-cleanup.mjs");
  await runChecked(process.execPath, [cleanupScript], { cwd: mainWorktree });

  const copiedPreferred = await copyWithPreferredMode(
    sourceTarget,
    targetDir,
    process.platform,
    wslMode,
  );
  if (copiedPreferred) {
    return;
  }

  const copiedFallback = await copyWithFallbackMode(
    sourceTarget,
    targetDir,
    process.platform,
    wslMode,
  );
  if (copiedFallback) {
    return;
  }

  throw new Error(`Failed to seed target/ from ${sourceTarget}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`WARN: ${message}\n`);
  process.exit(1);
});
