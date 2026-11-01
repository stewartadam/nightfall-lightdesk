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
const REPRESENTATIVE_STORE_SCOPES = [
  "routes",
  "dmx-universe-list",
  "fixtures",
  "flows",
  "parameters",
  "timelines",
];

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

/**
 * Asserts that a Performance Metrics row whose scope contains the given text is visible, scrolling
 * the virtualized grid to it. Scopes are listed alphabetically and every instrumented store adds
 * rows, so a scope late in the alphabet sits below the grid's visible height, and rows recorded
 * meanwhile can push it back out of view; each poll scrolls again before checking visibility.
 */
async function expectMetricsScopeVisible(
  panel: ReturnType<typeof instrumentationPanel>,
  scopeText: string,
): Promise<void> {
  const grid = panel
    .getByRole("grid", { name: "Performance metrics" })
    .locator('[data-grid-kind="tanstack"]');
  const scopeCell = grid
    .locator('[data-grid-column-key="scope"]')
    .filter({ hasText: scopeText })
    .first();
  await expect(grid).toBeVisible();
  await expect
    .poll(
      async () => {
        await grid.evaluate(async (element, text) => {
          /** Returns whether a scope cell containing the text is rendered in the grid window. */
          const rendered = () =>
            Array.from(
              element.querySelectorAll('[data-grid-column-key="scope"]'),
            ).some((cell) => cell.textContent?.includes(text));
          const steps = 40;
          for (let step = 0; step <= steps; step += 1) {
            if (rendered()) return;
            element.scrollTop = Math.round(
              ((element.scrollHeight - element.clientHeight) * step) / steps,
            );
            element.dispatchEvent(new Event("scroll", { bubbles: true }));
            await new Promise<void>((resolve) =>
              requestAnimationFrame(() => resolve()),
            );
          }
        }, scopeText);
        return scopeCell.isVisible();
      },
      { timeout: 10_000 },
    )
    .toBe(true);
}

/** Triggers a sequence store notification without depending on backend data. */
async function notifySequenceStore(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as any).appStores.sequences.set({});
  });
}

/** Triggers representative broad store notifications for instrumentation checks. */
async function notifyRepresentativeStores(page: Page): Promise<void> {
  await page.evaluate(() => {
    const stores = (window as any).appStores;
    const routes = stores.routes.get();
    stores.routes.set({
      ...routes,
      input: [...(routes.input ?? [])],
      output: [...(routes.output ?? [])],
      disabled: [...(routes.disabled ?? [])],
    });
    stores.dmxUniverseList.set([...(stores.dmxUniverseList.get() ?? [])]);
    stores.fixtures.set({ ...stores.fixtures.get() });
    stores.flows.set({ ...stores.flows.get() });
    stores.parameters.set(new Map(stores.parameters.get()));
    stores.timelines.set({ ...stores.timelines.get() });
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

/** Returns whether all representative store fanout metrics have been published. */
async function hasRepresentativeStoreMetrics(page: Page): Promise<boolean> {
  return page.evaluate((scopes) => {
    const stores = (window as any).appStores;
    const stats = stores.performanceMeasureStats.get();
    return scopes.every((scope) =>
      Object.keys(stats).includes(`nightfall:${scope}.listener-fanout`),
    );
  }, REPRESENTATIVE_STORE_SCOPES);
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
  await expectMetricsScopeVisible(
    panel,
    `sequences.panel.SequenceList.${SEQUENCE_PANEL_ID}.listener`,
  );
});

test("broad store listener metrics are installed for follow-up audits", async ({
  page,
}) => {
  await seedStartupShowfileName(page);
  await page.goto(
    "/?startup:draftRecovery=false&e2e=1&scenario=store-performance-instrumentation",
  );
  await waitForApp(page);

  await notifyRepresentativeStores(page);

  await expect
    .poll(() => hasRepresentativeStoreMetrics(page), { timeout: 20_000 })
    .toBe(true);
});
