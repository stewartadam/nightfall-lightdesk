// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { fileURLToPath } from "node:url";
import { exitWithOutcome, runOwnedCommand } from "./owned-process.mjs";

const BACKEND_BIN = "nightfall-headless";

/**
 * Select one runtime workspace graph, using every crate's default features, for
 * linting, tests, the dev backend, and the browser-test backend.
 */
export function nativeCargoArgs(command, args = []) {
  return [
    command,
    // Include dev dependencies when building the backend so Cargo uses the test graph.
    ...(command === "build" ? ["--tests"] : []),
    "--workspace",
    "--exclude",
    "app-tauri",
    ...args,
  ];
}

/** Resolves the Cargo executable, honouring a worktree's NIGHTFALL_CARGO_COMMAND override. */
export function cargoCommand(env = process.env) {
  return (
    env.NIGHTFALL_CARGO_COMMAND?.trim() ||
    (process.platform === "win32" ? "cargo.exe" : "cargo")
  );
}

/**
 * Extracts the non-test backend executable path from one line of Cargo's JSON
 * message stream, returning undefined for every other message.
 */
export function backendExecutableFromMessage(line) {
  if (!line.startsWith("{")) return undefined;
  const message = JSON.parse(line);
  if (
    message.reason === "compiler-artifact" &&
    message.target?.name === BACKEND_BIN &&
    message.target.kind?.includes("bin") &&
    !message.profile?.test
  ) {
    return message.executable ?? undefined;
  }
  return undefined;
}

/**
 * Builds the backend in the shared workspace graph, then runs it with the given
 * arguments. `cargo run` cannot select the whole workspace or its dev
 * dependencies, so it would resolve a different feature graph than the hooks.
 */
async function runBackend(cargo, args) {
  let executable;
  let pending = "";
  const buildOutcome = await runOwnedCommand(
    cargo,
    nativeCargoArgs("build", [
      "--bin",
      BACKEND_BIN,
      "--message-format=json-render-diagnostics",
    ]),
    {
      onSpawn: (child) => {
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
          const lines = (pending + chunk).split("\n");
          pending = lines.pop();
          for (const line of lines) {
            executable = backendExecutableFromMessage(line) ?? executable;
          }
        });
      },
      spawnOptions: { stdio: ["ignore", "pipe", "inherit"] },
    },
  );
  if (buildOutcome.code !== 0 || buildOutcome.signal) return buildOutcome;
  executable = backendExecutableFromMessage(pending) ?? executable;
  if (!executable) {
    throw new Error(`Cargo did not report a ${BACKEND_BIN} executable`);
  }
  return runOwnedCommand(executable, args, {
    spawnOptions: { stdio: "inherit" },
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  const cargo = cargoCommand();
  if (command === "run") {
    exitWithOutcome(await runBackend(cargo, args));
  } else if (["build", "clippy", "test"].includes(command)) {
    exitWithOutcome(
      await runOwnedCommand(cargo, nativeCargoArgs(command, args), {
        spawnOptions: { stdio: "inherit" },
      }),
    );
  } else {
    throw new Error("Expected build, clippy, run, or test");
  }
}
