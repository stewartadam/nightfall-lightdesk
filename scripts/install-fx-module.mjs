#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

/**
 * Returns the command-line usage text for the fx module installer.
 */
function usage() {
  return `usage: npm run fx-module:install -- <manifest-or-dir> [options]

Options:
  --release             Build and package the release profile
  --profile <profile>   Build and package a named Cargo profile
  --data-dir <path>     Install under a specific nightfall data directory
  --help                Show this help text
`;
}

/**
 * Parses CLI arguments into an install request.
 */
function parseArgs(argv) {
  const options = {
    profile: "debug",
    dataDir: process.env.NIGHTFALL_DATA_DIR?.trim() || undefined,
    manifestInput: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(usage());
      process.exit(0);
    }
    if (arg === "--release") {
      options.profile = "release";
      continue;
    }
    if (arg === "--profile") {
      const profile = argv[index + 1];
      if (!profile) throw new Error("--profile requires a profile name");
      options.profile = profile;
      index += 1;
      continue;
    }
    if (arg === "--data-dir") {
      const dataDir = argv[index + 1];
      if (!dataDir) throw new Error("--data-dir requires a path");
      options.dataDir = dataDir;
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`unknown option: ${arg}`);
    }
    if (options.manifestInput) {
      throw new Error(`unexpected extra argument: ${arg}`);
    }
    options.manifestInput = arg;
  }

  if (!options.manifestInput) {
    throw new Error("missing fx module manifest path or directory");
  }

  return options;
}

/**
 * Resolves a CLI manifest-or-directory input to a Cargo.toml path.
 */
async function resolveManifestPath(input) {
  const inputPath = resolve(process.cwd(), input);
  const inputStat = await stat(inputPath).catch(() => null);
  if (!inputStat) throw new Error(`path does not exist: ${input}`);

  const manifestPath = inputStat.isDirectory()
    ? join(inputPath, "Cargo.toml")
    : inputPath;

  if (basename(manifestPath) !== "Cargo.toml") {
    throw new Error(`expected a Cargo.toml manifest or directory: ${input}`);
  }
  if (!existsSync(manifestPath)) {
    throw new Error(`missing Cargo.toml at ${manifestPath}`);
  }

  return manifestPath;
}

/**
 * Returns the default nightfall data directory for the current platform.
 */
function defaultDataDir() {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) throw new Error("HOME is not set; pass --data-dir explicitly");

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
      process.env.XDG_DATA_HOME || join(home, ".local", "share"),
      "nightfall",
    );
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || join(home, "AppData", "Roaming");
    return join(appData, "nightfall");
  }

  throw new Error(`unsupported platform: ${process.platform}`);
}

/**
 * Runs a child process and exits with the child status on failure.
 */
function run(command, args, options = {}) {
  process.stdout.write(`$ ${[command, ...args].join(" ")}\n`);
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: options.capture ? ["inherit", "pipe", "inherit"] : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  return result.stdout ?? "";
}

/**
 * Builds the fx module core wasm for the requested profile.
 */
function buildModule(manifestPath, profile) {
  const args = [
    "build",
    "--manifest-path",
    manifestPath,
    "--target",
    "wasm32-unknown-unknown",
  ];

  if (profile === "release") {
    args.push("--release");
  } else if (profile !== "debug") {
    args.push("--profile", profile);
  }

  run("cargo", args);
}

/**
 * Runs the module's package-component helper and returns its output component path.
 */
function packageModule(manifestPath, profile) {
  const args = [
    "run",
    "--manifest-path",
    manifestPath,
    "--bin",
    "package-component",
  ];

  if (profile !== "debug") {
    args.push("--", profile);
  }

  const output = run("cargo", args, { capture: true });
  process.stdout.write(output);
  const componentPath = output
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);

  if (!componentPath) {
    throw new Error("package-component did not print a component path");
  }

  return isAbsolute(componentPath)
    ? componentPath
    : resolve(dirname(manifestPath), componentPath);
}

/**
 * Installs the component file into nightfall's fx-modules directory.
 */
async function installComponent(componentPath, dataDir) {
  const destinationDir = join(dataDir, "fx-modules");
  const destinationPath = join(destinationDir, basename(componentPath));
  await mkdir(destinationDir, { recursive: true });
  await copyFile(componentPath, destinationPath);
  return destinationPath;
}

/**
 * Packages and installs a local fx module crate.
 */
async function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifestPath = await resolveManifestPath(options.manifestInput);
  const dataDir = resolve(options.dataDir ?? defaultDataDir());

  buildModule(manifestPath, options.profile);
  const componentPath = packageModule(manifestPath, options.profile);
  const installedPath = await installComponent(componentPath, dataDir);

  process.stdout.write(`Installed ${installedPath}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`error: ${message}\n\n${usage()}`);
  process.exit(1);
});
