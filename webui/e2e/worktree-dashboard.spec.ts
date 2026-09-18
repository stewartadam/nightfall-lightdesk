// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, test } from "./playwright-fixtures";

const EMPTY_SERVICE_STATE = {
  pid: null,
  running: false,
  startedAt: null,
  lastExitCode: null,
  lastExitSignal: null,
  lastError: null,
  logPath: null,
};

/**
 * Builds the managed-service snapshot expected by the worktree dashboard UI.
 */
function managedServices() {
  return {
    backend: EMPTY_SERVICE_STATE,
    ui: EMPTY_SERVICE_STATE,
    wasm: EMPTY_SERVICE_STATE,
    "artnet-sender": EMPTY_SERVICE_STATE,
    "sacn-sender": EMPTY_SERVICE_STATE,
  };
}

/**
 * Builds the observed process snapshot expected by the worktree dashboard UI.
 */
function observedProcesses() {
  return {
    backendPortOpen: false,
    webUiPortOpen: false,
    backendPid: null,
    webUiPid: null,
    artnetSenderRunning: false,
    sacnSenderRunning: false,
  };
}

/**
 * Creates a minimal dashboard worktree payload for grouping assertions.
 */
function worktree({
  branch,
  envExists,
  port,
}: {
  branch: string;
  envExists: boolean;
  port: number | null;
}) {
  const path = `/tmp/nightfall-worktrees/${branch.replaceAll("/", "-")}`;
  return {
    id: btoa(path),
    path,
    name: branch.replaceAll("/", "-"),
    branch,
    head: "0000000000000000000000000000000000000000",
    isMain: branch === "main",
    envPath: `${path}/.env`,
    envExists,
    nightfallPort: port,
    webUiPort: port === null ? null : port + 1,
    webUiUrl: port === null ? null : `http://localhost:${port + 1}`,
    managed: managedServices(),
    observed: observedProcesses(),
  };
}

test("worktree dashboard groups uninitialized worktrees at the bottom", async ({
  page,
}) => {
  await page.route("**/worktree-api/worktrees", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        generatedAt: new Date("2026-05-29T12:00:00Z").toISOString(),
        dashboardPid: 12345,
        worktrees: [
          worktree({
            branch: "split/layer-panel-sampling",
            envExists: false,
            port: null,
          }),
          worktree({
            branch: "action-registry",
            envExists: true,
            port: 3080,
          }),
        ],
      }),
    });
  });

  await page.goto("/worktree-dashboard.html");

  await expect(
    page.locator("strong", { hasText: "action-registry" }),
  ).toBeVisible();
  await expect(
    page.locator("strong", { hasText: "split/layer-panel-sampling" }),
  ).toBeVisible();
  await expect(page.getByText("Uninitialized worktrees")).toBeVisible();
  await expect(page.getByText(".env missing")).toBeVisible();
  await expect(page.getByText("Unavailable until .env exists")).toBeVisible();

  const tableText = (await page.locator("tbody").innerText()).toLowerCase();
  expect(tableText.indexOf("action-registry")).toBeLessThan(
    tableText.indexOf("uninitialized worktrees"),
  );
  expect(tableText.indexOf("uninitialized worktrees")).toBeLessThan(
    tableText.indexOf("split/layer-panel-sampling"),
  );
  await page.screenshot({
    path: test.info().outputPath("shared-worktree-table.png"),
    fullPage: true,
  });
});

/** Verifies the data-directory action targets the selected worktree API route. */
test("worktree dashboard re-seeds a secondary worktree data directory", async ({
  page,
}) => {
  const target = worktree({
    branch: "reseed-target",
    envExists: true,
    port: 3080,
  });

  await page.route("**/worktree-api/worktrees", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        generatedAt: new Date("2026-08-16T12:00:00Z").toISOString(),
        dashboardPid: 12345,
        worktrees: [target],
      }),
    });
  });
  await page.route(
    "**/worktree-api/worktrees/*/reseed-data-dir",
    async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ ok: true, action: "reseed-data-dir" }),
      });
    },
  );

  await page.goto("/worktree-dashboard.html");
  const requestPromise = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      request
        .url()
        .endsWith(
          `/worktree-api/worktrees/${encodeURIComponent(target.id)}/reseed-data-dir`,
        ),
  );

  await page
    .getByRole("button", { name: "Re-seed data directory from main" })
    .click();

  await requestPromise;
  await expect(
    page.getByText("Re-seeded the data directory for reseed-target"),
  ).toBeVisible();
});
