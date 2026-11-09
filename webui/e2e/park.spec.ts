// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import { openPanel } from "./controller-mapping";
import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

const inputSelector = "#header-cmdline";
const ownedFixtureId = 312;

test.setTimeout(90_000);

/** Submits a command-line command and waits for its backend result to succeed. */
async function submitCommand(page: Page, command: string): Promise<void> {
  const input = page.locator(inputSelector);
  await input.fill(command);
  await input.press("Enter");
  await expect(input).toHaveValue("");
  await expect
    .poll(() =>
      page.evaluate((submittedCommand) => {
        const entries =
          (window as any).appStores?.consoleScrollback?.get?.() ?? [];
        const matches = entries.filter(
          (entry: any) => entry.command === submittedCommand,
        );
        return matches[matches.length - 1]?.status ?? null;
      }, command),
    )
    .toBe("success");
}

/** Returns how many parameters the engine reports as parked. */
function parkedCount(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as any).appStores.parkedParameters.get().length as number,
  );
}

/** Opens a blank backend show and patches the RGBW moving head the scenario parks. */
async function openShowWithOwnedFixture(
  page: Page,
  backendPort: number,
): Promise<void> {
  await prepareFreshBackendShowfile(backendPort);
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("nightfall.currentShowfileName", "default");
  });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  const result = await page.evaluate(async (fixtureId) => {
    return (window as any).appStores.sendAndAwait({
      module: "FixtureLibraryCommand",
      command: {
        type: "CreateFixtureFromLibrary",
        data: {
          id: fixtureId,
          make: "Generic",
          model: "Moving Head RGBW",
          mode: "Spot",
          label: "Parked mover",
          update_existing_ids: [],
          update_existing_only: false,
        },
      },
    });
  }, ownedFixtureId);
  expect(result.outcome.type, JSON.stringify(result)).toBe("Succeeded");
  await expect
    .poll(() =>
      page.evaluate((fixtureId) => {
        const stores = (window as any).appStores;
        const fixture = (
          Object.values(stores.fixtures.get()) as Array<any>
        ).find((candidate) => candidate.identifiers.id === fixtureId);
        return fixture
          ? Object.keys(
              stores.parameters.get().get(fixture.identifiers.uid)?.raw ?? {},
            ).length
          : 0;
      }, ownedFixtureId),
    )
    .toBeGreaterThan(0);
}

/** Removes the fixture this scenario patched and unparks anything it left parked. */
test.afterEach(async ({ page }) => {
  await page.evaluate(async (fixtureId) => {
    const stores = (window as any).appStores;
    if (typeof stores?.sendAndAwait !== "function") return;
    await stores.sendAndAwait({
      module: "ParkCommand",
      command: { type: "UnparkAll" },
    });
    await stores.sendAndAwait({
      module: "FixtureCommand",
      command: { type: "DeleteFixture", data: fixtureId },
    });
  }, ownedFixtureId);
});

/**
 * Parking from the command line tags the value in Programmer and Fixtures, lists it in
 * Properties, and unparking from Properties releases it.
 */
test("park tags parked values and Properties unparks them", async ({
  page,
  backendSlot,
}) => {
  await openShowWithOwnedFixture(page, backendSlot.backendPort);
  await submitCommand(page, `fix ${ownedFixtureId} red @ 100 int @ 80`);
  await submitCommand(page, `park fixture ${ownedFixtureId} red`);
  await expect.poll(() => parkedCount(page)).toBe(1);

  await page.getByText("Programmer", { exact: true }).first().click();
  const programmer = page.locator('[data-panel-kind="programmer"]:visible');
  await expect(programmer).toBeVisible();
  await expect(
    programmer.getByRole("img", { name: /^Parked/ }).first(),
  ).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("park-programmer.png"),
  });

  await openPanel(page, "Fixtures");
  const fixtures = page.locator('[data-panel-kind="fixtures"]:visible');
  await expect(fixtures).toBeVisible();
  await expect(
    fixtures.getByRole("img", { name: /^Parked/ }).first(),
  ).toBeVisible();

  await openPanel(page, "Properties");
  const section = page.getByTestId("parked-parameters-section").first();
  await expect(section).toBeVisible();
  await expect(section).toContainText(`${ownedFixtureId} Red`);
  await page.screenshot({ path: test.info().outputPath("park-fixtures.png") });

  await section
    .getByRole("button", { name: `Unpark ${ownedFixtureId} Red` })
    .click();
  await expect.poll(() => parkedCount(page)).toBe(0);
  await expect(section).toContainText("Nothing is parked.");
  await expect(fixtures.getByRole("img", { name: /^Parked/ })).toHaveCount(0);
  await page.screenshot({
    path: test.info().outputPath("park-unparked.png"),
  });
});

/**
 * The status bar counts parked parameters, and clicking it opens Fixtures filtered to the parked
 * fixture and attribute columns until everything is unparked.
 */
test("the status bar parked count opens Fixtures filtered to parked parameters", async ({
  page,
  backendSlot,
}) => {
  await openShowWithOwnedFixture(page, backendSlot.backendPort);
  const indicator = page.getByTestId("status-parked-indicator");
  await expect(indicator).toHaveCount(0);

  await submitCommand(page, `park fixture ${ownedFixtureId} red @ 100`);
  await expect.poll(() => parkedCount(page)).toBe(1);
  await expect(indicator).toHaveText("1 parked");
  await indicator.click();

  const fixtures = page.locator('[data-panel-kind="fixtures"]:visible');
  await expect(fixtures).toBeVisible();
  await expect(
    fixtures.getByRole("switch", { name: "Show only parked parameters" }),
  ).toBeChecked();
  await expect(
    fixtures.locator('[data-grid-column-key="Red_Value"]').first(),
  ).toBeVisible();
  await expect(
    fixtures.locator('[data-grid-column-key="Pan_Value"]'),
  ).toHaveCount(0);
  await expect(
    fixtures.getByRole("img", { name: /^Parked/ }).first(),
  ).toBeVisible();
  await expect(
    fixtures.locator('[data-grid-column-key="Red_Value"]').first(),
  ).toContainText("255");
  await page.screenshot({
    path: test.info().outputPath("park-fixtures-filter.png"),
  });

  await submitCommand(page, `unpark fixture ${ownedFixtureId}`);
  await expect.poll(() => parkedCount(page)).toBe(0);
  await expect(indicator).toHaveCount(0);
  await expect(fixtures).toContainText("Nothing is parked");
});
