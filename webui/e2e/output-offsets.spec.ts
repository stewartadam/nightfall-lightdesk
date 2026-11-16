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

const ownedFixtureId = 313;

test.setTimeout(90_000);

/** Returns the stored offset of one attribute on the scenario's fixture, as the engine reports it. */
function storedOffset(page: Page, attribute: string): Promise<unknown> {
  return page.evaluate(
    ({ fixtureId, attribute }) => {
      const fixture = (
        Object.values((window as any).appStores.fixtures.get()) as Array<any>
      ).find((candidate) => candidate.identifiers.id === fixtureId);
      const parameter = fixture?.elements
        .flatMap((element: any) => element.parameters)
        .find((candidate: any) => candidate.attribute.type === attribute);
      return parameter?.offset ?? null;
    },
    { fixtureId: ownedFixtureId, attribute },
  );
}

/** Opens a blank backend show and patches the RGBW moving head whose offsets the scenario edits. */
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
          label: "Offset mover",
          update_existing_ids: [],
          update_existing_only: false,
        },
      },
    });
  }, ownedFixtureId);
  expect(result.outcome.type, JSON.stringify(result)).toBe("Succeeded");
}

/** Removes the fixture this scenario patched. */
test.afterEach(async ({ page }) => {
  await page.evaluate(async (fixtureId) => {
    const stores = (window as any).appStores;
    if (typeof stores?.sendAndAwait !== "function") return;
    await stores.sendAndAwait({
      module: "FixtureCommand",
      command: { type: "DeleteFixture", data: fixtureId },
    });
  }, ownedFixtureId);
});

/**
 * Selecting a fixture in Patch lists its output offsets in Properties; typing an offset stores it
 * in percent, and reset clears it.
 */
test("Patch Properties edits and resets a fixture's output offsets", async ({
  page,
  backendSlot,
}) => {
  await openShowWithOwnedFixture(page, backendSlot.backendPort);
  await openPanel(page, "Patch");
  const grid = page.locator('[data-grid-kind="tanstack"]:visible').first();
  await expect(grid.locator("#tanstack-cell-0-0")).toHaveText(
    String(ownedFixtureId),
  );
  await grid
    .getByRole("checkbox", { name: "Select row 1", exact: true })
    .click();

  await openPanel(page, "Properties");
  const section = page.getByTestId("output-offsets-properties").first();
  await expect(section).toContainText(
    `Shifts what fixture ${ownedFixtureId} outputs`,
  );
  const red = section.getByRole("spinbutton", {
    name: "Red offset in percent",
  });
  await expect(red).toHaveValue("0");

  await red.fill("10");
  await red.press("Enter");
  await expect
    .poll(() => storedOffset(page, "Red"))
    .toEqual({
      type: "AbsolutePercent",
      data: { value: expect.closeTo(0.1, 5) },
    });
  await expect(red).toHaveValue("10");
  await page.screenshot({
    path: test.info().outputPath("output-offsets.png"),
  });

  await section.getByRole("button", { name: "Reset Red offset" }).click();
  await expect
    .poll(() => storedOffset(page, "Red"))
    .toEqual({ type: "Absolute", data: { value: 0 } });
  await expect(red).toHaveValue("0");
});
