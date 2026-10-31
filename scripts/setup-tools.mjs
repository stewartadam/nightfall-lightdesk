#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { cargoToolsManifest, readCargoTools } from "./cargo-tools.mjs";

// The command that prints each pinned tool's version, as found on PATH.
const versionCommands = {
  "cargo-about": ["cargo", ["about", "--version"]],
  "cargo-hakari": ["cargo", ["hakari", "--version"]],
  "cargo-nextest": ["cargo", ["nextest", "--version"]],
  mdbook: ["mdbook", ["--version"]],
  "typeshare-cli": ["typeshare", ["--version"]],
};

/**
 * Return the version of a tool as the shell would run it, or `undefined` when it is missing or
 * prints no version. Probing the binary instead of cargo's install registry also sees tools
 * installed from release archives or a system package manager.
 */
export function probeVersion(name, run = spawnSync) {
  const [command, args] = versionCommands[name] ?? [name, ["--version"]];
  const { status, stdout } = run(command, args, { encoding: "utf8" });
  if (status !== 0) return undefined;
  return String(stdout).match(/\d+\.\d+\.\d+/)?.[0];
}

/**
 * Return the install commands, one per tool, that bring the requested tools to their pinned versions, skipping
 * tools that already match. cargo-binstall downloads release binaries when it is available;
 * otherwise `cargo install --locked` builds each tool from source. Both replace a binary of the
 * same name that cargo didn't install.
 */
export function installPlan(
  tools,
  installed,
  { binstall = false, only = [] } = {},
) {
  const unknown = only.filter((name) => !(name in tools));
  if (unknown.length > 0) {
    throw new Error(
      `Not pinned in ${cargoToolsManifest}: ${unknown.join(", ")}`,
    );
  }
  return Object.entries(tools)
    .filter(([name]) => only.length === 0 || only.includes(name))
    .filter(([name, version]) => installed.get(name) !== version)
    .map(([name, version]) => ({
      name,
      command: "cargo",
      args: binstall
        ? [
            "binstall",
            "--no-confirm",
            "--force",
            "--locked",
            `${name}@${version}`,
          ]
        : ["install", "--force", "--locked", name, "--version", version],
    }));
}

/** Whether cargo-binstall is installed, so tools can be downloaded instead of compiled. */
function hasBinstall() {
  return (
    spawnSync("cargo", ["binstall", "-V"], { stdio: "ignore" }).status === 0
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const tools = readCargoTools();
  const only = process.argv.slice(2);
  const installed = new Map(
    Object.keys(tools).map((name) => [name, probeVersion(name)]),
  );
  const plan = installPlan(tools, installed, { binstall: hasBinstall(), only });
  if (plan.length === 0)
    console.log("The Cargo tools already match their pins.");
  for (const { command, args } of plan) {
    console.log(`$ ${command} ${args.join(" ")}`);
    const { status } = spawnSync(command, args, { stdio: "inherit" });
    if (status !== 0) process.exit(status ?? 1);
  }
  // Another copy earlier on PATH, such as a Homebrew mdbook, keeps running instead.
  const shadowed = plan.filter(
    ({ name }) => probeVersion(name) !== tools[name],
  );
  for (const { name } of shadowed) {
    console.warn(
      `${name} ${tools[name]} is installed, but another ${name} earlier on PATH runs instead.`,
    );
  }
  if (shadowed.length > 0) process.exit(1);
}
