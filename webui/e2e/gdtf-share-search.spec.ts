// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page, Route } from "@playwright/test";
import type { GdtfShareFixture } from "../types";
import { libraryAssetEtag, testGdtfArchive } from "./gdtf-archive";
import { expect, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

const PATCH_PANEL_ID = "panel-PatchEditor-gdtf-share-e2e";
const LIBRARY_PANEL_ID = "panel-FixtureLibrary-gdtf-share-e2e";

/** The GDTF Share fixture the wizard test installs. */
const WASH: GdtfShareFixture = {
  rid: 101,
  fixture_type_id: "e2e00000-0000-4000-8000-000000000001",
  manufacturer: "Nightfall Test",
  fixture: "E2E Wash",
  revision: "Release 1.0",
  modes: [{ name: "Standard", footprint: 1 }],
  rating: 4.5,
  manufacturer_upload: true,
  last_modified: 1_761_000_000,
  file_size: 2048,
};

/** Fixtures the stand-in GDTF Share lists. */
const LISTED: GdtfShareFixture[] = [
  WASH,
  {
    ...WASH,
    rid: 102,
    fixture_type_id: "e2e00000-0000-4000-8000-000000000002",
    fixture: "E2E Spot",
    modes: [
      { name: "Basic", footprint: 8 },
      { name: "Extended", footprint: 16 },
    ],
    rating: undefined,
    manufacturer_upload: false,
  },
  {
    ...WASH,
    rid: 103,
    fixture_type_id: "e2e00000-0000-4000-8000-000000000003",
    manufacturer: "Other Lighting",
    fixture: "Wash Bar",
    rating: 3,
    manufacturer_upload: false,
  },
];

/**
 * Answers the engine's GDTF Share routes so the test never contacts GDTF Share: the account
 * is `user` (or signed out), searches match every word against make and model, and installs
 * write a generated archive into the backend's real fixture library folder, then stream
 * progress and the outcome as the engine does. An install waits for `installGate` first,
 * so the test can see the download under way.
 */
async function standInForGdtfShare(
  page: Page,
  options: {
    user: string | null;
    libraryDir: string;
    installGate?: Promise<void>;
  },
) {
  const installs: number[] = [];
  await page.route("**/api/gdtf-share/account", (route) =>
    route.fulfill({
      json: {
        user: options.user,
        source: options.user ? "keychain" : null,
        keychain_available: true,
      },
    }),
  );
  await page.route(
    (url) => url.pathname === "/api/gdtf-share/fixtures",
    (route: Route) => {
      if (!options.user) {
        return route.fulfill({
          status: 428,
          body: "Sign in to GDTF Share in Settings first.",
        });
      }
      const url = new URL(route.request().url());
      const words = (url.searchParams.get("query") ?? "")
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean);
      const matches = LISTED.filter((fixture) =>
        words.every((word) =>
          `${fixture.manufacturer} ${fixture.fixture}`
            .toLowerCase()
            .includes(word),
        ),
      );
      return route.fulfill({
        json: {
          fixtures: matches,
          total: matches.length,
          fetched_at: 1_761_000_000,
        },
      });
    },
  );
  await page.route(
    (url) => /^\/api\/gdtf-share\/fixtures\/\d+\/install$/.test(url.pathname),
    async (route) => {
      const rid = Number(
        new URL(route.request().url()).pathname.split("/").at(-2),
      );
      const fixture = LISTED.find((candidate) => candidate.rid === rid);
      if (!fixture) return route.fulfill({ status: 404, body: "Not listed" });
      installs.push(rid);
      await options.installGate;
      const fileName = `Nightfall_Test@${fixture.fixture.replace(/ /g, "_")}@1.0@${rid}.gdtf`;
      const archive = testGdtfArchive({
        manufacturer: fixture.manufacturer,
        model: fixture.fixture,
        fixtureTypeId: fixture.fixture_type_id ?? "",
      });
      await mkdir(options.libraryDir, { recursive: true });
      await writeFile(join(options.libraryDir, fileName), archive);
      const total = archive.length;
      const events = [
        { type: "Progress", data: { received: total >> 1, total } },
        { type: "Progress", data: { received: total, total } },
        {
          type: "Installed",
          data: {
            file_name: fileName,
            fixture_type_id: fixture.fixture_type_id,
            asset_etag: libraryAssetEtag(archive),
          },
        },
      ];
      return route.fulfill({
        contentType: "application/x-ndjson",
        body: events.map((event) => `${JSON.stringify(event)}\n`).join(""),
      });
    },
  );
  return installs;
}

/** Opens the app against the test backend and waits for the workspace. */
async function openApp(page: Page) {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/?e2e=1");
  await waitForDockviewApp(page);
}

/** Adds and focuses one Dockview panel of `component`. */
async function addPanel(
  page: Page,
  id: string,
  component: string,
  title: string,
) {
  await page.evaluate(
    ({ panelId, panelComponent, panelTitle }) => {
      const api = (window as any).appStores.dockApi.get();
      api.getPanel(panelId)?.api.close();
      const reference = api.panels.find(
        (candidate: any) => candidate.api.location.type === "grid",
      );
      const panel = api.addPanel({
        id: panelId,
        component: panelComponent,
        title: panelTitle,
        params: { initialPanelId: panelId },
        ...(reference
          ? { position: { referencePanel: reference.id, direction: "within" } }
          : {}),
      });
      panel.api.setActive();
      panel.focus();
    },
    { panelId: id, panelComponent: component, panelTitle: title },
  );
  const panel = page.locator(
    `[data-component="${component}"][data-panel-id="${id}"]`,
  );
  await expect(panel).toBeVisible();
  return panel;
}

/**
 * Searches GDTF Share from the patch wizard after the library has no match, installs a
 * fixture while its download shows progress, and lands back in the library with it selected
 * and previewed. The same words then find it on both tabs, and installing an identical
 * revision again selects the library copy instead of adding another.
 */
test("installs a GDTF Share fixture from the patch wizard", async ({
  page,
  backendSlot,
}, testInfo) => {
  test.setTimeout(180_000);
  let releaseInstall = () => {};
  const installGate = new Promise<void>((resolve) => {
    releaseInstall = resolve;
  });
  const installs = await standInForGdtfShare(page, {
    user: "lighting@example.com",
    libraryDir: join(backendSlot.dataDir, "fixtures"),
    installGate,
  });
  await openApp(page);
  const patch = await addPanel(page, PATCH_PANEL_ID, "PatchEditor", "Patch");
  await patch.getByRole("button", { name: "Add fixture", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Patch Wizard" });
  await expect(dialog).toBeVisible();

  await dialog.getByLabel("Filter fixtures").fill("e2e wash");
  await expect(dialog.getByText("No fixtures match your search")).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("01-no-library-match.png"),
  });

  await dialog.getByTestId("patch-wizard-search-online").click();
  const browser = dialog.getByTestId("gdtf-share-browser");
  await expect(browser.getByLabel("Search GDTF Share")).toHaveValue("e2e wash");
  const washRow = browser.getByRole("row").filter({ hasText: "E2E Wash" });
  await expect(washRow).toBeVisible();
  await expect(
    browser.getByRole("row").filter({ hasText: "E2E Spot" }),
  ).toHaveCount(0);

  await browser.getByLabel("Search GDTF Share").fill("e2e");
  await expect(
    browser.getByRole("row").filter({ hasText: "E2E Spot" }),
  ).toBeVisible();
  await expect(browser.getByTestId("gdtf-share-count")).toContainText(
    "2 fixtures",
  );
  await expect(browser.getByRole("button", { name: "Show more" })).toHaveCount(
    0,
  );
  await washRow.click();
  const selected = browser.getByTestId("gdtf-share-selected");
  await expect(selected).toContainText("Nightfall Test E2E Wash");
  await expect(selected).toContainText("Uploaded by the manufacturer");
  await expect(selected).toContainText("Standard (1 ch)");
  await page.screenshot({
    path: testInfo.outputPath("02-gdtf-share-results.png"),
  });

  await selected.getByTestId("gdtf-share-install").click();
  await expect(
    selected.getByTestId("gdtf-share-download-progress"),
  ).toBeVisible();
  await expect(selected.getByTestId("gdtf-share-install")).toHaveText(
    "Installing…",
  );
  await page.screenshot({
    path: testInfo.outputPath("02b-downloading.png"),
  });
  releaseInstall();
  await expect(dialog.getByLabel("Filter fixtures")).toHaveValue("E2E Wash", {
    timeout: 20_000,
  });
  expect(installs).toEqual([101]);
  await expect(
    dialog.getByRole("region", { name: "Fixture preview" }).locator("canvas"),
  ).toBeVisible({ timeout: 30_000 });
  await expect(dialog.getByText("1 mode available")).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("03-installed-and-selected.png"),
  });

  await dialog
    .getByTestId("patch-wizard-fixture-source")
    .getByRole("radio", { name: "GDTF Share" })
    .click();
  await expect(
    browser.getByRole("row").filter({ hasText: "E2E Wash" }),
  ).toContainText("In library");
  await page.screenshot({
    path: testInfo.outputPath("04-marked-in-library.png"),
  });

  await browser.getByLabel("Search GDTF Share").fill("nightfall wash");
  await expect(
    browser.getByRole("row").filter({ hasText: "E2E Wash" }),
  ).toBeVisible();
  await browser.getByRole("row").filter({ hasText: "E2E Wash" }).click();
  await selected.getByTestId("gdtf-share-install").click();
  await expect(dialog.getByLabel("Filter fixtures")).toHaveValue("E2E Wash", {
    timeout: 20_000,
  });
  expect(installs).toEqual([101, 101]);
  await expect(
    dialog
      .getByRole("grid", { name: "Available fixtures" })
      .locator('[data-grid-row][data-selected="true"]'),
  ).toContainText("E2E Wash");

  await dialog.getByLabel("Filter fixtures").fill("nightfall wash");
  await expect(
    dialog
      .getByRole("grid", { name: "Available fixtures" })
      .getByRole("row")
      .filter({ hasText: "E2E Wash" }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("05-same-words-in-library.png"),
  });
});

/**
 * Without an account the Fixture Library's GDTF Share view explains why, and its button opens
 * Settings on the GDTF Share sign-in.
 */
test("points to Settings when GDTF Share is signed out", async ({
  page,
  backendSlot,
}, testInfo) => {
  await standInForGdtfShare(page, {
    user: null,
    libraryDir: join(backendSlot.dataDir, "fixtures"),
  });
  await openApp(page);
  const library = await addPanel(
    page,
    LIBRARY_PANEL_ID,
    "FixtureLibrary",
    "Fixture Library",
  );
  await library.getByTestId("fixture-library-search-online").click();
  await expect(library.getByText("Sign in to GDTF Share")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("06-signed-out.png") });

  await library.getByTestId("gdtf-share-open-settings").click();
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(
    settings.getByRole("region", { name: "GDTF Share" }),
  ).toBeVisible();
  await expect(settings.getByTestId("gdtf-share-user")).toBeFocused();
  await page.screenshot({
    path: testInfo.outputPath("07-settings-sign-in.png"),
  });
});
