#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, copyFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MODEL_RELATIVE_PATH = "webui/assets/models/beat-this/beat_this.onnx";

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

function trimLine(value) {
  return value.replace(/\r/g, "").trim();
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function normalizeGitPath(pathValue, projectRoot) {
  const trimmed = trimLine(pathValue);
  if (!trimmed) {
    return "";
  }

  const withSlashes = trimmed.replace(/\\/g, "/");
  if (/^[A-Za-z]:\//u.test(withSlashes) || withSlashes.startsWith("/")) {
    return withSlashes;
  }

  return resolve(projectRoot, withSlashes);
}

async function resolveMainWorktree(projectRoot) {
  const git = commandFor("git");
  const commonGitDir = await normalizeGitPath(
    await runCapture(git, ["-C", projectRoot, "rev-parse", "--git-common-dir"]),
    projectRoot,
  );

  if (!commonGitDir) {
    return "";
  }

  return dirname(commonGitDir);
}

async function main() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const projectRoot = dirname(scriptDir);
  const mainWorktree = await resolveMainWorktree(projectRoot);

  if (!mainWorktree) {
    process.stdout.write(
      "WARN: Could not resolve main worktree; skipping Beat This model seed\n",
    );
    return;
  }
  if (mainWorktree === projectRoot) {
    process.stdout.write(
      "INFO: Running in main worktree; skipping Beat This model seed\n",
    );
    return;
  }

  const sourceModel = join(mainWorktree, MODEL_RELATIVE_PATH);
  const targetModel = join(projectRoot, MODEL_RELATIVE_PATH);

  if (await pathExists(targetModel)) {
    process.stdout.write(
      `INFO: ${MODEL_RELATIVE_PATH} already exists; skipping seed\n`,
    );
    return;
  }
  if (!(await pathExists(sourceModel))) {
    process.stdout.write(
      `INFO: No source Beat This model at ${sourceModel}; skipping seed\n`,
    );
    return;
  }

  await mkdir(dirname(targetModel), { recursive: true });
  await copyFile(sourceModel, targetModel, constants.COPYFILE_FICLONE);
  process.stdout.write(
    `OK: Seeded ${MODEL_RELATIVE_PATH} from main worktree\n`,
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`WARN: ${message}\n`);
  process.exit(1);
});
