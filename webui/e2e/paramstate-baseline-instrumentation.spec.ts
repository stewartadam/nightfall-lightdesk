// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import { expect, type Locator, type Page, test } from "./playwright-fixtures";
import { dockFixturesInMainGrid, waitForDockviewApp } from "./showfile-startup";

test.setTimeout(60_000);

/** Opens an isolated app containing one fixture that drives parameter-state metrics. */
async function openOwnedParamstateApp(
  page: Page,
  backendPort: number,
  scenario: string,
): Promise<void> {
  await prepareFreshBackendShowfile(backendPort);
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("nightfall.currentShowfileName", "default");
  });
  await page.goto(`/?startup:draftRecovery=false&e2e=1&scenario=${scenario}`);
  await waitForDockviewApp(page);
  await dockFixturesInMainGrid(page);
  await expect
    .poll(() =>
      page.evaluate(
        () => Object.keys((window as any).appStores.fixtures.get()).length,
      ),
    )
    .toBe(0);

  await page.evaluate(async () => {
    const stores = (window as any).appStores;
    const fixtureId = Math.floor(600_000 + Math.random() * 100_000);
    const result = await stores.sendAndAwait({
      module: "FixtureLibraryCommand",
      command: {
        type: "CreateFixtureFromLibrary",
        data: {
          id: fixtureId,
          make: "Generic",
          model: "Moving Head RGBW",
          mode: "Spot",
          label: `Parameter State Fixture ${fixtureId}`,
          update_existing_ids: [],
          update_existing_only: false,
        },
      },
    });
    if (result.outcome.type !== "Succeeded") {
      throw new Error(
        `failed to create parameter-state fixture: ${JSON.stringify(result)}`,
      );
    }
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => Object.keys((window as any).appStores.fixtures.get()).length,
      ),
    )
    .toBe(1);
}

const INSTRUMENTATION_PANEL_ID = "panel-Instrumentation-paramstate-baseline";

/**
 * Opens a dedicated instrumentation panel through the dock API and returns a
 * locator scoped to its content, since the default layout already mounts
 * another Instrumentation panel whose sections share the same labels.
 */
async function openInstrumentationPanel(page: Page): Promise<Locator> {
  await page.evaluate((panelId) => {
    const api = (window as any).appStores.dockApi.get();
    const panel = api.addPanel({
      id: panelId,
      component: "Instrumentation",
      title: "Instrumentation",
      position: {
        referencePanel: "panel-FixtureGrid",
        direction: "within",
      },
      params: {},
    });
    panel.api.setActive();
    panel.focus();
  }, INSTRUMENTATION_PANEL_ID);
  const panel = page.locator(`[data-panel-id="${INSTRUMENTATION_PANEL_ID}"]`);
  await expect(panel).toBeVisible();
  return panel;
}

/** Verifies baseline parameter-state measurements are visible and emitted. */
test("parameter state baseline instrumentation is exposed", async ({
  backendSlot,
  page,
}) => {
  await openOwnedParamstateApp(
    page,
    backendSlot.backendPort,
    "paramstate-baseline-instrumentation",
  );

  await page.waitForFunction(() =>
    Boolean(
      (window as any).appStores.performanceMeasureStats.get()[
        "nightfall:websocket-main.parameter-state.process"
      ],
    ),
  );

  const instrumentation = await openInstrumentationPanel(page);
  await instrumentation
    .getByRole("button", { name: "Backend", exact: true })
    .click();

  await expect(instrumentation.getByText("ParameterState Build")).toBeVisible();
  await expect(
    instrumentation.getByText("ParameterState Broadcast"),
  ).toBeVisible();
  await expect(instrumentation.getByText("LayerStack Build")).toBeVisible();
  await expect(
    instrumentation.getByText("Layer Transition Build"),
  ).toBeVisible();

  await instrumentation.getByText("Performance Metrics").click();
  await expect(
    instrumentation.getByRole("button", { name: "Download JSON" }),
  ).toBeVisible();
  await expect(
    instrumentation.getByRole("columnheader", { name: "Avg" }),
  ).toBeVisible();
  await expect(
    instrumentation.getByRole("columnheader", { name: "P90" }),
  ).toBeVisible();
  await expect(
    instrumentation.getByRole("columnheader", { name: "P95" }),
  ).toBeVisible();
  await expect(
    instrumentation.getByRole("columnheader", { name: "Max" }),
  ).toBeVisible();
  const measures = instrumentation.getByRole("grid", {
    name: "Performance metrics",
  });
  const processScope = measures.getByRole("gridcell", {
    name: "websocket-main.parameter-state.process",
    exact: true,
  });
  // The grid only renders the rows in view, so page through it until the scope appears.
  await expect
    .poll(
      async () => {
        if ((await processScope.count()) > 0) return true;
        await measures.evaluate((grid) => {
          const scroller = [grid, ...grid.querySelectorAll("*")].find(
            (element) =>
              /auto|scroll/.test(getComputedStyle(element).overflowY) &&
              element.scrollHeight > element.clientHeight + 1,
          );
          if (scroller) scroller.scrollTop += scroller.clientHeight;
        });
        return false;
      },
      { intervals: [100], timeout: 20_000 },
    )
    .toBe(true);
  await expect(processScope).toBeVisible();

  const timingNames = await page.evaluate(() =>
    Object.keys((window as any).appStores.performanceMeasureStats.get()),
  );

  expect(timingNames).toContain(
    "nightfall:websocket-main.parameter-state.process",
  );
  expect(timingNames).toContain(
    "nightfall:websocket-main.parameter-state.store-set",
  );
});

/** Verifies performance baseline metrics can be downloaded as JSON. */
test("performance baseline metrics download as JSON", async ({
  backendSlot,
  page,
}) => {
  await openOwnedParamstateApp(
    page,
    backendSlot.backendPort,
    "paramstate-baseline-download",
  );

  await page.waitForFunction(() =>
    Boolean(
      (window as any).appStores.performanceMeasureStats.get()[
        "nightfall:websocket-main.parameter-state.process"
      ],
    ),
  );

  const instrumentation = await openInstrumentationPanel(page);
  await instrumentation.getByText("Performance Metrics").click();

  const downloadPromise = page.waitForEvent("download");
  await instrumentation.getByRole("button", { name: "Download JSON" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(
    /^nightfall-performance-baseline-.*\.json$/,
  );

  const content = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of content) {
    chunks.push(Buffer.from(chunk));
  }
  const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));

  expect(payload.schemaVersion).toBe(1);
  expect(payload.rollingWindowMs).toBe(60_000);
  expect(payload.performanceMeasures.length).toBeGreaterThan(0);
  expect(payload.backend).toBeTruthy();
  expect(payload.websocket).toBeTruthy();
});
