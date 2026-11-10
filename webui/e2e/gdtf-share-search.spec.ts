// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { existsSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page, Route } from "@playwright/test";
import type { GdtfShareFixture } from "../types";
import { libraryAssetEtag, testGdtfArchive } from "./gdtf-archive";
import { expect, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

const PATCH_PANEL_ID = "panel-PatchEditor-gdtf-share-e2e";
const LIBRARY_PANEL_ID = "panel-FixtureLibrary-gdtf-share-e2e";
const PROPERTIES_PANEL_ID = "panel-PropertiesInspector";

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

/** A listed fixture whose download is not a GDTF archive, so the library can't load it. */
const BROKEN: GdtfShareFixture = {
  ...WASH,
  rid: 104,
  fixture_type_id: "e2e00000-0000-4000-8000-000000000004",
  manufacturer: "Other Lighting",
  fixture: "Faulty Spot",
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
  BROKEN,
];

/**
 * Answers the engine's GDTF Share routes so the test never contacts GDTF Share: the account
 * is `user` (or signed out), searches match every word against make and model, and installs
 * write a generated archive into the backend's real fixture library folder (atomically, as
 * the engine does), then stream
 * progress and the outcome as the engine does. {@link BROKEN} downloads as bytes that are not
 * an archive. An install waits for `installGate` first, so the test can see the download
 * under way.
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
      const archive =
        rid === BROKEN.rid
          ? Buffer.from("this is not a GDTF archive")
          : testGdtfArchive({
              manufacturer: fixture.manufacturer,
              model: fixture.fixture,
              fixtureTypeId: fixture.fixture_type_id ?? "",
            });
      await mkdir(options.libraryDir, { recursive: true });
      // Written under a hidden name first, as the engine does, so no rescan sees half a file.
      const partial = join(options.libraryDir, `.${fileName}.partial`);
      await writeFile(partial, archive);
      await rename(partial, join(options.libraryDir, fileName));
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

/**
 * Adds and focuses one Dockview panel of `component`, as a tab beside the first grid panel
 * unless `direction` places it to one side of that panel.
 */
async function addPanel(
  page: Page,
  id: string,
  component: string,
  title: string,
  direction: "within" | "right" = "within",
) {
  await page.evaluate(
    ({ panelId, panelComponent, panelTitle, panelDirection }) => {
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
          ? {
              position: {
                referencePanel: reference.id,
                direction: panelDirection,
              },
            }
          : {}),
      });
      panel.api.setActive();
      panel.focus();
    },
    {
      panelId: id,
      panelComponent: component,
      panelTitle: title,
      panelDirection: direction,
    },
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

/**
 * Installing a download the library can't read names the parser's error, and the Fixture
 * Library then lists the file greyed out, with the same error in Properties, until the user
 * deletes it from there.
 */
test("shows why an installed fixture can't be read", async ({
  page,
  backendSlot,
}, testInfo) => {
  test.setTimeout(120_000);
  await standInForGdtfShare(page, {
    user: "lighting@example.com",
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
  const browser = library.getByTestId("gdtf-share-browser");
  await browser.getByLabel("Search GDTF Share").fill("faulty");
  await browser.getByRole("row").filter({ hasText: "Faulty Spot" }).click();
  const selected = browser.getByTestId("gdtf-share-selected");
  await selected.getByTestId("gdtf-share-install").click();
  const note = selected.getByTestId("gdtf-share-install-note");
  await expect(note).toContainText(
    "Installed as Nightfall_Test@Faulty_Spot@1.0@104.gdtf, but Nightfall can't read it:",
    { timeout: 20_000 },
  );
  await page.screenshot({
    path: testInfo.outputPath("08-install-parse-error.png"),
  });

  await library.getByTestId("fixture-library-search-online").click();
  const brokenRow = library
    .getByRole("row")
    .filter({ hasText: "Nightfall_Test@Faulty_Spot@1.0@104.gdtf" });
  await expect(brokenRow).toContainText("Failed to load");
  await addPanel(
    page,
    PROPERTIES_PANEL_ID,
    "PropertiesInspector",
    "Properties",
    "right",
  );
  await page.evaluate((panelId) => {
    (window as any).appStores.dockApi.get().getPanel(panelId)?.focus();
  }, LIBRARY_PANEL_ID);
  await brokenRow.click();
  const details = page.getByTestId("fixture-library-unloadable");
  await expect(details).toContainText("Failed to load");
  await expect(details).toContainText(
    "Nightfall_Test@Faulty_Spot@1.0@104.gdtf",
  );
  await expect(details).toContainText("Parser error");
  await page.screenshot({
    path: testInfo.outputPath("09-library-shows-parse-error.png"),
  });

  await library.getByRole("button", { name: "Delete selected (1)" }).click();
  await expect(brokenRow).toHaveCount(0);
  await expect(details).toHaveCount(0);
  expect(
    existsSync(
      join(
        backendSlot.dataDir,
        "fixtures",
        "Nightfall_Test@Faulty_Spot@1.0@104.gdtf",
      ),
    ),
  ).toBe(false);
});

/** A newer manufacturer revision of {@link WASH}, which the update test offers. */
const WASH_UPDATE: GdtfShareFixture = {
  ...WASH,
  rid: 105,
  revision: "Release 2.0",
  last_modified: WASH.last_modified + 86_400,
};

/** Library file name the engine gives an install of `fixture`. */
function installFileName(fixture: GdtfShareFixture): string {
  return `Nightfall_Test@${fixture.fixture.replace(/ /g, "_")}@${fixture.revision.replace(/ /g, "_")}@${fixture.rid}.gdtf`;
}

/** Generated archive of `fixture`, carrying its revision text as the engine reads it. */
function revisionArchive(fixture: GdtfShareFixture): Buffer {
  return testGdtfArchive({
    manufacturer: fixture.manufacturer,
    model: fixture.fixture,
    fixtureTypeId: fixture.fixture_type_id ?? "",
    revision: fixture.revision,
  });
}

/**
 * Generated archive of {@link WASH_UPDATE}: its notes list the installed revision and one
 * fix after it, and its dimmer is 16-bit, so the update grows each fixture by a channel.
 */
function updateArchive(): Buffer {
  return testGdtfArchive({
    manufacturer: WASH_UPDATE.manufacturer,
    model: WASH_UPDATE.fixture,
    fixtureTypeId: WASH_UPDATE.fixture_type_id ?? "",
    history: [WASH.revision, "Fixed the beam angle"],
    revision: WASH_UPDATE.revision,
    wideDimmer: true,
  });
}

/** Library fingerprints of the installed {@link WASH} file and its update. */
interface WashUpdate {
  installedEtag: string;
  updateEtag: string;
  /** Every library file the panel asked the update check about. */
  checked: unknown[];
}

/**
 * Installs {@link WASH} into the library and stands in for GDTF Share: the update check
 * offers {@link WASH_UPDATE} for it (pointing at the library copy once one exists), and
 * installing the update writes {@link updateArchive} the way the engine would.
 */
async function standInForWashUpdate(
  page: Page,
  dataDir: string,
): Promise<WashUpdate> {
  const libraryDir = join(dataDir, "fixtures");
  await mkdir(libraryDir, { recursive: true });
  const installedArchive = revisionArchive(WASH);
  await writeFile(join(libraryDir, installFileName(WASH)), installedArchive);
  const installedEtag = libraryAssetEtag(installedArchive);
  const update = updateArchive();
  const updateEtag = libraryAssetEtag(update);

  await standInForGdtfShare(page, { user: "lighting@example.com", libraryDir });
  const checked: unknown[] = [];
  await page.route("**/api/gdtf-share/updates", (route) => {
    const body = route.request().postDataJSON() as {
      fixtures: { asset_etag: string; revision?: string }[];
    };
    checked.push(...body.fixtures);
    const hasOld = body.fixtures.some((f) => f.asset_etag === installedEtag);
    const hasNew = body.fixtures.some((f) => f.asset_etag === updateEtag);
    return route.fulfill({
      json: {
        updates: hasOld
          ? [
              {
                asset_etag: installedEtag,
                installed: WASH,
                latest: WASH_UPDATE,
                library_copy: hasNew ? updateEtag : undefined,
              },
            ]
          : [],
      },
    });
  });
  await page.route(
    (url) =>
      url.pathname === `/api/gdtf-share/fixtures/${WASH_UPDATE.rid}/install`,
    async (route) => {
      const partial = join(libraryDir, ".update.partial");
      await writeFile(partial, update);
      await rename(partial, join(libraryDir, installFileName(WASH_UPDATE)));
      return route.fulfill({
        contentType: "application/x-ndjson",
        body: `${JSON.stringify({
          type: "Installed",
          data: {
            file_name: installFileName(WASH_UPDATE),
            fixture_type_id: WASH_UPDATE.fixture_type_id,
            asset_etag: updateEtag,
          },
        })}\n`,
      });
    },
  );
  return { installedEtag, updateEtag, checked };
}

/**
 * Opens the app with only the Fixture Library and Properties panels, so both have room
 * for the screenshots, and returns the library panel.
 */
async function openLibraryWithProperties(page: Page): Promise<Locator> {
  await openApp(page);
  const library = await addPanel(
    page,
    LIBRARY_PANEL_ID,
    "FixtureLibrary",
    "Fixture Library",
  );
  await addPanel(
    page,
    PROPERTIES_PANEL_ID,
    "PropertiesInspector",
    "Properties",
    "right",
  );
  // Leaves only the library and Properties open, so both have room for the screenshots.
  await page.evaluate(
    (keep) => {
      const api = (window as any).appStores.dockApi.get();
      for (const panel of [...api.panels]) {
        if (!keep.includes(panel.id)) panel.api.close();
      }
      api.getPanel(keep[0])?.focus();
    },
    [LIBRARY_PANEL_ID, PROPERTIES_PANEL_ID],
  );
  return library;
}

/** Patches fixtures 9101 to 9103 from library revision `assetEtag` of the wash. */
async function patchThreeWashes(page: Page, assetEtag: string): Promise<void> {
  const created = await page.evaluate(
    (assetEtag) =>
      (window as any).appStores.sendAndAwait({
        module: "FixtureLibraryCommand",
        command: {
          type: "CreateFixturesFromLibrary",
          data: {
            make: "Nightfall Test",
            model: "E2E Wash",
            mode: "Standard",
            asset_etag: assetEtag,
            fixtures: [{ id: 9101 }, { id: 9102 }, { id: 9103 }],
          },
        },
      }),
    assetEtag,
  );
  expect(created.outcome.type).toBe("Succeeded");
}

/**
 * The Fixture Library flags a GDTF file with a newer GDTF Share revision, and Properties
 * names both revisions with one Update… button. With nothing patched, its dialog only adds
 * the update to the library next to the old file and selects it. The old file then points
 * at the library copy instead of offering another download. The update check is answered
 * by a stand-in that records what the panel sent, so the test also shows the library
 * reports each file's fixture type and revision text.
 */
test("offers newer GDTF Share revisions of library fixtures", async ({
  page,
  backendSlot,
}, testInfo) => {
  test.setTimeout(180_000);
  const { installedEtag, checked } = await standInForWashUpdate(
    page,
    backendSlot.dataDir,
  );
  const library = await openLibraryWithProperties(page);
  const rows = library.getByRole("row").filter({ hasText: "E2E Wash" });
  await expect(rows).toHaveCount(1, { timeout: 30_000 });
  await expect(rows.first()).toContainText("Update available", {
    timeout: 20_000,
  });
  expect(checked).toContainEqual({
    asset_etag: installedEtag,
    fixture_type_id: WASH.fixture_type_id,
    revision: "Release 1.0",
  });
  await page.screenshot({
    path: testInfo.outputPath("10-update-available.png"),
  });

  await rows.first().click();
  const details = page.getByTestId("gdtf-share-update");
  await expect(details).toContainText("Release 2.0 is available");
  await expect(details).toContainText("this file is Release 1.0");
  await expect(details.getByTestId("gdtf-share-update-link")).toHaveAttribute(
    "href",
    "https://gdtf-share.com/share.php?page=home&manu=Nightfall%20Test&fix=E2E%20Wash&rev=105",
  );
  await expect(details.getByRole("button")).toHaveText(["Update…"]);
  await page.screenshot({
    path: testInfo.outputPath("11-update-properties.png"),
  });

  await details.getByTestId("gdtf-share-update-action").click();
  const dialog = page.getByRole("dialog", { name: "Update E2E Wash" });
  await expect(dialog).toContainText("No patched fixtures use this file.");
  await page.screenshot({
    path: testInfo.outputPath("12-add-to-library.png"),
  });
  await dialog.getByTestId("revision-update-confirm").click();
  await expect(dialog).toHaveCount(0, { timeout: 20_000 });
  await expect(rows).toHaveCount(2, { timeout: 20_000 });
  await expect(details).toHaveCount(0);
  const oldRow = library
    .getByRole("row")
    .filter({ hasText: "Newer copy in library" });
  await expect(oldRow).toHaveCount(1, { timeout: 20_000 });

  await oldRow.click();
  await expect(details.getByTestId("gdtf-share-update-action")).toHaveText(
    "Show update",
  );
  await page.screenshot({
    path: testInfo.outputPath("13-library-copy.png"),
  });
});

/** Reads the library revision recorded on each of the patched washes 9101 to 9103. */
function washRevisions(page: Page): Promise<(string | undefined)[]> {
  return page.evaluate(() => {
    const fixtures = Object.values(
      (window as any).appStores.fixtures.get(),
    ) as { identifiers: { id: number }; library_asset_etag?: string }[];
    return [9101, 9102, 9103].map(
      (id) =>
        fixtures.find((fixture) => fixture.identifiers.id === id)
          ?.library_asset_etag,
    );
  });
}

/**
 * With patched fixtures, Update… opens a dialog that downloads the GDTF Share update, then
 * shows the notes written since the installed revision, the new mode each current mode
 * becomes with its channel growth, and saving the show first. Confirming moves every
 * fixture to the new revision in one engine change, closes the dialog and selects the new
 * revision, and one undo moves them all back.
 */
test("installs a GDTF Share update and moves patched fixtures to it", async ({
  page,
  backendSlot,
}, testInfo) => {
  test.setTimeout(180_000);
  const { installedEtag, updateEtag } = await standInForWashUpdate(
    page,
    backendSlot.dataDir,
  );
  const library = await openLibraryWithProperties(page);
  const rows = library.getByRole("row").filter({ hasText: "E2E Wash" });
  await expect(rows.first()).toContainText("Update available", {
    timeout: 30_000,
  });
  await patchThreeWashes(page, installedEtag);
  await expect(
    rows.first().getByRole("gridcell", { name: "3", exact: true }),
  ).toBeVisible();
  await rows.first().click();
  await expect(page.getByTestId("fixture-library-patched-count")).toHaveText(
    "Patched: 3 fixtures",
  );
  const details = page.getByTestId("gdtf-share-update");
  await expect(details.getByRole("button")).toHaveText(["Update…"]);
  await page.screenshot({
    path: testInfo.outputPath("14-update-offered.png"),
  });

  await details.getByTestId("gdtf-share-update-action").click();
  const dialog = page.getByRole("dialog", { name: "Update E2E Wash" });
  const changes = dialog.getByTestId("revision-update-changes");
  await expect(changes).toContainText("Fixed the beam angle", {
    timeout: 20_000,
  });
  await expect(changes).toContainText("Release 2.0");
  await expect(changes).not.toContainText("Release 1.0");
  const modes = dialog.getByTestId("revision-update-modes");
  await expect(modes).toContainText("Move 3 fixtures to");
  await expect(modes).toContainText("Standard · 3 fixtures");
  await expect(dialog.getByTestId("revision-update-mode")).toHaveValue(
    "Standard",
  );
  await expect(modes).toContainText("Uses 1 channel more");
  await expect(dialog.getByTestId("revision-update-save-first")).toBeChecked();
  await expect(dialog.getByTestId("revision-update-confirm")).toHaveText(
    "Update 3 fixtures",
  );
  await page.screenshot({
    path: testInfo.outputPath("15-update-dialog.png"),
  });

  await dialog.getByTestId("revision-update-confirm").click();
  await expect(dialog).toHaveCount(0, { timeout: 20_000 });
  await expect
    .poll(() => washRevisions(page))
    .toEqual(Array(3).fill(updateEtag));
  await expect(rows).toHaveCount(2);
  await expect(page.getByTestId("fixture-library-patched-count")).toHaveText(
    "Patched: 3 fixtures",
  );
  await expect(details).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("16-fixtures-updated.png"),
  });

  const undone = await page.evaluate(() =>
    (window as any).appStores.sendAndAwait({
      module: "UndoCommand",
      command: { type: "Undo", data: {} },
    }),
  );
  expect(undone.outcome.type).toBe("Succeeded");
  await expect
    .poll(() => washRevisions(page))
    .toEqual(Array(3).fill(installedEtag));
  await expect(page.getByTestId("fixture-library-patched-count")).toHaveText(
    "Patched: 0 fixtures",
  );
});
