#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import path from "node:path";

const targetPath = path.normalize(
  path.resolve(process.env.WORKTREE_TARGET?.trim() || ""),
);

if (!targetPath) {
  console.error("kill-backend: missing target worktree path");
  process.exit(1);
}

const dashboardUrl = (
  process.env.NIGHTFALL_WORKTREE_DASHBOARD_URL ??
  `http://${process.env.NIGHTFALL_WORKTREE_DASHBOARD_HOST ?? "127.0.0.1"}:${process.env.NIGHTFALL_WORKTREE_DASHBOARD_PORT ?? "4780"}`
).replace(/\/+$/u, "");

/**
 * Requests a dashboard route, exiting successfully when the dashboard backend
 * is unreachable because cleanup can safely proceed without managed services.
 */
async function fetchDashboard(route, options) {
  let response;
  try {
    response = await fetch(`${dashboardUrl}${route}`, {
      ...options,
      signal: AbortSignal.timeout(5000),
    });
  } catch (error) {
    console.error(
      `kill-backend: unable to reach worktree dashboard at ${dashboardUrl}; proceeding without stopping managed services`,
    );
    if (error instanceof Error && error.message) {
      console.error(error.message);
    }
    process.exit(0);
  }

  const text = await response.text();
  if (!response.ok) {
    console.error(
      `kill-backend: dashboard request failed (${response.status}): ${text || response.statusText}`,
    );
    process.exit(1);
  }

  return text;
}

const payload = JSON.parse(await fetchDashboard("/api/worktrees"));
if (!payload || !Array.isArray(payload.worktrees)) {
  console.error("kill-backend: dashboard payload is missing worktrees");
  process.exit(1);
}

const match = payload.worktrees.find(
  (entry) =>
    path.normalize(path.resolve(String(entry.path ?? ""))) === targetPath,
);

if (!match) {
  const known = payload.worktrees
    .map((entry) => String(entry.path ?? ""))
    .filter(Boolean)
    .join("\n");
  console.error(
    [
      "kill-backend: worktree path was not found in dashboard data.",
      `requested: ${targetPath}`,
      `known:\n${known}`,
    ].join("\n"),
  );
  process.exit(1);
}

const result = JSON.parse(
  await fetchDashboard(
    `/api/worktrees/${encodeURIComponent(String(match.id))}/stop?service=all`,
    { method: "POST" },
  ),
);

console.log(
  JSON.stringify(
    {
      worktree: {
        id: match.id,
        path: match.path,
        branch: match.branch,
        name: match.name,
      },
      action: "stop",
      service: "all",
      result,
    },
    null,
    2,
  ),
);
