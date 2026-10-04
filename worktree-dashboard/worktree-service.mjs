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
  DASHBOARD_BASE_URL,
  DashboardUnreachableError,
  fetchWorktrees,
  findWorktree,
  manageWorktree,
  resolveWorktreeServiceTargets,
  summarizeWorktree,
  WORKTREE_MANAGED_SERVICES,
} from "./dashboard-client.mjs";

const COMMAND_ACTIONS = { start: "start", stop: "stop", restart: "recycle" };

const USAGE = `Usage: wt [-C <worktree>] service <command> [options]

Manages this worktree's services through the worktree dashboard API
(pnpm run worktree:dashboard). Use wt -C <path> to target another worktree.

Commands:
  list                   List worktrees with their ports and service status
  status                 Show service status for this worktree
  start                  Start services and wait until they are reachable
  stop                   Stop services
  restart                Restart services and wait until they are reachable

Options:
  -s, --service <name>   Service to target, repeatable or comma separated:
                         ${[...WORKTREE_MANAGED_SERVICES, ALL_SELECTOR].join(", ")}
                         (default: backend)
      --json             Print the raw result as JSON
  -h, --help             Show this help`;

/**
 * Parses CLI arguments into a command, the target worktree path, the services
 * to target, and output flags. Throws on unknown commands or services, extra
 * positional arguments, or a missing worktree for commands that need one.
 */
export function parseCliArgs(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      worktree: { type: "string" },
      service: { type: "string", short: "s", multiple: true },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  const [command, ...extra] = positionals;
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
  if (extra.length > 0) {
    throw new Error(`Unexpected argument "${extra[0]}"`);
  }
  if (command !== "list" && !values.worktree) {
    throw new Error("--worktree <path> is required");
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
    worktree: values.worktree ?? null,
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
 * 0 on success, 1 when a service failed to come up. A stop succeeds when the
 * dashboard is unreachable, since no dashboard means no managed services, so
 * the worktree pre-remove hook never blocks on it.
 */
export async function main(argv) {
  const options = parseCliArgs(argv);
  if (options.command === "help") {
    console.log(USAGE);
    return 0;
  }

  let worktrees;
  try {
    worktrees = await fetchWorktrees();
  } catch (error) {
    if (
      options.command === "stop" &&
      error instanceof DashboardUnreachableError
    ) {
      console.error(
        `No worktree dashboard at ${DASHBOARD_BASE_URL}, so no managed services to stop.`,
      );
      return 0;
    }
    throw error;
  }

  if (options.command === "list") {
    const summaries = worktrees.map(summarizeWorktree);
    console.log(
      options.json
        ? JSON.stringify(summaries, null, 2)
        : formatWorktreeList(summaries),
    );
    return 0;
  }

  const target = findWorktree(worktrees, options.worktree);

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
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
