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

const SCREENSHOT_DIR =
  "/mnt/project-files/ui-controls-audit/screenshots/inline-rename-field";

/** Loads the embedded demo show with the default layout so panels can be docked predictably. */
async function openDemo(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.goto("/?engine=embedded-demo&startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  await resetToDefaultLayout(page);
  await dockFixturesInMainGrid(page);
}

/** Saves a screenshot to the audit folder and the test's own output folder. */
async function capture(target: Page | Locator, testInfo: any, name: string) {
  await target.screenshot({ path: `${SCREENSHOT_DIR}/${name}.png` });
  await target.screenshot({ path: testInfo.outputPath(`${name}.png`) });
}

/** Reads a stored sequence's label from the frontend store. */
function sequenceLabel(page: Page, uid: string): Promise<string | undefined> {
  return page.evaluate(
    (sequenceUid) =>
      (window as any).appStores.sequences.get()[sequenceUid]?.identifiers.label,
    uid,
  );
}

/** Opens the first demo timeline with tracks alone in the dock and returns its UID. */
async function openDemoTimeline(page: Page): Promise<string> {
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            Object.values((window as any).appStores.timelines.get()).find(
              (timeline: any) => timeline.tracks?.length > 0,
            ) !== undefined,
        ),
      { timeout: 45_000 },
    )
    .toBe(true);
  const uid = await page.evaluate(() => {
    const stores = (window as any).appStores;
    const timeline = Object.values(stores.timelines.get()).find(
      (entry: any) => entry.tracks?.length > 0,
    ) as any;
    const api = stores.dockApi.get();
    api.clear();
    api.addPanel({
      id: "inline-rename-timeline",
      component: "Timeline",
      title: "Timeline",
      params: { initialTimelineUid: timeline.identifiers.uid },
    });
    return timeline.identifiers.uid as string;
  });
  await expect(
    page.locator(`[data-timeline-surface="true"][data-timeline-uid="${uid}"]`),
  ).toBeVisible();
  return uid;
}

/** Reads one timeline track's label from the frontend store. */
function trackLabel(page: Page, timelineUid: string, trackId: string) {
  return page.evaluate(
    ({ timelineUid, trackId }) =>
      (window as any).appStores.timelines
        .get()
        [timelineUid]?.tracks.find((track: any) => track.id === trackId)?.label,
    { timelineUid, trackId },
  );
}

/** Reads one timeline marker's label from the frontend store. */
function markerLabel(page: Page, timelineUid: string, markerUid: string) {
  return page.evaluate(
    ({ timelineUid, markerUid }) =>
      (window as any).appStores.timelines
        .get()
        [timelineUid]?.markers.find((marker: any) => marker.uid === markerUid)
        ?.label,
    { timelineUid, markerUid },
  );
}

/** Covers Enter, Escape (with no commit from the blur that follows) and blur on a CRUD card rename. */
test("CRUD card rename commits on Enter and blur and cancels on Escape", async ({
  page,
}, testInfo) => {
  await openDemo(page);
  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    api.addPanel({
      id: "panel-SequenceList-inline-rename",
      component: "SequenceList",
      title: "SequenceList",
      params: { initialPanelId: "panel-SequenceList-inline-rename" },
      position: { referencePanel: "panel-FixtureGrid", direction: "within" },
    });
    api.getPanel("panel-SequenceList-inline-rename").focus();
  });
  const panel = page.locator(
    '[data-component="SequenceList"][data-panel-id="panel-SequenceList-inline-rename"]',
  );
  const card = panel.locator("button[data-crud-select-id]:visible").first();
  await expect(card).toBeVisible();
  const uid = (await card.getAttribute("data-crud-select-id"))!;
  const original = (await sequenceLabel(page, uid))!;
  const editor = page.getByLabel("Sequence card label");

  /** Opens the card's inline rename from its context menu. */
  const startRename = async () => {
    await card.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
    await expect(editor).toBeFocused();
  };

  await startRename();
  await expect(editor).toHaveValue(original);
  await expect
    .poll(() =>
      editor.evaluate((input: HTMLInputElement) => [
        input.selectionStart,
        input.selectionEnd,
      ]),
    )
    .toEqual([0, original.length]);
  await editor.fill("Renamed by Enter");
  await capture(panel, testInfo, "crud-card-editing");
  await editor.press("Enter");
  await expect(editor).toHaveCount(0);
  await expect.poll(() => sequenceLabel(page, uid)).toBe("Renamed by Enter");

  await startRename();
  await editor.fill("Discarded draft");
  await editor.press("Escape");
  await expect(editor).toHaveCount(0);
  await expect(card).toBeFocused();
  await page.waitForTimeout(300);
  expect(await sequenceLabel(page, uid)).toBe("Renamed by Enter");

  await startRename();
  await editor.fill("Renamed by blur");
  await panel.getByRole("radio", { name: "List view" }).focus();
  await expect(editor).toHaveCount(0);
  await expect.poll(() => sequenceLabel(page, uid)).toBe("Renamed by blur");
  await capture(panel, testInfo, "crud-card-after-blur");
});

/** Covers Enter, Escape (with no commit from the blur that follows) and blur on a track header rename. */
test("track header rename commits on Enter and blur and cancels on Escape", async ({
  page,
}, testInfo) => {
  await openDemo(page);
  const timelineUid = await openDemoTimeline(page);
  const header = page.locator('[data-timeline-track-header="true"]').first();
  const trackId = (await header.getAttribute("data-track-id"))!;
  const original = (await trackLabel(page, timelineUid, trackId))!;
  const editor = header.getByRole("textbox");

  /** Opens the inline rename by double-clicking the track name. */
  const startRename = async () => {
    const label = (await trackLabel(page, timelineUid, trackId))!;
    await header.getByRole("button", { name: label, exact: true }).dblclick();
    await expect(editor).toBeFocused();
    await expect(editor).toHaveValue(label);
  };

  await startRename();
  await expect(editor).toHaveAttribute(
    "aria-label",
    `Rename track ${original}`,
  );
  await editor.fill("Enter Track");
  await capture(header, testInfo, "track-header-editing");
  await editor.press("Enter");
  await expect(editor).toHaveCount(0);
  await expect
    .poll(() => trackLabel(page, timelineUid, trackId))
    .toBe("Enter Track");

  await startRename();
  await editor.fill("Discarded Track");
  await editor.press("Escape");
  await expect(editor).toHaveCount(0);
  await expect(
    header.getByRole("button", { name: "Enter Track", exact: true }),
  ).toBeFocused();
  await page.waitForTimeout(300);
  expect(await trackLabel(page, timelineUid, trackId)).toBe("Enter Track");

  await startRename();
  await editor.fill("Blur Track");
  await page
    .locator('[data-timeline-surface="true"]')
    .first()
    .click({
      position: { x: 400, y: 10 },
    });
  await expect(editor).toHaveCount(0);
  await expect
    .poll(() => trackLabel(page, timelineUid, trackId))
    .toBe("Blur Track");
});

/** Covers Enter, Escape (with no commit from the blur that follows) and blur on a marker label rename. */
test("marker label rename commits on Enter and blur and cancels on Escape", async ({
  page,
}, testInfo) => {
  await openDemo(page);
  const timelineUid = await openDemoTimeline(page);
  const editor = page.getByLabel("Marker label");
  await page
    .locator('[data-timeline-operator-lane="true"]')
    .first()
    .click({ position: { x: 100, y: 18 } });
  await page.keyboard.press("m");
  const marker = page.locator('[data-timeline-marker="true"]').first();
  await expect(marker).toBeVisible();
  const markerUid = (await marker.getAttribute("data-marker-id"))!;
  await expect(editor).toBeFocused();
  await expect(editor).toHaveValue(/^Marker \d+$/);

  /** Opens the marker's inline label editor with a double-click. */
  const startRename = async () => {
    await marker.dblclick();
    await expect(editor).toBeFocused();
  };

  await page.keyboard.type("Remount");
  await page.evaluate((uid) => {
    const stores = (window as any).appStores;
    const timeline = stores.timelines.get()[uid];
    stores.timelines.setKey(uid, {
      ...timeline,
      markers: timeline.markers.map((entry: any) => ({ ...entry })),
    });
  }, timelineUid);
  await expect(editor).toHaveValue("Remount");
  await expect(editor).toBeFocused();
  expect(await markerLabel(page, timelineUid, markerUid)).toMatch(
    /^Marker \d+$/,
  );
  await editor.fill("Enter Marker");
  await capture(
    page.locator('[data-timeline-surface="true"]').first(),
    testInfo,
    "marker-label-editing",
  );
  await editor.press("Enter");
  await expect(editor).toHaveCount(0);
  await expect
    .poll(() => markerLabel(page, timelineUid, markerUid))
    .toBe("Enter Marker");

  await startRename();
  await editor.fill("Discarded Marker");
  await editor.press("Escape");
  await expect(editor).toHaveCount(0);
  await expect(marker).toBeFocused();
  await page.waitForTimeout(300);
  expect(await markerLabel(page, timelineUid, markerUid)).toBe("Enter Marker");

  await startRename();
  await editor.fill("Blur Marker");
  await page
    .locator('[data-timeline-track-header="true"]')
    .first()
    .click({ position: { x: 4, y: 4 } });
  await expect(editor).toHaveCount(0);
  await expect
    .poll(() => markerLabel(page, timelineUid, markerUid))
    .toBe("Blur Marker");
  await expect(marker).toContainText("Blur Marker");
});

/** Shows that Escape in a dialog's inline rename discards the draft without closing the dialog. */
test("layout manager rename keeps Escape inside the dialog", async ({
  page,
}, testInfo) => {
  await openDemo(page);
  await page
    .getByRole("button", { name: "Manage layouts", exact: true })
    .click();
  const manager = page.getByRole("dialog", { name: "Manage layouts" });
  await expect(manager).toBeVisible();
  const renameButton = manager
    .getByRole("button", { name: /^Rename / })
    .first();
  const name = (await renameButton.getAttribute("aria-label"))!.replace(
    /^Rename /,
    "",
  );
  await renameButton.click();
  const editor = manager.getByRole("textbox", {
    name: `Layout name for ${name}`,
  });
  await expect(editor).toBeFocused();
  await editor.fill("Discarded layout");
  await capture(manager, testInfo, "layout-manager-editing");
  await editor.press("Escape");
  await expect(editor).toHaveCount(0);
  await expect(manager).toBeVisible();
  await expect(
    manager.getByRole("button", { name: `Rename ${name}`, exact: true }),
  ).toBeFocused();

  await manager
    .getByRole("button", { name: `Rename ${name}`, exact: true })
    .click();
  await editor.fill("Stage desk");
  await editor.press("Enter");
  await expect(editor).toHaveCount(0);
  await expect(manager).toBeVisible();
  await expect(manager.getByText("Stage desk", { exact: true })).toBeVisible();
});
