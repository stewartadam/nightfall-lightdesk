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
    docs: EMPTY_SERVICE_STATE,
  };
}

/**
 * Builds the observed process snapshot expected by the worktree dashboard UI.
 */
function observedProcesses() {
  return {
    backendPortOpen: false,
    webUiPortOpen: false,
    docsPortOpen: false,
    backendPid: null,
    webUiPid: null,
    docsPid: null,
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
    docsPort: port === null ? null : port + 2,
    docsUrl: port === null ? null : `http://localhost:${port + 2}`,
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

/**
 * Verifies the Docs column shows a running mdBook server with its port and
 * link, and that Recycle and Stop can target it through the service API.
 */
test("worktree dashboard shows and manages the docs server", async ({
  page,
}) => {
  const base = worktree({
    branch: "docs-preview",
    envExists: true,
    port: 3080,
  });
  const target = {
    ...base,
    managed: {
      ...base.managed,
      docs: {
        ...EMPTY_SERVICE_STATE,
        pid: 4242,
        running: true,
        logPath: "/tmp/nightfall-worktree-dashboard/docs-preview-docs.log",
      },
    },
    observed: { ...base.observed, docsPortOpen: true, docsPid: 4242 },
  };

  await page.route("**/worktree-api/worktrees", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        generatedAt: new Date("2026-10-23T12:00:00Z").toISOString(),
        dashboardPid: 12345,
        worktrees: [target],
      }),
    });
  });
  const actionRequests: URL[] = [];
  await page.route(
    /\/worktree-api\/worktrees\/[^/]+\/(recycle|stop)\?/u,
    async (route) => {
      const url = new URL(route.request().url());
      actionRequests.push(url);
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ ok: true, result: [{ ok: true }] }),
      });
    },
  );

  await page.goto("/worktree-dashboard.html");

  await expect(page.getByRole("columnheader", { name: "Docs" })).toBeVisible();
  const row = page.locator("tbody tr", { hasText: "docs-preview" });
  await expect(row.getByText("3082", { exact: true })).toBeVisible();
  await expect(row.getByRole("link", { name: "Open docs" })).toHaveAttribute(
    "href",
    "http://localhost:3082",
  );
  await expect(
    row.getByRole("button", { name: "Open docs log file" }),
  ).toBeEnabled();

  await row.getByRole("button", { name: "Recycle..." }).click();
  await page.screenshot({
    path: test.info().outputPath("docs-recycle-menu.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Docs", exact: true }).click();
  await expect.poll(() => actionRequests.length).toBe(1);

  await row.getByRole("button", { name: "Stop..." }).click();
  await page.getByRole("button", { name: "Docs", exact: true }).click();
  await expect.poll(() => actionRequests.length).toBe(2);

  expect(
    actionRequests.map((url) => [
      url.pathname.split("/").at(-1),
      url.searchParams.get("service"),
    ]),
  ).toEqual([
    ["recycle", "docs"],
    ["stop", "docs"],
  ]);
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

  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("button", { name: "Re-seed data from main" }).click();

  await requestPromise;
  await expect(
    page.getByText("Re-seeded the data directory for reseed-target"),
  ).toBeVisible();
});

/**
 * Serves one secondary worktree to the dashboard and answers its remove route
 * with `respond`, returning the worktree and the remove URLs requested.
 */
async function serveRemovableWorktree(
  page: import("@playwright/test").Page,
  respond: (url: URL) => { status: number; body: unknown },
) {
  const target = {
    ...worktree({ branch: "feature/cleanup", envExists: true, port: 3080 }),
    canRemove: true,
  };
  const removeRequests: URL[] = [];
  await page.route("**/worktree-api/worktrees", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        generatedAt: new Date("2026-10-23T12:00:00Z").toISOString(),
        dashboardPid: 12345,
        worktrees: [target],
      }),
    });
  });
  await page.route("**/worktree-api/worktrees/*/remove*", async (route) => {
    const url = new URL(route.request().url());
    removeRequests.push(url);
    const { status, body } = respond(url);
    await route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
  return { target, removeRequests };
}

/** Verifies the overflow menu groups the secondary actions and a refused delete explains why. */
test("worktree dashboard explains why a worktree with local changes was kept", async ({
  page,
}) => {
  const { removeRequests } = await serveRemovableWorktree(page, () => ({
    status: 409,
    body: {
      ok: false,
      reason: "local-changes",
      message: "2 uncommitted changes",
      details: ["webui/app.tsx", "notes.md"],
      total: 2,
      action: "remove",
    },
  }));

  await page.goto("/worktree-dashboard.html");
  await page.getByRole("button", { name: "More actions" }).click();
  const menu = page.getByRole("menu", { name: "Actions for feature/cleanup" });
  await expect(
    menu.getByRole("button", { name: "Re-seed data from main" }),
  ).toBeVisible();
  await expect(
    menu.getByRole("button", { name: "Open in VS Code" }),
  ).toBeVisible();
  await expect(menu.getByRole("button", { name: /^Delete/ })).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("overflow-menu.png"),
  });

  await page.keyboard.down("Shift");
  await expect(
    menu.getByRole("button", { name: /^Force delete/ }),
  ).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("overflow-menu-shift.png"),
  });
  await page.keyboard.up("Shift");

  await menu.getByRole("button", { name: /^Delete/ }).click();
  await expect(
    page.getByText(
      "feature/cleanup has 2 uncommitted changes (webui/app.tsx, notes.md). Hold Shift and choose Force delete to remove it anyway.",
    ),
  ).toBeVisible();
  expect(removeRequests[0]?.searchParams.get("force")).toBeNull();
  // Let the toast finish sliding in so the capture shows all of it.
  await page.waitForTimeout(600);
  await page.screenshot({
    path: test.info().outputPath("local-changes-toast.png"),
  });
});

/** Verifies an unmerged branch is reported with its commit count and reason. */
test("worktree dashboard explains why an unmerged worktree was kept", async ({
  page,
}) => {
  await serveRemovableWorktree(page, () => ({
    status: 409,
    body: {
      ok: false,
      reason: "unmerged",
      message: "no merged PR found",
      details: Array.from(
        { length: 10 },
        (_, i) => `abc12${i}0 feat: ${i}`,
      ).concat("…and 2 more"),
      total: 12,
      action: "remove",
    },
  }));

  await page.goto("/worktree-dashboard.html");
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("button", { name: /^Delete/ }).click();

  await expect(
    page.getByText(
      "feature/cleanup has 12 unmerged commits (no merged PR found). Hold Shift and choose Force delete to remove it anyway.",
    ),
  ).toBeVisible();
  await page.waitForTimeout(600);
  await page.screenshot({
    path: test.info().outputPath("unmerged-toast.png"),
  });
});

/** Verifies Shift+clicking Delete asks the dashboard to force the removal. */
test("worktree dashboard force deletes with Shift held", async ({ page }) => {
  const { removeRequests } = await serveRemovableWorktree(page, () => ({
    status: 200,
    body: {
      ok: true,
      message: "Removed feature/cleanup",
      details: [],
      total: 0,
    },
  }));

  await page.goto("/worktree-dashboard.html");
  await page.getByRole("button", { name: "More actions" }).click();
  await page.keyboard.down("Shift");
  await page.getByRole("button", { name: /^Force delete/ }).click();
  await page.keyboard.up("Shift");

  await expect(page.getByText("Deleted feature/cleanup")).toBeVisible();
  expect(removeRequests[0]?.searchParams.get("force")).toBe("1");
});

/** Verifies the primary worktree's Delete item is disabled. */
test("worktree dashboard cannot delete the primary worktree", async ({
  page,
}) => {
  await page.route("**/worktree-api/worktrees", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        generatedAt: new Date("2026-10-23T12:00:00Z").toISOString(),
        dashboardPid: 12345,
        worktrees: [
          {
            ...worktree({ branch: "develop", envExists: true, port: 3030 }),
            canRemove: false,
          },
        ],
      }),
    });
  });

  await page.goto("/worktree-dashboard.html");
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(page.getByRole("button", { name: /^Delete/ })).toBeDisabled();
});
