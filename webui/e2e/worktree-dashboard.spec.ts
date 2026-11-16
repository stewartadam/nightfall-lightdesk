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
    "docs-user": EMPTY_SERVICE_STATE,
    "docs-dev": EMPTY_SERVICE_STATE,
  };
}

/**
 * Builds the observed process snapshot expected by the worktree dashboard UI.
 */
function observedProcesses() {
  return {
    backendPortOpen: false,
    webUiPortOpen: false,
    docsUserPortOpen: false,
    docsDevPortOpen: false,
    backendPid: null,
    webUiPid: null,
    docsUserPid: null,
    docsDevPid: null,
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
    docsUserPort: port === null ? null : port + 2,
    docsUserUrl: port === null ? null : `http://localhost:${port + 2}`,
    docsDevPort: port === null ? null : port + 3,
    docsDevUrl: port === null ? null : `http://localhost:${port + 3}`,
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
 * Verifies the Docs column stacks the user docs and developer docs mdBook
 * servers on separate lines, each with its own port and link, and that the
 * service menus target each book through the service API.
 */
test("worktree dashboard shows and manages the docs servers", async ({
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
      "docs-user": {
        ...EMPTY_SERVICE_STATE,
        pid: 4242,
        running: true,
        logPath: "/tmp/nightfall-worktree-dashboard/docs-preview-docs-user.log",
      },
      "docs-dev": {
        ...EMPTY_SERVICE_STATE,
        pid: 4343,
        running: true,
        logPath: "/tmp/nightfall-worktree-dashboard/docs-preview-docs-dev.log",
      },
    },
    observed: {
      ...base.observed,
      docsUserPortOpen: true,
      docsUserPid: 4242,
      docsDevPortOpen: true,
      docsDevPid: 4343,
    },
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
  await expect(
    page.getByRole("columnheader", { name: "Developer docs" }),
  ).toHaveCount(0);
  const row = page.locator("tbody tr", { hasText: "docs-preview" });
  const docsCell = row.locator("td").nth(3);
  const manualPort = docsCell.getByText("3082", { exact: true });
  const guidePort = docsCell.getByText("3083", { exact: true });
  await expect(manualPort).toBeVisible();
  await expect(guidePort).toBeVisible();
  const manualBox = await manualPort.boundingBox();
  const guideBox = await guidePort.boundingBox();
  expect(guideBox?.y ?? 0).toBeGreaterThan(
    (manualBox?.y ?? 0) + (manualBox?.height ?? 0),
  );
  await expect(
    docsCell.getByRole("link", { name: "Open user docs" }),
  ).toHaveAttribute("href", "http://localhost:3082");
  await expect(
    docsCell.getByRole("button", { name: "Open user docs log file" }),
  ).toBeEnabled();
  await expect(
    docsCell.getByRole("link", { name: "Open developer docs" }),
  ).toHaveAttribute("href", "http://localhost:3083");
  await expect(
    docsCell.getByRole("button", { name: "Open developer docs log file" }),
  ).toBeEnabled();

  await row.getByRole("button", { name: "Recycle..." }).click();
  await page.screenshot({
    path: test.info().outputPath("docs-recycle-menu.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "User docs", exact: true }).click();
  await expect.poll(() => actionRequests.length).toBe(1);

  await row.getByRole("button", { name: "Stop..." }).click();
  await page
    .getByRole("button", { name: "Developer docs", exact: true })
    .click();
  await expect.poll(() => actionRequests.length).toBe(2);

  expect(
    actionRequests.map((url) => [
      url.pathname.split("/").at(-1),
      url.searchParams.get("service"),
    ]),
  ).toEqual([
    ["recycle", "docs-user"],
    ["stop", "docs-dev"],
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

/** Returns the delete confirmation dialog, which `[data-modal-kind]` tags like every other delete prompt. */
function deleteConfirmation(page: import("@playwright/test").Page) {
  return page.locator('[data-modal-kind="delete-confirm"]');
}

/** Confirms the open delete dialog with its confirm button, named `label`, and waits for it to close. */
async function confirmDelete(
  page: import("@playwright/test").Page,
  label: "Delete" | "Force delete",
) {
  const dialog = deleteConfirmation(page);
  await dialog.getByRole("button", { name: label, exact: true }).click();
  await expect(dialog).toBeHidden();
}

/**
 * Verifies Delete asks first: the dialog names the worktree and its path, Cancel
 * has focus so Enter keeps the worktree, and Cancel, Escape and Enter all close it
 * without sending a request.
 */
test("worktree dashboard asks before deleting a worktree", async ({ page }) => {
  const { target, removeRequests } = await serveRemovableWorktree(page, () => ({
    status: 200,
    body: { ok: true, message: "Removed", details: [], total: 0 },
  }));
  const dialog = deleteConfirmation(page);

  await page.goto("/worktree-dashboard.html");
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("button", { name: /^Delete/ }).click();
  await expect(
    dialog.getByRole("heading", { name: "Delete feature/cleanup?" }),
  ).toBeVisible();
  await expect(dialog).toContainText(target.path);
  await expect(dialog).toContainText("is kept");
  const cancel = dialog.getByRole("button", { name: "Cancel" });
  await expect(cancel).toBeFocused();
  await page.screenshot({
    path: test.info().outputPath("delete-confirmation.png"),
  });
  await cancel.click();
  await expect(dialog).toBeHidden();

  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("button", { name: /^Delete/ }).click();
  await expect(cancel).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("button", { name: /^Delete/ }).click();
  await expect(cancel).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();

  expect(removeRequests).toEqual([]);
});

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
  await confirmDelete(page, "Delete");
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
  await confirmDelete(page, "Delete");

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

/**
 * Verifies Shift+clicking Delete asks to confirm a force delete, keeps it a force
 * delete after Shift is released, and then asks the dashboard to force the removal.
 */
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
  const dialog = deleteConfirmation(page);

  await page.goto("/worktree-dashboard.html");
  await page.getByRole("button", { name: "More actions" }).click();
  await page.keyboard.down("Shift");
  await page.getByRole("button", { name: /^Force delete/ }).click();
  await page.keyboard.up("Shift");

  await expect(
    dialog.getByRole("heading", { name: "Force delete feature/cleanup?" }),
  ).toBeVisible();
  await expect(dialog).toContainText("permanently discards");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  expect(removeRequests).toEqual([]);
  await page.screenshot({
    path: test.info().outputPath("force-delete-confirmation.png"),
  });
  await confirmDelete(page, "Force delete");

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

/**
 * Verifies the search box narrows the table to worktrees whose branch or path holds
 * every typed word, updates the header count, and explains an empty result.
 */
test("worktree dashboard filters worktrees by branch and path", async ({
  page,
}) => {
  await page.route("**/worktree-api/worktrees", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        generatedAt: new Date("2026-11-01T12:00:00Z").toISOString(),
        dashboardPid: 12345,
        worktrees: [
          worktree({ branch: "develop", envExists: true, port: 3000 }),
          worktree({
            branch: "feat/fixture-search",
            envExists: true,
            port: 3010,
          }),
          worktree({ branch: "fix/dmx-rate", envExists: false, port: null }),
        ],
      }),
    });
  });

  await page.goto("/worktree-dashboard.html");
  const search = page.getByRole("searchbox", { name: "Search worktrees" });
  const metadata = page.getByTestId("worktree-dashboard-metadata");
  await expect(metadata).toContainText("3 Worktrees");

  await search.fill("FIXTURE");
  await expect(
    page.locator("strong", { hasText: "feat/fixture-search" }),
  ).toBeVisible();
  await expect(page.locator("strong", { hasText: "develop" })).toHaveCount(0);
  await expect(page.locator("strong", { hasText: "fix/dmx-rate" })).toHaveCount(
    0,
  );
  await expect(metadata).toContainText("1 of 3 Worktrees");
  await page.screenshot({
    path: test.info().outputPath("worktree-search.png"),
  });

  // Paths match too: the uninitialized worktree's directory is fix-dmx-rate.
  await search.fill("nightfall-worktrees/fix-dmx");
  await expect(
    page.locator("strong", { hasText: "fix/dmx-rate" }),
  ).toBeVisible();
  await expect(page.getByText("Uninitialized worktrees")).toBeVisible();

  await search.fill("no-such-branch");
  await expect(
    page.getByText('No worktrees match "no-such-branch".'),
  ).toBeVisible();

  await search.press("Escape");
  await expect(metadata).toContainText("3 Worktrees");
});

/**
 * Verifies the search box doubles as the new-worktree input: a create button follows
 * the results for any typed branch that has no worktree yet, Shift+Enter in the box
 * does the same, a refusal keeps the text for correction, and a created worktree then
 * shows up in the filtered table with the button gone.
 */
test("worktree dashboard creates a worktree for the searched branch", async ({
  page,
}) => {
  const createRequests: URL[] = [];
  let created = false;
  await page.route(
    (url) => url.pathname.endsWith("/worktree-api/worktrees"),
    async (route) => {
      const request = route.request();
      if (request.method() === "POST") {
        const url = new URL(request.url());
        createRequests.push(url);
        const branch = url.searchParams.get("branch");
        created = branch === "feat/new-panel";
        await route.fulfill({
          status: created ? 200 : 409,
          contentType: "application/json",
          body: JSON.stringify(
            created
              ? {
                  ok: true,
                  action: "created",
                  message: "Created feat/new-panel",
                  branch,
                  path: "/tmp/nightfall-worktrees/feat-new-panel",
                  details: [],
                }
              : {
                  ok: false,
                  reason: "failed",
                  message: `Invalid branch name ${branch}`,
                  details: [],
                },
          ),
        });
        return;
      }
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          generatedAt: new Date(
            created ? "2026-11-01T12:00:10Z" : "2026-11-01T12:00:00Z",
          ).toISOString(),
          dashboardPid: 12345,
          worktrees: [
            worktree({ branch: "develop", envExists: true, port: 3000 }),
            ...(created
              ? [
                  worktree({
                    branch: "feat/new-panel",
                    envExists: true,
                    port: 3010,
                  }),
                ]
              : []),
          ],
        }),
      });
    },
  );

  await page.goto("/worktree-dashboard.html");
  const search = page.getByRole("searchbox", { name: "Search worktrees" });
  const create = page.getByRole("button", { name: /^Create worktree/ });
  await expect(page.locator("strong", { hasText: "develop" })).toBeVisible();
  await expect(create).toHaveCount(0);

  // A partial match still offers to create the typed branch; an exact one doesn't.
  await search.fill("dev");
  await expect(create).toHaveText("Create worktree");
  await expect(page.getByTestId("worktree-create-hint")).toHaveText(
    /in the search box creates\s*dev$/,
  );
  await search.fill("develop");
  await expect(create).toHaveCount(0);

  await search.fill("bad..name");
  await search.press("Shift+Enter");
  await expect(
    page.getByText("Failed to create bad..name: Invalid branch name bad..name"),
  ).toBeVisible();
  await expect(search).toHaveValue("bad..name");

  await search.fill("feat/new-panel");
  await expect(
    page.getByText('No worktrees match "feat/new-panel".'),
  ).toBeVisible();
  await expect(create).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("worktree-create-from-search.png"),
  });
  await create.click();
  await expect(
    page.getByText(
      "Created feat/new-panel at /tmp/nightfall-worktrees/feat-new-panel",
    ),
  ).toBeVisible();
  await expect(
    page.locator("strong", { hasText: "feat/new-panel" }),
  ).toBeVisible();
  await expect(create).toHaveCount(0);
  expect(createRequests.map((url) => url.searchParams.get("branch"))).toEqual([
    "bad..name",
    "feat/new-panel",
  ]);
  await page.waitForTimeout(600);
  await page.screenshot({
    path: test.info().outputPath("worktree-created-toast.png"),
  });
});

/**
 * Verifies the page shows snapshots pushed over the API's event stream: the initial
 * load lists one worktree, and a pushed snapshot adds another without a reload.
 */
test("worktree dashboard applies snapshots pushed over the event stream", async ({
  page,
}) => {
  const develop = worktree({ branch: "develop", envExists: true, port: 3000 });
  const pushed = worktree({
    branch: "feat/pushed",
    envExists: true,
    port: 3010,
  });
  await page.route("**/worktree-api/worktrees", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        generatedAt: new Date("2026-11-01T12:00:00Z").toISOString(),
        dashboardPid: 12345,
        worktrees: [develop],
      }),
    });
  });
  let releaseEvents = () => {};
  const eventsReleased = new Promise<void>((resolve) => {
    releaseEvents = resolve;
  });
  await page.route("**/worktree-api/events", async (route) => {
    await eventsReleased;
    const snapshot = {
      generatedAt: new Date("2026-11-01T12:00:05Z").toISOString(),
      dashboardPid: 12345,
      worktrees: [develop, pushed],
    };
    await route.fulfill({
      contentType: "text/event-stream",
      // A long retry keeps EventSource from reconnecting once this body ends.
      body: `retry: 600000\n\nevent: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`,
    });
  });

  await page.goto("/worktree-dashboard.html");
  await expect(page.locator("strong", { hasText: "develop" })).toBeVisible();
  await expect(page.locator("strong", { hasText: "feat/pushed" })).toHaveCount(
    0,
  );

  releaseEvents();
  await expect(
    page.locator("strong", { hasText: "feat/pushed" }),
  ).toBeVisible();
  await expect(page.getByTestId("worktree-dashboard-metadata")).toContainText(
    "2 Worktrees",
  );
});
