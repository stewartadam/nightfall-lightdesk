// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/**
 * Returns the platform-specific command name for an executable.
 */
export function commandFor(base) {
  if (process.platform === "win32") {
    return `${base}.exe`;
  }
  return base;
}

/**
 * Runs a child process and captures its standard output.
 */
export function runCapture(command, args, options = {}) {
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

/**
 * Trims command output to a single normalized path-like line.
 */
export function trimLine(value) {
  return value.replace(/\r/g, "").trim();
}

/**
 * Returns whether this Linux process is running inside WSL.
 */
export function isWslMode() {
  return (
    process.platform === "linux" &&
    (Boolean(process.env.WSL_DISTRO_NAME) ||
      existsSync("/proc/sys/fs/binfmt_misc/WSLInterop"))
  );
}

/**
 * Converts a Windows path to a WSL Unix path when wslpath is available.
 */
export async function maybeWslPathToUnix(pathValue) {
  try {
    const converted = await runCapture("wslpath", ["-u", pathValue]);
    return trimLine(converted);
  } catch {
    return null;
  }
}

/**
 * Converts a Windows absolute path to a best-effort WSL mount path.
 */
export function convertWindowsPathToWsl(pathValue) {
  const withForwardSlashes = pathValue.replace(/\\/g, "/");
  const match = withForwardSlashes.match(/^([A-Za-z]):\/(.*)$/u);
  if (!match) {
    return withForwardSlashes;
  }
  const drive = match[1].toLowerCase();
  return `/mnt/${drive}/${match[2]}`;
}

/**
 * Converts a Git path into an absolute path rooted at the supplied project.
 */
export async function normalizeGitPath(pathValue, projectRoot, wslMode) {
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
  if (/^[A-Za-z]:\//u.test(withSlashes) || withSlashes.startsWith("/")) {
    return withSlashes;
  }

  return resolve(projectRoot, withSlashes);
}

/**
 * Resolves the primary worktree for the Git repository containing projectRoot.
 */
export async function resolveMainWorktree(projectRoot) {
  const git = commandFor("git");
  const wslMode = isWslMode();
  let commonGitDir = "";

  try {
    commonGitDir = await normalizeGitPath(
      await runCapture(git, [
        "-C",
        projectRoot,
        "rev-parse",
        "--git-common-dir",
      ]),
      projectRoot,
      wslMode,
    );
  } catch {
    commonGitDir = "";
  }

  if (!commonGitDir && wslMode) {
    try {
      const projectRootWin = trimLine(
        await runCapture("wslpath", ["-w", projectRoot]),
      );
      commonGitDir = await normalizeGitPath(
        await runCapture("git.exe", [
          "-C",
          projectRootWin,
          "rev-parse",
          "--git-common-dir",
        ]),
        projectRoot,
        wslMode,
      );
    } catch {
      commonGitDir = "";
    }
  }

  if (!commonGitDir) {
    return "";
  }

  return dirname(commonGitDir);
}

/**
 * Parses one dotenv value without expanding shell expressions.
 */
export function parseEnvValue(rawValue) {
  const trimmed = rawValue.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Reads a dotenv file into a key-value map.
 */
export async function readEnvMap(envPath) {
  if (!existsSync(envPath)) {
    return {};
  }

  const contents = await readFile(envPath, "utf8");
  /** @type {Record<string, string>} */
  const values = {};

  for (const line of contents.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;

    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex <= 0) continue;

    const key = trimmed.slice(0, equalsIndex).trim();
    const value = parseEnvValue(trimmed.slice(equalsIndex + 1));
    values[key] = value;
  }

  return values;
}

/**
 * Resolves a dotenv path value relative to the worktree where it is used.
 */
export function resolveEnvPath(value, worktreePath) {
  const trimmed = value.trim();
  if (/^[A-Za-z]:[\\/]/u.test(trimmed) || trimmed.startsWith("/")) {
    return trimmed;
  }
  return resolve(worktreePath, trimmed);
}

/**
 * Returns the default Nightfall data directory for the current platform.
 */
export function defaultNightfallDataDir(env = process.env) {
  const home = env.HOME || env.USERPROFILE;
  if (!home)
    throw new Error("HOME is not set; cannot resolve Nightfall data dir");

  if (process.platform === "darwin") {
    return join(
      home,
      "Library",
      "Application Support",
      "com.nightfall.nightfall",
    );
  }
  if (process.platform === "linux") {
    return join(
      env.XDG_DATA_HOME || join(home, ".local", "share"),
      "nightfall",
    );
  }
  if (process.platform === "win32") {
    const appData = env.APPDATA || join(home, "AppData", "Roaming");
    return join(appData, "nightfall");
  }

  throw new Error(`unsupported platform: ${process.platform}`);
}

/**
 * Resolves the Nightfall data directory that should be treated as persistent for a worktree.
 */
export async function resolvePersistentNightfallDataDir(
  worktreePath,
  env = process.env,
) {
  const worktreeEnv = await readEnvMap(join(worktreePath, ".env"));
  const configuredDataDir =
    worktreeEnv.NIGHTFALL_DATA_DIR?.trim() || env.NIGHTFALL_DATA_DIR?.trim();

  if (configuredDataDir) {
    return resolveEnvPath(configuredDataDir, worktreePath);
  }

  return defaultNightfallDataDir(env);
}
