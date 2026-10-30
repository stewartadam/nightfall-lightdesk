// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { Locator, Page } from "@playwright/test";
import { expect, frontendOnlyTest as test } from "./playwright-fixtures";
import {
  dockFixturesInMainGrid,
  resetToDefaultLayout,
  waitForDockviewApp,
} from "./showfile-startup";

// The debug demo engine can take a while to boot on a loaded machine.
test.describe.configure({ timeout: 120_000 });

/** Opens the embedded demo with the default layout and fixtures docked in the main grid. */
async function openDemo(page: Page) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/?engine=embedded-demo&startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  await resetToDefaultLayout(page);
  await dockFixturesInMainGrid(page);
}

/** Adds a panel beside the fixture grid and makes it the active tab of that group. */
async function openMainPanel(
  page: Page,
  component: string,
  id: string,
  params: Record<string, unknown> = {},
) {
  await page.evaluate(
    ({ component, id, params }) => {
      const api = (window as any).appStores.dockApi.get();
      api.addPanel({
        id,
        component,
        title: component,
        params: { initialPanelId: id, ...params },
        position: { referencePanel: "panel-FixtureGrid", direction: "within" },
      });
      api.getPanel(id).focus();
    },
    { component, id, params },
  );
}

/** Hovers a control and returns the shared tooltip surface that opens for it. */
async function hoverTooltip(page: Page, trigger: Locator): Promise<Locator> {
  await trigger.hover();
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toBeVisible();
  return tooltip;
}

/** Checks list toolbars draw shared separators and expose selection mode as a toggle. */
test("list toolbars use shared separators and toggle buttons", async ({
  page,
}, testInfo) => {
  await openDemo(page);
  await openMainPanel(page, "CueList", "panel-CueList-toolbar-check");
  const panel = page.locator(
    '[data-panel-id="panel-CueList-toolbar-check"]:visible',
  );
  await expect(panel).toBeVisible();
  const gridView = panel.getByRole("radio", { name: "Grid view" });
  await gridView.click();
  await expect(gridView).toHaveAttribute("aria-checked", "true");
  await expect(panel.getByRole("radio", { name: "List view" })).toHaveAttribute(
    "aria-checked",
    "false",
  );
  await expect(panel.locator(".nf-toolbar-separator").first()).toBeVisible();
  await expect(panel.locator(".w-px")).toHaveCount(0);

  const selectionMode = panel.getByRole("button", {
    name: "Toggle selection mode",
  });
  await expect(selectionMode).toHaveAttribute("aria-pressed", "false");
  await selectionMode.click();
  await expect(selectionMode).toHaveAttribute("aria-pressed", "true");
  await page.mouse.move(0, 0);
  await panel
    .locator(".nf-panel-toolbar")
    .first()
    .screenshot({
      path: testInfo.outputPath("cue-list-toolbar-selection-mode.png"),
    });
});

/** Checks timeline track header buttons show their help through the shared tooltip, not `title`. */
test("timeline track header buttons use shared tooltips", async ({
  page,
}, testInfo) => {
  await openDemo(page);
  const timelineUid = await page.evaluate(
    () =>
      (
        Object.values((window as any).appStores.timelines.get())[0] as {
          identifiers: { uid: string };
        }
      ).identifiers.uid,
  );
  await openMainPanel(page, "Timeline", "toolbar-check-timeline", {
    initialTimelineUid: timelineUid,
  });
  const toolbar = page.locator('[data-timeline-toolbar="true"]:visible');
  await expect(toolbar).toBeVisible();
  await expect(toolbar.locator(".nf-toolbar-separator").first()).toBeVisible();
  const loop = toolbar.getByRole("button", { name: "Toggle loop range" });
  await expect(loop).toHaveAttribute("aria-pressed", /true|false/);

  const header = page
    .locator('[data-timeline-track-header="true"]:visible')
    .first();
  await expect(header).toBeVisible();
  const mute = header.getByRole("button", { name: /^(Mute|Unmute)$/ });
  await expect(mute).not.toHaveAttribute("title");
  const tooltip = await hoverTooltip(page, mute);
  await expect(tooltip).toHaveText(/^(Mute|Unmute)$/);
  await page.screenshot({
    path: testInfo.outputPath("timeline-track-header-mute-tooltip.png"),
  });
  await page.mouse.move(0, 0);
  await expect(tooltip).toBeHidden();
  await toolbar.screenshot({
    path: testInfo.outputPath("timeline-toolbar.png"),
  });
});

/** Checks command history icon buttons show their shortcut help through the shared tooltip. */
test("command history buttons use shared tooltips", async ({
  page,
}, testInfo) => {
  await openDemo(page);
  await openMainPanel(page, "CommandLine", "toolbar-check-command-line");
  const panel = page.locator(
    '[data-panel-id="toolbar-check-command-line"]:visible',
  );
  const search = panel.getByRole("button", {
    name: "Search command history",
  });
  await expect(search).toBeVisible();
  await expect(search).not.toHaveAttribute("title");
  await expect(search).toHaveAttribute(
    "aria-description",
    "Search command history (Mod+F)",
  );
  const tooltip = await hoverTooltip(page, search);
  await expect(tooltip).toHaveText("Search command history (Mod+F)");
  await page.screenshot({
    path: testInfo.outputPath("command-history-search-tooltip.png"),
  });
});

/** Checks a disabled clip control button still explains itself through the shared tooltip on hover. */
test("disabled clip control buttons explain why through shared tooltips", async ({
  page,
}, testInfo) => {
  await openDemo(page);
  await page.getByRole("tab", { name: "Clips", exact: true }).click();
  const disabled = page
    .locator("[data-fader-button-index]:disabled:visible")
    .first();
  await expect(disabled).toBeVisible();
  await expect(disabled).not.toHaveAttribute("title");
  const tooltip = await hoverTooltip(page, disabled);
  await expect(tooltip).toHaveText(/enable the button|respond to the button/);
  await page.screenshot({
    path: testInfo.outputPath("clip-control-disabled-tooltip.png"),
  });
});
