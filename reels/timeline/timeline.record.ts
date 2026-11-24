// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { join } from "node:path";
import type { Page } from "@playwright/test";
import {
  expect,
  frontendOnlyTest as test,
} from "../../webui/e2e/playwright-fixtures";
import { openDemo, repoRoot, Take } from "../kit/record/take";

/** The sample show's Lo-fi timeline, its soundtrack, and the clip the reel places. */
const TIMELINE_LABEL = "Lo-fi";
const SOUNDTRACK = join(
  repoRoot,
  "crates/app-runtime/assets/sample-audio/lofi.mp3",
);
const TARGET_TRACK = "Snaps";
const CLIP_ID = 16;
const ACTION_QUERY = "Start Clip";
const CLIP_QUERY = "Snap";
const CLIP_OPTION = /Exec 16: Snap/;
/**
 * Timeline seconds the ruler seeks to, showing the look rebuilt at each. The
 * last is the top of the track, where playback starts.
 */
const SEEK_POINTS = [2.45, 1.4, 0.02];
/** Seconds of playback the reel shows. */
const PLAYBACK_SECONDS = 6.5;

/** Reads the timeline's playback position in seconds from its linked timecode. */
async function timelineSeconds(
  page: Page,
  timelineUid: string,
): Promise<number> {
  return page.evaluate((uid) => {
    const stores = (window as any).appStores;
    const timeline = stores.timelines.get()[uid];
    const time =
      stores.timecodes.get()[timeline.timecode_uid]?.[1]?.current_time;
    return time ? time.secs + time.nanos / 1e9 : 0;
  }, timelineUid);
}

/** Finds the uid of the timeline labelled `label` once the demo show has loaded it. */
async function timelineUidFor(page: Page, label: string): Promise<string> {
  await expect
    .poll(
      () =>
        page.evaluate(
          (label) =>
            Object.values((window as any).appStores.timelines.get()).some(
              (timeline: any) => timeline.identifiers.label === label,
            ),
          label,
        ),
      { timeout: 60_000 },
    )
    .toBe(true);
  return page.evaluate(
    (label) =>
      (Object.values((window as any).appStores.timelines.get()) as any[]).find(
        (timeline) => timeline.identifiers.label === label,
      ).identifiers.uid as string,
    label,
  );
}

/** The uid of the clip with show number `id`. */
async function clipUidFor(page: Page, id: number): Promise<string> {
  return page.evaluate(
    (id) =>
      (Object.values((window as any).appStores.clips.get()) as any[]).find(
        (entry) => entry[0].identifiers.id === id,
      )[0].identifiers.uid as string,
    id,
  );
}

/**
 * Lays out the workspace off camera: the Lo-fi timeline on top, and below it
 * one group holding the 3D view (in front) and the clip list.
 */
async function stageWorkspace(page: Page, timelineUid: string): Promise<void> {
  await page.evaluate((uid) => {
    const api = (window as any).appStores.dockApi.get();
    api.clear();
    const timeline = api.addPanel({
      id: "reel-timeline",
      component: "Timeline",
      title: "Lo-fi",
      params: { initialTimelineUid: uid },
    });
    const visualizer = api.addPanel({
      id: "reel-visualizer",
      component: "Visualizer",
      title: "3D",
      position: { referencePanel: "reel-timeline", direction: "below" },
    });
    api.addPanel({
      id: "reel-clips",
      component: "ClipList",
      title: "Clips",
      position: { referencePanel: "reel-visualizer", direction: "within" },
    });
    visualizer.api.setActive();
    timeline.group.api.setSize({ height: 520 });
    timeline.api.setActive();
  }, timelineUid);
  const surface = page.locator(
    `[data-timeline-surface="true"][data-timeline-uid="${timelineUid}"]`,
  );
  await expect(surface).toBeVisible();
  await page
    .getByRole("combobox", { name: "Timeline scroll mode" })
    .selectOption({ label: "Follow" });
}

/**
 * Frames the rig a little closer than the visualizer's fitted view, so the
 * battens fill the panel's width, and hides the floor grid and its axis labels.
 */
async function frameRig(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const api = (window as any).visualizerApi;
    api.zoomToFit();
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const { position, target } = await api.getCameraState();
    const pull = 0.82;
    api.setCameraState({
      position: {
        x: target.x + (position.x - target.x) * pull,
        y: target.y + (position.y - target.y) * pull,
        z: target.z + (position.z - target.z) * pull,
      },
      target,
    });
  });
  await page.getByRole("button", { name: "Hide Grid (G)" }).click();
}

/** Where a cleared cue sat: its time and a CSS pixel point at its start in its lane. */
interface CueSpot {
  seconds: number;
  x: number;
  y: number;
}

/**
 * Deletes the first two Snap cues on the target track off camera, so the take
 * can put them back, and returns where each one sat.
 */
async function clearOpeningSnaps(
  page: Page,
  timelineUid: string,
  clipUid: string,
): Promise<CueSpot[]> {
  const cues = await page.evaluate(
    ({ uid, clipUid, trackLabel }) => {
      const track = (window as any).appStores.timelines
        .get()
        [uid].tracks.find((candidate: any) => candidate.label === trackLabel);
      return (track.actions as any[])
        .filter(
          (item) =>
            item.action?.id === "clip.start" &&
            item.action.arguments?.clip === clipUid,
        )
        .sort(
          (a, b) =>
            a.position.secs +
            a.position.nanos / 1e9 -
            (b.position.secs + b.position.nanos / 1e9),
        )
        .slice(0, 2)
        .map((item) => ({
          id: item.id as string,
          seconds: item.position.secs + item.position.nanos / 1e9,
        }));
    },
    { uid: timelineUid, clipUid, trackLabel: TARGET_TRACK },
  );
  expect(cues).toHaveLength(2);
  const spots: CueSpot[] = [];
  for (const { id, seconds } of cues) {
    const action = page.locator(
      `[data-timeline-action="true"][data-action-id="${id}"]`,
    );
    await expect(action).toBeVisible();
    const box = await action.boundingBox();
    if (!box) throw new Error(`Snap cue ${id} is not visible`);
    spots.push({ seconds, x: box.x + 2, y: box.y + box.height / 2 });
    await action.click();
    await page.keyboard.press("Delete");
    await expect(action).toHaveCount(0);
  }
  return spots;
}

/** The dock tab titled `title`. */
function dockTab(page: Page, title: string) {
  return page.locator(".dv-tab").filter({ hasText: title }).first();
}

/**
 * Records the timeline reel on the embedded demo: puts back the two opening
 * Snap cues, one through the insert picker and one dragged from the clip list,
 * seeks around to show the 3D view rebuilding the look, then plays the track.
 */
test("record the timeline reel", async ({ page, baseURL }) => {
  test.setTimeout(240_000);
  await openDemo(page, baseURL);
  const timelineUid = await timelineUidFor(page, TIMELINE_LABEL);
  const clipUid = await clipUidFor(page, CLIP_ID);
  await stageWorkspace(page, timelineUid);

  const surface = page.locator(
    `[data-timeline-surface="true"][data-timeline-uid="${timelineUid}"]`,
  );
  const [pickedSpot, draggedSpot] = await clearOpeningSnaps(
    page,
    timelineUid,
    clipUid,
  );
  const ruler = page.locator('[data-timeline-ruler="true"]');
  const rulerBox = await ruler.boundingBox();
  if (!rulerBox) throw new Error("Timeline ruler is not visible");
  // Maps timeline seconds to a point on the ruler, scaled from the two cues.
  const pixelsPerSecond =
    (draggedSpot.x - pickedSpot.x) / (draggedSpot.seconds - pickedSpot.seconds);
  const rulerPoint = (seconds: number) => ({
    x:
      pickedSpot.x +
      (seconds - pickedSpot.seconds) * pixelsPerSecond -
      rulerBox.x,
    y: 14,
  });
  // Seek to the top, and give the visualizer time to load its models.
  await ruler.click({ position: rulerPoint(0.02) });
  await page.waitForTimeout(15_000);
  await frameRig(page);
  await page.mouse.move(360, 260);
  await page.waitForTimeout(4_000);

  const take = new Take(page, "timeline");
  await take.start();
  await page.waitForTimeout(900);
  await take.mark("begin");
  await page.waitForTimeout(1_800);

  // Insert: a Start Clip for Snap on the first cleared beat, from the picker.
  const snapCues = surface
    .locator('[data-timeline-action="true"]')
    .filter({ hasText: CLIP_OPTION });
  const snapsBefore = await snapCues.count();
  const lanes = surface.locator('[data-timeline-track-lane="true"]');
  // The lane the cleared cues sat in.
  const laneIndex = await lanes.evaluateAll(
    (elements, y) =>
      elements.findIndex((element) => {
        const rect = element.getBoundingClientRect();
        return rect.top <= y && y <= rect.bottom;
      }),
    pickedSpot.y,
  );
  expect(laneIndex).toBeGreaterThanOrEqual(0);
  const targetLane = lanes.nth(laneIndex);
  const laneBox = await targetLane.boundingBox();
  if (!laneBox) throw new Error("Target lane is not visible");
  await take.glideTo(targetLane, {
    x: pickedSpot.x - laneBox.x,
    y: laneBox.height / 2,
  });
  await take.mark("insert-aim");
  await page.waitForTimeout(900);
  await take.click();
  await page.waitForTimeout(350);
  await page.keyboard.press("i");
  const picker = page.locator('[data-component="InsertActionPicker"]');
  await expect(picker).toBeVisible();
  await page.waitForTimeout(150);
  await take.mark("picker-open", picker);
  await page
    .getByPlaceholder("Insert action...")
    .pressSequentially(ACTION_QUERY, { delay: 75 });
  await page.waitForTimeout(350);
  await take.glideAndClick(
    page.getByRole("button", { name: /Start Clip/ }).first(),
  );
  const targetFilter = page.getByPlaceholder(/Select target for Start Clip/);
  await expect(targetFilter).toBeFocused();
  await page.waitForTimeout(250);
  await targetFilter.pressSequentially(CLIP_QUERY, { delay: 75 });
  await page.waitForTimeout(400);
  await take.glideAndClick(
    page.getByRole("button", { name: CLIP_OPTION }).first(),
  );
  await expect(picker).toBeHidden();
  await expect.poll(() => snapCues.count()).toBe(snapsBefore + 1);
  await take.mark("inserted");
  await page.waitForTimeout(1_200);

  // Arrange: drag Snap from the clip list onto the second cleared beat.
  await take.glideAndClick(dockTab(page, "Clips"));
  await take.mark("clips-tab");
  const card = page.locator(`[data-crud-select-id="${clipUid}"]`).first();
  await expect(card).toBeVisible();
  await page.waitForTimeout(700);
  await take.glideTo(card);
  await page.waitForTimeout(300);
  await take.dragTo(draggedSpot, 1_400);
  await expect.poll(() => snapCues.count()).toBe(snapsBefore + 2);
  await take.mark("dragged");
  await page.waitForTimeout(900);
  await take.glideAndClick(dockTab(page, "3D"));
  await page.waitForTimeout(800);

  // Seek: the 3D view rebuilds the look at each point on the ruler.
  await take.mark("seek");
  for (const seconds of SEEK_POINTS) {
    await take.glideAndClick(ruler, rulerPoint(seconds));
    await page.waitForTimeout(1_400);
  }

  // Play from the top with the music.
  const play = page.getByRole("button", { name: "Play timeline" });
  await take.glideTo(play);
  await page.waitForTimeout(150);
  const beforePlay = await timelineSeconds(page, timelineUid);
  await take.click();
  // Mark playback when the timeline actually moves, back-dated by how far it
  // got, so the soundtrack in the edit lands on the playhead rather than on
  // the click.
  await expect
    .poll(() => timelineSeconds(page, timelineUid), {
      intervals: [10],
      timeout: 10_000,
    })
    .toBeGreaterThan(beforePlay);
  const movedTo = await timelineSeconds(page, timelineUid);
  await take.mark("play", undefined, {
    value: beforePlay,
    backdate: movedTo - beforePlay,
  });
  // Park the cursor on empty space below the track headers, clear of tooltips.
  await page.waitForTimeout(300);
  await take.glideTo(page.getByRole("button", { name: "+ Add Track" }), {
    x: 40,
    y: 48,
  });
  const remaining =
    PLAYBACK_SECONDS -
    ((await timelineSeconds(page, timelineUid)) - beforePlay);
  await page.waitForTimeout(Math.max(0, remaining * 1000));
  await take.mark("finish");
  await page.waitForTimeout(600);
  await take.finish({ soundtrack: SOUNDTRACK });
  await page.getByRole("button", { name: "Stop timeline" }).click();
});
