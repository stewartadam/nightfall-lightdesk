#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  ALL_SELECTOR,
  fetchWorktrees,
  manageWorktree,
  resolveWorktreeServiceTargets,
  selectWorktree,
  summarizeWorktree,
  WORKTREE_MANAGED_SERVICES,
} from "./dashboard-client.mjs";

const COMMAND_ACTIONS = { start: "start", stop: "stop", restart: "recycle" };

const USAGE = `Usage: pnpm run worktree <command> [worktree] [options]

Talks to the worktree dashboard API (pnpm run worktree:dashboard).

Commands:
  list                       List worktrees with their ports and service status
  status [worktree]          Show service status for one worktree
  start [worktree]           Start services and wait until they are reachable
  stop [worktree]            Stop services
  restart [worktree]         Restart services and wait until they are reachable

[worktree] is a path, name, branch, or dashboard id. It defaults to the
worktree containing the current directory.

Options:
  -s, --service <name>       Service to target, repeatable or comma separated:
                             ${[...WORKTREE_MANAGED_SERVICES, ALL_SELECTOR].join(", ")}
                             (default: backend)
      --json                 Print the raw result as JSON
  -h, --help                 Show this help`;

/**
 * Parses CLI arguments into a command, an optional worktree selector, the
 * services to target, and output flags. Throws on unknown commands, unknown
 * services, or extra positional arguments.
 */
export function parseCliArgs(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      service: { type: "string", short: "s", multiple: true },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  const [command, selector, ...extra] = positionals;
  if (values.help || !command) {
    return { command: "help" };
  }
  if (
    command !== "list" &&
    command !== "status" &&
    !Object.hasOwn(COMMAND_ACTIONS, command)
  ) {
    throw new Error(`Unknown command "${command}"\n\n${USAGE}`);
  }
  if (extra.length > 0 || (command === "list" && selector)) {
    throw new Error(`Unexpected argument "${extra[0] ?? selector}"`);
  }

  const requested = (values.service ?? ["backend"]).flatMap((value) =>
    value.split(","),
  );
  const unknown = requested.filter(
    (service) =>
      service.trim() &&
      service.trim() !== ALL_SELECTOR &&
      !WORKTREE_MANAGED_SERVICES.includes(service.trim()),
  );
  if (unknown.length > 0) {
    throw new Error(
      `Unknown service "${unknown[0]}"; expected one of: ${[...WORKTREE_MANAGED_SERVICES, ALL_SELECTOR].join(", ")}`,
    );
  }

  const services = resolveWorktreeServiceTargets(requested);
  if (services.length === 0) {
    throw new Error("--service needs at least one service name");
  }

  return {
    command,
    selector: selector ?? null,
    services,
    json: values.json,
  };
}

/** Renders one line per worktree with its backend port and service status. */
function formatWorktreeList(summaries) {
  const rows = summaries.map((summary) => [
    summary.name,
    summary.branch ?? "detached",
    String(summary.nightfallPort ?? "-"),
    summary.backend,
    summary.ui,
  ]);
  const header = ["NAME", "BRANCH", "PORT", "BACKEND", "UI"];
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => row[column].length)),
  );
  return [header, ...rows]
    .map((row) =>
      row
        .map((cell, column) => cell.padEnd(widths[column]))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

/** Renders a worktree's identity, URLs, and the status of every service. */
function formatWorktreeStatus(summary) {
  return [
    `${summary.name} (${summary.branch ?? "detached"})`,
    `  path:    ${summary.path}`,
    `  backend: ${summary.backend} on port ${summary.nightfallPort ?? "-"}`,
    `  ui:      ${summary.ui}${summary.webUiUrl ? ` at ${summary.webUiUrl}` : ""}`,
    `  wasm:    ${summary.wasm}`,
    `  art-net sender: ${summary.artnetSender}`,
    `  sACN sender:    ${summary.sacnSender}`,
  ].join("\n");
}

/**
 * Renders the outcome of a lifecycle action: each service's startup state
 * (with the log tail for failures) after start/restart, or the refreshed
 * status after stop.
 */
function formatManageResult(command, services, result) {
  const lines = [`${command} ${result.worktree.name}: ${services.join(", ")}`];
  if (!result.startup) {
    for (const service of services) {
      lines.push(
        `  ${service}: ${result.worktree[serviceSummaryKey(service)]}`,
      );
    }
    return lines.join("\n");
  }
  for (const state of result.startup.services) {
    lines.push(`  ${state.service}: ${state.status}`);
    if (state.status === "failed") {
      const detail =
        state.lastError ??
        `exited with ${state.lastExitSignal ?? `code ${state.lastExitCode}`}`;
      lines.push(`    ${detail}`);
      if (state.logPath) lines.push(`    log: ${state.logPath}`);
      if (state.logTail) {
        lines.push(
          state.logTail
            .split("\n")
            .map((line) => `    | ${line}`)
            .join("\n"),
        );
      }
    }
  }
  if (result.startup.timedOut) {
    lines.push(
      `  timed out after ${Math.round(result.startup.waitMs / 1000)}s waiting for services to come up`,
    );
  }
  return lines.join("\n");
}

/** Maps a managed service name to its key on a worktree summary. */
function serviceSummaryKey(service) {
  if (service === "artnet-sender") return "artnetSender";
  if (service === "sacn-sender") return "sacnSender";
  return service;
}

/**
 * Reports whether a start/restart left every targeted service online; a stop
 * always counts as successful once the dashboard accepted it.
 */
function manageSucceeded(result) {
  if (!result.startup) return true;
  return (
    !result.startup.timedOut &&
    result.startup.services.every((state) => state.status === "online")
  );
}

/**
 * Runs the CLI against the dashboard and returns the process exit code:
 * 0 on success, 1 when a service failed to come up.
 */
export async function main(argv, cwd) {
  const options = parseCliArgs(argv);
  if (options.command === "help") {
    console.log(USAGE);
    return 0;
  }

  const worktrees = await fetchWorktrees();

  if (options.command === "list") {
    const summaries = worktrees.map(summarizeWorktree);
    console.log(
      options.json
        ? JSON.stringify(summaries, null, 2)
        : formatWorktreeList(summaries),
    );
    return 0;
  }

  const target = selectWorktree(worktrees, options.selector, cwd);

  if (options.command === "status") {
    const summary = summarizeWorktree(target);
    console.log(
      options.json
        ? JSON.stringify(summary, null, 2)
        : formatWorktreeStatus(summary),
    );
    return 0;
  }

  if (!options.json && options.command !== "stop") {
    console.log(
      `${options.command === "restart" ? "Restarting" : "Starting"} ${options.services.join(", ")} for ${target.name}; waiting for it to come up...`,
    );
  }
  const result = await manageWorktree(
    target.path,
    COMMAND_ACTIONS[options.command],
    options.services,
  );
  console.log(
    options.json
      ? JSON.stringify(result, null, 2)
      : formatManageResult(options.command, options.services, result),
  );
  return manageSucceeded(result) ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.exitCode = await main(
      process.argv.slice(2),
      process.env.INIT_CWD ?? process.cwd(),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
