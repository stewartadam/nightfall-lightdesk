// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, type Page, test } from "./playwright-fixtures";
import { prepareStoreSeededTestApp } from "./showfile-startup";

type DragPreviewFixture = {
  timelineUid: string;
  sourceTrackId: string;
  targetTrackId: string;
  actionId: string;
  secondItemId: string;
};

/** Opens an empty disconnected app ready for an owned timeline fixture. */
async function openTimelineApp(page: Page): Promise<void> {
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto("/?e2e=1");
  await prepareStoreSeededTestApp(page);
}

/** Opens an isolated timeline with one draggable item and two target tracks. */
async function openDragPreviewFixture(page: Page): Promise<DragPreviewFixture> {
  return page.evaluate(() => {
    const stores = (window as any).appStores;
    const api = stores.dockApi.get();
    const timelineUid = "71717171717171717171717171717171";
    const timecodeUid = "72727272727272727272727272727272";
    const sourceTrackId = "e2e-drag-source";
    const targetTrackId = "e2e-drag-target";
    const actionId = "e2e-drag-item";
    const secondItemId = "e2e-drag-second-item";

    stores.timecodes.set({
      [timecodeUid]: [
        {
          identifiers: {
            id: 202,
            uid: timecodeUid,
            label: "E2E Drag Preview Timecode",
          },
          rate: "Fps30",
          source: "Internal",
        },
        {
          timecode_id: 202,
          is_active: false,
          current_time: { secs: 0, nanos: 0 },
          start_time: null,
          end_time: null,
        },
      ],
    });
    stores.timelines.set({
      [timelineUid]: {
        identifiers: {
          id: 201,
          uid: timelineUid,
          label: "E2E Drag Preview Timeline",
        },
        timecode_uid: timecodeUid,
        timecode_start: { secs: 0, nanos: 0 },
        audio_path: "",
        audio_enabled: false,
        end_time: null,
        trigger_mode: "FollowTimecode",
        seek_behavior: "ReconstructState",
        nondeterministic_seek_behavior: "Ignore",
        stop_behavior: "ResetAndReleaseOwnedActions",
        lookahead: "disabled",
        tracks: [
          {
            id: sourceTrackId,
            label: "Drag Source",
            muted: false,
            solo: false,
            expanded: false,
            actions: [
              {
                id: actionId,
                label: "Drag Preview Item",
                position: { secs: 1, nanos: 250_000_000 },
                duration: { secs: 1, nanos: 0 },
                action: {
                  type: "FireCue",
                  data: "00000000000000000000000000000000",
                },
              },
              {
                id: secondItemId,
                label: "Drag Preview Second Item",
                position: { secs: 2, nanos: 250_000_000 },
                duration: { secs: 1, nanos: 0 },
                action: {
                  type: "FireCue",
                  data: "00000000000000000000000000000000",
                },
              },
            ],
            automation_lanes: [],
          },
          {
            id: targetTrackId,
            label: "Drag Target",
            muted: false,
            solo: false,
            expanded: false,
            actions: [],
            automation_lanes: [],
          },
        ],
        markers: [],
        regions: [],
        loop_range: null,
        bpm: 120,
        beats_per_bar: 4,
        use_beat_grid: false,
        beatgrid: null,
        scroll_mode: "free",
      },
    });
    stores.timelineDefinitionsLoaded.set(true);

    const panelId = `e2e-drag-preview-${timelineUid}`;
    const panel = api.addPanel({
      id: panelId,
      component: "Timeline",
      title: "Drag Preview",
      params: { initialTimelineUid: timelineUid },
      position: {
        referencePanel: "panel-FixtureGrid",
        direction: "within",
      },
    });
    panel.api.setActive();
    panel.focus();

    return {
      timelineUid,
      sourceTrackId,
      targetTrackId,
      actionId,
      secondItemId,
    };
  });
}

/** Drags the fixture item vertically to the target track lane. */
async function dragItemToTargetTrack(
  page: Page,
  fixture: DragPreviewFixture,
  actionId = fixture.actionId,
  grabOffsetPx = 12,
) {
  const sourceItem = page.locator(
    `[data-timeline-action="true"][data-track-id="${fixture.sourceTrackId}"][data-action-id="${actionId}"]:not([data-drag-preview="true"])`,
  );
  const targetLane = page.locator(
    `[data-timeline-track-lane="true"][data-track-id="${fixture.targetTrackId}"]`,
  );
  await sourceItem.scrollIntoViewIfNeeded();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  await sourceItem.scrollIntoViewIfNeeded();
  await expect(sourceItem).toBeVisible();
  await sourceItem.hover({ position: { x: grabOffsetPx, y: 5 } });
  const initialItemBox = await sourceItem.boundingBox();
  const laneBox = await targetLane.boundingBox();
  if (!initialItemBox || !laneBox) {
    throw new Error("Drag fixture elements were not visible");
  }

  const grabPosition = {
    x: Math.min(grabOffsetPx, initialItemBox.width / 2),
    y: initialItemBox.height / 2,
  };
  await sourceItem.hover({ position: grabPosition });
  const itemBox = await sourceItem.boundingBox();
  if (!itemBox) {
    throw new Error("Drag fixture item moved outside the viewport");
  }
  const startX = itemBox.x + grabPosition.x;
  const startY = itemBox.y + grabPosition.y;
  const targetY = laneBox.y + laneBox.height / 2;
  await page.mouse.down();
  await page.mouse.move(startX + 5, startY, { steps: 3 });
  await expect(sourceItem).toHaveClass(/neodrag-dragging/);
  await page.mouse.move(startX, targetY, { steps: 8 });
  return { sourceItem, startX };
}

/** Verifies action drag previews render separately and Esc cancels the pending move. */
test("timeline action drag renders preview copies and supports escape cancel", async ({
  page,
}) => {
  await openTimelineApp(page);
  const fixture = await openDragPreviewFixture(page);

  const surface = page.locator(
    `[data-timeline-surface="true"][data-timeline-uid="${fixture.timelineUid}"]`,
  );
  await expect(surface).toBeVisible();
  await surface.getByLabel("Timeline zoom").fill("300");

  const firstDrag = await dragItemToTargetTrack(page, fixture);
  const previewItem = page.locator(
    `[data-timeline-action="true"][data-track-id="${fixture.targetTrackId}"][data-action-id="${fixture.actionId}"][data-drag-preview="true"]`,
  );
  await expect(previewItem).toBeVisible();

  const sourceOpacity = await firstDrag.sourceItem.evaluate((element) =>
    Number(window.getComputedStyle(element).opacity),
  );
  const previewOpacity = await previewItem.evaluate((element) =>
    Number(window.getComputedStyle(element).opacity),
  );
  expect(sourceOpacity).toBeLessThan(1);
  expect(previewOpacity).toBeLessThan(1);

  const previewBox = await previewItem.boundingBox();
  const sourceBox = await firstDrag.sourceItem.boundingBox();
  expect(previewBox).not.toBeNull();
  expect(sourceBox).not.toBeNull();
  expect(Math.abs((previewBox?.x ?? 0) - firstDrag.startX)).toBeLessThan(3);

  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(previewItem).toHaveCount(0);
  await expect(firstDrag.sourceItem).toBeVisible();
});

/** Verifies near-vertical track switches snap back to the item's original start. */
test("timeline action drag snaps close previews to the original start", async ({
  page,
}) => {
  await openTimelineApp(page);
  const fixture = await openDragPreviewFixture(page);

  const surface = page.locator(
    `[data-timeline-surface="true"][data-timeline-uid="${fixture.timelineUid}"]`,
  );
  await expect(surface).toBeVisible();
  await surface.getByLabel("Timeline zoom").fill("300");

  const drag = await dragItemToTargetTrack(page, fixture, fixture.actionId, 5);
  const previewItem = page.locator(
    `[data-timeline-action="true"][data-track-id="${fixture.targetTrackId}"][data-action-id="${fixture.actionId}"][data-drag-preview="true"]`,
  );
  await expect(previewItem).toBeVisible();

  const previewBox = await previewItem.boundingBox();
  const sourceBox = await drag.sourceItem.boundingBox();
  expect(previewBox).not.toBeNull();
  expect(sourceBox).not.toBeNull();
  expect(Math.abs((previewBox?.x ?? 0) - (sourceBox?.x ?? 0))).toBeLessThan(3);

  await page.keyboard.press("Escape");
  await page.mouse.up();
});

/** Verifies shift-selected timeline action ranges drag as one grouped operation. */
test("timeline action drag moves shift-selected action ranges together", async ({
  page,
}) => {
  await openTimelineApp(page);
  const fixture = await openDragPreviewFixture(page);

  const surface = page.locator(
    `[data-timeline-surface="true"][data-timeline-uid="${fixture.timelineUid}"]`,
  );
  await expect(surface).toBeVisible();
  await surface.getByLabel("Timeline zoom").fill("300");

  const firstItem = page.locator(
    `[data-timeline-action="true"][data-track-id="${fixture.sourceTrackId}"][data-action-id="${fixture.actionId}"]:not([data-drag-preview="true"])`,
  );
  const secondItem = page.locator(
    `[data-timeline-action="true"][data-track-id="${fixture.sourceTrackId}"][data-action-id="${fixture.secondItemId}"]:not([data-drag-preview="true"])`,
  );
  await firstItem.click();
  await secondItem.click({ modifiers: ["Shift"] });
  const firstItemOriginalBox = await firstItem.boundingBox();
  const secondItemOriginalBox = await secondItem.boundingBox();
  await expect(firstItem).toHaveAttribute("data-selected", "true");
  await expect(secondItem).toHaveAttribute("data-selected", "true");

  const focusedOutline = await secondItem.evaluate((element) => {
    const style = window.getComputedStyle(element);
    return {
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
    };
  });
  expect(focusedOutline.outlineStyle).toBe("none");

  const groupedDrag = await dragItemToTargetTrack(
    page,
    fixture,
    fixture.secondItemId,
  );
  await expect(firstItem).toHaveAttribute("data-selected", "true");
  await expect(secondItem).toHaveAttribute("data-selected", "true");
  await expect(
    page.locator(
      `[data-timeline-action="true"][data-track-id="${fixture.targetTrackId}"][data-drag-preview="true"]`,
    ),
  ).toHaveCount(2);
  await page.mouse.up();

  const firstTargetItem = page.locator(
    `[data-timeline-action="true"][data-track-id="${fixture.targetTrackId}"][data-action-id="${fixture.actionId}"]:not([data-drag-preview="true"])`,
  );
  const secondTargetItem = page.locator(
    `[data-timeline-action="true"][data-track-id="${fixture.targetTrackId}"][data-action-id="${fixture.secondItemId}"]:not([data-drag-preview="true"])`,
  );
  await expect(firstTargetItem).toBeVisible();
  await expect(secondTargetItem).toBeVisible();
  await expect(firstItem).toHaveCount(0);
  await expect(secondItem).toHaveCount(0);

  const firstTargetBox = await firstTargetItem.boundingBox();
  const secondTargetBox = await secondTargetItem.boundingBox();
  const cursorAlignmentOffset =
    groupedDrag.startX - (secondItemOriginalBox?.x ?? 0);
  expect(
    Math.abs(
      (firstTargetBox?.x ?? 0) -
        ((firstItemOriginalBox?.x ?? 0) + cursorAlignmentOffset),
    ),
  ).toBeLessThan(3);
  expect(Math.abs((secondTargetBox?.x ?? 0) - groupedDrag.startX)).toBeLessThan(
    3,
  );
});
