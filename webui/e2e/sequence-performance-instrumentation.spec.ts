// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, type Page, test } from "./playwright-fixtures";
import {
  seedStartupShowfileName,
  waitForDockviewApp,
} from "./showfile-startup";

const SEQUENCE_PANEL_ID = "panel-SequenceList-performance-e2e";
const INSTRUMENTATION_PANEL_ID = "panel-Instrumentation-sequence-performance";

/** Waits for the app shell to expose its debug store bridge and Dockview API. */
async function waitForApp(page: Page): Promise<void> {
  await waitForDockviewApp(page, {
    createIfMissing: true,
    newShowfileName: "sequence-performance-instrumentation",
  });
}

/** Opens the Sequence List panel so store listeners register with panel context. */
async function openSequenceListPanel(page: Page): Promise<void> {
  await page.evaluate((panelId) => {
    const api = (window as any).appStores.dockApi.get();
    const referencePanel =
      (api.activePanel?.api.location.type === "grid"
        ? api.activePanel
        : undefined) ??
      api.panels.find(
        (candidate: any) => candidate.api.location.type === "grid",
      ) ??
      api.getPanel("panel-FixtureGrid");
    const panel = api.addPanel({
      id: panelId,
      component: "SequenceList",
      title: "Sequences",
      params: {},
      ...(referencePanel
        ? {
            position: {
              referencePanel: referencePanel.id,
              direction: "within",
            },
          }
        : {}),
    });
    panel.api.setActive();
    panel.focus();
  }, SEQUENCE_PANEL_ID);
  await expect(
    page.locator(
      `[data-component="SequenceList"][data-panel-id="${SEQUENCE_PANEL_ID}"]`,
    ),
  ).toBeVisible();
}

/** Opens the Instrumentation panel used to inspect collected metrics. */
async function openInstrumentationPanel(page: Page): Promise<void> {
  await page.evaluate((panelId) => {
    const api = (window as any).appStores.dockApi.get();
    const referencePanel =
      (api.activePanel?.api.location.type === "grid"
        ? api.activePanel
        : undefined) ??
      api.panels.find(
        (candidate: any) => candidate.api.location.type === "grid",
      ) ??
      api.getPanel("panel-FixtureGrid");
    const panel = api.addPanel({
      id: panelId,
      component: "Instrumentation",
      title: "Instrumentation",
      params: {},
      ...(referencePanel
        ? {
            position: {
              referencePanel: referencePanel.id,
              direction: "within",
            },
          }
        : {}),
    });
    panel.api.setActive();
    panel.focus();
  }, INSTRUMENTATION_PANEL_ID);
  await expect(
    page.locator(
      `[data-component="Instrumentation"][data-panel-id="${INSTRUMENTATION_PANEL_ID}"]`,
    ),
  ).toBeVisible();
}

/** Returns the instrumentation panel opened by this spec. */
function instrumentationPanel(page: Page) {
  return page.locator(
    `[data-component="Instrumentation"][data-panel-id="${INSTRUMENTATION_PANEL_ID}"]`,
  );
}

/** Triggers a sequence store notification without depending on backend data. */
async function notifySequenceStore(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as any).appStores.sequences.set({});
  });
}

/** Returns whether panel-qualified sequence listener metrics have been published. */
async function hasSequencePanelMetric(page: Page): Promise<boolean> {
  return page.evaluate((panelId) => {
    const stores = (window as any).appStores;
    stores.sequences.set({});
    const stats = stores.performanceMeasureStats.get();
    return Object.keys(stats).some((name) =>
      name.includes(
        `nightfall:sequences.panel.SequenceList.${panelId}.listener`,
      ),
    );
  }, SEQUENCE_PANEL_ID);
}

test("sequence store listener metrics include mounted panel identity", async ({
  page,
}) => {
  await seedStartupShowfileName(page);
  await page.goto(
    "/?startup:draftRecovery=false&e2e=1&scenario=sequence-performance-instrumentation",
  );
  await waitForApp(page);

  await openSequenceListPanel(page);
  await notifySequenceStore(page);

  await expect
    .poll(() => hasSequencePanelMetric(page), { timeout: 20_000 })
    .toBe(true);

  await openInstrumentationPanel(page);
  const panel = instrumentationPanel(page);
  await panel.getByRole("button", { name: /Performance Metrics/ }).click();
  await expect(
    panel.getByText(
      `sequences.panel.SequenceList.${SEQUENCE_PANEL_ID}.listener`,
      { exact: false },
    ),
  ).toBeVisible();
});
