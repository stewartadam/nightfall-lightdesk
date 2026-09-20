// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

const SEQUENCE_GOTO_CUE_ONE_UID = "10000000000040008000000000000001";
const SEQUENCE_GOTO_CUE_TWO_UID = "10000000000040008000000000000002";
const SEQUENCE_GOTO_SEQUENCE_UID = "20000000000040008000000000000001";
const SEQUENCE_GOTO_CLIP_UID = "30000000000040008000000000000001";
const CLIP_RATE_UID = "40000000000040008000000000000001";
const SHOWFILE_NAME_PREFIX = "timeline-insert-action-picker";

/** Opens an isolated showfile and creates one backend-owned timeline fixture. */
async function openOwnedTimelineApp(page: Page): Promise<string> {
  const testInfo = test.info();
  const showfileName = `${SHOWFILE_NAME_PREFIX}-${testInfo.workerIndex}-${testInfo.retry}-${Date.now()}`;
  await page.addInitScript(() => {
    window.localStorage.removeItem("nightfall.currentShowfileName");
    window.localStorage.removeItem("nightfall.e2eAutoOpenStartupShowfile");
  });
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  const openDialog = page.getByRole("dialog", { name: "Open Showfile" });
  await expect(openDialog).toBeVisible();
  await openDialog.getByRole("button", { name: "New showfile" }).click();
  const newDialog = page.getByRole("dialog", { name: "New Showfile" });
  await expect(newDialog).toBeVisible();
  await newDialog.getByLabel("Show name").fill(showfileName);
  await newDialog.getByRole("button", { name: "Create Show" }).click();
  await expect(newDialog).not.toBeVisible({ timeout: 10_000 });
  await waitForDockviewApp(page);

  const timelineUid = await page.evaluate(async () => {
    const stores = (window as any).appStores;
    const timelineUid = crypto.randomUUID().replaceAll("-", "");
    const timecodeUid = crypto.randomUUID().replaceAll("-", "");
    const existingIds = [
      ...Object.values(stores.timelines.get()).map(
        (timeline: any) => timeline.identifiers.id,
      ),
      ...Object.values(stores.timecodes.get()).map(
        (timecode: any) => timecode[0].identifiers.id,
      ),
    ];
    const id = Math.max(0, ...existingIds) + 1;
    const label = `Insert Picker Timeline ${id}`;

    await stores.send({
      module: "TimecodeCommand",
      command: {
        type: "StoreTimecode",
        data: {
          identifiers: { id, uid: timecodeUid, label },
          rate: "Fps30",
          source: "Internal",
        },
      },
    });
    await stores.send({
      module: "TimelineCommand",
      command: {
        type: "StoreTimeline",
        data: {
          identifiers: { id, uid: timelineUid, label },
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
              id: `e2e-insert-picker-base-track-${timelineUid}`,
              label: "Insert Picker Target",
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
      },
    });
    return timelineUid;
  });

  await expect
    .poll(() =>
      page.evaluate((uid) => {
        const stores = (window as any).appStores;
        const timeline = stores.timelines.get()[uid];
        return Boolean(
          timeline && stores.timecodes.get()[timeline.timecode_uid]?.[0],
        );
      }, timelineUid),
    )
    .toBe(true);

  await page.evaluate((uid) => {
    const stores = (window as any).appStores;
    const api = stores.dockApi.get();
    const timeline = stores.timelines.get()[uid];
    const panel = api.addPanel({
      id: `e2e-insert-picker-timeline-${uid}`,
      component: "Timeline",
      title: timeline.identifiers.label,
      params: { initialTimelineUid: uid },
      position: {
        referencePanel: "panel-FixtureGrid",
        direction: "within",
      },
    });
    panel.api.setActive();
    panel.focus();
  }, timelineUid);

  return timelineUid;
}

/** Seeds enough clip targets to force the insert picker target list to scroll. */
async function seedScrollableClipTargets(page: Page) {
  await page.evaluate(() => {
    const clips: Record<string, unknown> = {};
    for (let index = 0; index < 32; index += 1) {
      const uid = `e2e-insert-picker-clip-${index}`;
      clips[uid] = [
        {
          identifiers: {
            id: index === 7 ? 7 : 9000 + index,
            uid,
            label: `Insert Picker Clip ${String(index).padStart(2, "0")}`,
          },
          priority: 0,
          options: { auto_release: false, deactivate_on_sequence_end: false },
        },
        false,
      ];
    }
    (window as any).appStores.clips.set(clips);
  });
}

/** Seeds a sequence clip with two cues for jump-to-cue insertion tests. */
async function seedSequenceGotoTargets(page: Page) {
  await page.evaluate(
    (uids) => {
      const stores = (window as any).appStores;

      stores.cues.set({
        ...stores.cues.get(),
        [uids.cueOneUid]: {
          identifiers: { id: 1, uid: uids.cueOneUid, label: "Preset" },
          trigger: "Manual",
          transitions: {},
          transitions_by_attribute: {},
          instructions: [],
          parts: [],
          tracking_flags: { __Composed__: 7 },
        },
        [uids.cueTwoUid]: {
          identifiers: {
            id: 2,
            uid: uids.cueTwoUid,
            label: "E2E Unique Goto",
          },
          trigger: "Manual",
          transitions: {},
          transitions_by_attribute: {},
          instructions: [],
          parts: [],
          tracking_flags: { __Composed__: 7 },
        },
      });
      stores.sequences.set({
        ...stores.sequences.get(),
        [uids.sequenceUid]: {
          identifiers: { id: 1, uid: uids.sequenceUid, label: "Main" },
          steps: [uids.cueOneUid, uids.cueTwoUid],
          wrap: false,
          release_on_start: false,
          setup_cue: {
            identifiers: {
              id: 0,
              uid: "70000000000040008000000000000001",
              label: "Setup",
            },
            trigger: "Manual",
            transitions: {},
            transitions_by_attribute: {},
            instructions: [],
            parts: [],
            tracking_flags: { __Composed__: 7 },
          },
          release_cue: {
            identifiers: {
              id: 0,
              uid: "70000000000040008000000000000002",
              label: "Release",
            },
            trigger: "Manual",
            transitions: {},
            transitions_by_attribute: {},
            instructions: [],
            parts: [],
            tracking_flags: { __Composed__: 7 },
          },
          default_timing: {
            delay_in: { type: "Fixed", data: { secs: 0, nanos: 0 } },
            fade_in: { type: "Fixed", data: { secs: 0, nanos: 0 } },
            curve_in: "Linear",
            delay_out: { type: "Fixed", data: { secs: 0, nanos: 0 } },
            fade_out: { type: "Fixed", data: { secs: 0, nanos: 0 } },
            curve_out: "Linear",
          },
          tracking_mode: { type: "Flags", data: { __Composed__: 7 } },
        },
      });
      stores.clips.set({
        ...stores.clips.get(),
        [uids.clipUid]: [
          {
            identifiers: {
              id: 9101,
              uid: uids.clipUid,
              label: "Main Playback",
            },
            source: { type: "Sequence", data: uids.sequenceUid },
            priority: 0,
            options: {
              auto_release: false,
              deactivate_on_sequence_end: false,
            },
          },
          false,
        ],
      });
      stores.cueDefinitionsLoaded.set(true);
      stores.sequenceDefinitionsLoaded.set(true);
    },
    {
      cueOneUid: SEQUENCE_GOTO_CUE_ONE_UID,
      cueTwoUid: SEQUENCE_GOTO_CUE_TWO_UID,
      sequenceUid: SEQUENCE_GOTO_SEQUENCE_UID,
      clipUid: SEQUENCE_GOTO_CLIP_UID,
    },
  );
}

/** Seeds a clip target for rate action insertion tests. */
async function seedClipRateTarget(page: Page) {
  await page.evaluate((clipUid) => {
    const stores = (window as any).appStores;
    stores.clips.set({
      ...stores.clips.get(),
      [clipUid]: [
        {
          identifiers: {
            id: 9201,
            uid: clipUid,
            label: "E2E Rate Target",
          },
          priority: 0,
          options: { auto_release: false, deactivate_on_sequence_end: false },
        },
        false,
      ],
    });
  }, CLIP_RATE_UID);
}

/** Reads the inserted sequence goto action for the seeded clip. */
async function insertedSequenceGotoAction(page: Page) {
  return page.evaluate((clipUid) => {
    const stores = (window as any).appStores;
    const timelines = stores.timelines.get();
    for (const timeline of Object.values(timelines) as any[]) {
      for (const track of timeline.tracks ?? []) {
        for (const item of track.actions ?? []) {
          if (
            item.action?.type === "JumpToCue" &&
            item.action.data?.uid === clipUid
          ) {
            return item.action.data;
          }
        }
      }
    }
    return null;
  }, SEQUENCE_GOTO_CLIP_UID);
}

/** Reads the inserted clip rate action for the seeded clip. */
async function insertedClipRateAction(page: Page) {
  return page.evaluate((clipUid) => {
    const stores = (window as any).appStores;
    const timelines = stores.timelines.get();
    for (const timeline of Object.values(timelines) as any[]) {
      for (const track of timeline.tracks ?? []) {
        for (const item of track.actions ?? []) {
          if (
            item.action?.type === "SetClipRate" &&
            item.action.data?.uid === clipUid
          ) {
            return item.action.data;
          }
        }
      }
    }
    return null;
  }, CLIP_RATE_UID);
}

/** Reads whether a desk eval command exists on any timeline action. */
async function hasDeskEvalCommand(page: Page, expectedCommand: string) {
  return page.evaluate((command) => {
    const stores = (window as any).appStores;
    const timelines = stores.timelines.get();
    for (const timeline of Object.values(timelines) as any[]) {
      for (const track of timeline.tracks ?? []) {
        for (const item of track.actions ?? []) {
          if (
            item.action?.type === "DeskEval" &&
            item.action.data === command
          ) {
            return true;
          }
        }
      }
    }
    return false;
  }, expectedCommand);
}

/** Reads the track ids containing desk eval items for a specific command. */
async function deskEvalCommandTrackIds(page: Page, expectedCommand: string) {
  return page.evaluate((command) => {
    const stores = (window as any).appStores;
    const timelines = stores.timelines.get();
    const trackIds: string[] = [];
    for (const timeline of Object.values(timelines) as any[]) {
      for (const track of timeline.tracks ?? []) {
        if (
          track.actions?.some(
            (item: any) =>
              item.action?.type === "DeskEval" && item.action.data === command,
          )
        ) {
          trackIds.push(track.id);
        }
      }
    }
    return trackIds;
  }, expectedCommand);
}

/** Reads whether the selected insert picker option is inside the scrollable viewport. */
async function selectedOptionIsVisible(page: Page) {
  return page.evaluate(() => {
    const selected = document.querySelector<HTMLElement>(
      '[data-insert-action-option-selected="true"]',
    );
    const list = document.querySelector<HTMLElement>(
      '[data-insert-action-options-list="true"]',
    );
    if (!selected || !list) return false;

    const selectedRect = selected.getBoundingClientRect();
    const listRect = list.getBoundingClientRect();
    return (
      selectedRect.top >= listRect.top && selectedRect.bottom <= listRect.bottom
    );
  });
}

/** Verifies arrow-key navigation scrolls the insert action target list. */
test("insert action picker keeps keyboard selection visible", async ({
  page,
}, testInfo) => {
  const timelineUid = await openOwnedTimelineApp(page);
  /** Keeps the tested timeline visible when the workspace narrows. */
  await page.evaluate((uid) => {
    const api = (window as any).appStores.dockApi.get();
    for (const panel of [...api.panels]) {
      if (panel.id !== `e2e-insert-picker-timeline-${uid}`) panel.api.close();
    }
  }, timelineUid);
  await seedScrollableClipTargets(page);
  const timelineSurface = page.locator(
    `[data-timeline-surface="true"][data-timeline-uid="${timelineUid}"]`,
  );
  await expect(timelineSurface).toBeVisible();
  const firstLane = timelineSurface
    .locator('[data-timeline-track-lane="true"]')
    .first();
  await expect(firstLane).toBeVisible();
  await firstLane.click({ position: { x: 80, y: 18 } });

  await page.keyboard.press("i");
  await page.getByPlaceholder("Insert action...").fill("Start Clip");
  await page.keyboard.press("Enter");
  await expect(
    page.getByPlaceholder(/Select target for Start Clip/),
  ).toBeVisible();

  for (let index = 0; index < 24; index += 1) {
    await page.keyboard.press("ArrowDown");
  }

  await expect
    .poll(() => selectedOptionIsVisible(page), {
      message: "selected insert picker target should stay in view",
    })
    .toBe(true);
  const picker = page.locator('[data-component="InsertActionPicker"]');
  await expect(picker).toHaveClass(/nf-search-picker/);
  await expect(picker.locator('[data-edge="top"]')).toHaveAttribute(
    "data-visible",
    "true",
  );
  await picker.screenshot({
    path: testInfo.outputPath("shared-insert-picker.png"),
  });
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(picker).toBeHidden();
  await page.setViewportSize({ width: 390, height: 720 });
  await timelineSurface.click();
  await page.keyboard.press("i");
  await expect(picker).toBeVisible();
  const box = await picker.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  expect(box!.y + box!.height).toBeLessThanOrEqual(720);
  await picker.screenshot({
    path: testInfo.outputPath("shared-insert-picker-narrow.png"),
  });
  await page.keyboard.press("Escape");
});

/** Verifies pointer action selection keeps the target filter ready for typing. */
test("insert action picker keeps filter focused after pointer selection", async ({
  page,
}) => {
  const timelineUid = await openOwnedTimelineApp(page);
  await seedScrollableClipTargets(page);
  const timelineSurface = page.locator(
    `[data-timeline-surface="true"][data-timeline-uid="${timelineUid}"]`,
  );
  await expect(timelineSurface).toBeVisible();
  await timelineSurface.click();

  await page.keyboard.press("i");
  await page.getByPlaceholder("Insert action...").fill("Start Clip");
  await page.getByRole("button", { name: /Start Clip/ }).click();

  const targetFilter = page.getByPlaceholder(/Select target for Start Clip/);
  await expect(targetFilter).toBeFocused();
  await page.keyboard.type("7");
  await expect(targetFilter).toHaveValue("7");
  await expect(page.getByRole("button", { name: /Exec 7:/ })).toBeVisible();
});

/** Verifies Jump To Cue lets operators choose a concrete sequence cue target. */
test("insert action picker inserts sequence goto target with cue index", async ({
  page,
}) => {
  const timelineUid = await openOwnedTimelineApp(page);
  const timelineSurface = page.locator(
    `[data-timeline-surface="true"][data-timeline-uid="${timelineUid}"]`,
  );
  await expect(timelineSurface).toBeVisible();
  await seedSequenceGotoTargets(page);
  await timelineSurface.click();

  await page.keyboard.press("i");
  await page.getByPlaceholder("Insert action...").fill("Jump To Cue");
  await page.keyboard.press("Enter");

  const targetFilter = page.getByPlaceholder(/Select target for Jump To Cue/);
  await expect(targetFilter).toBeVisible();
  await targetFilter.fill("E2E Unique Goto");
  await page.keyboard.press("Enter");

  await expect(
    timelineSurface.locator('[data-timeline-action="true"]').filter({
      hasText: /Seq 1\.2: E2E Unique Goto via Exec 9101/,
    }),
  ).toBeVisible();
  await expect
    .poll(() => insertedSequenceGotoAction(page))
    .toEqual({ uid: SEQUENCE_GOTO_CLIP_UID, cue_index: 2 });
});

/** Verifies Set Clip Rate insertion collects a target and rate multiplier. */
test("insert action picker inserts clip rate actions", async ({ page }) => {
  const timelineUid = await openOwnedTimelineApp(page);
  const timelineSurface = page.locator(
    `[data-timeline-surface="true"][data-timeline-uid="${timelineUid}"]`,
  );
  await expect(timelineSurface).toBeVisible();
  await seedClipRateTarget(page);
  await timelineSurface.click();

  await page.keyboard.press("i");
  await page.getByPlaceholder("Insert action...").fill("Set Clip Rate");
  await page.keyboard.press("Enter");

  const targetFilter = page.getByPlaceholder(/Select target for Set Clip Rate/);
  await expect(targetFilter).toBeVisible();
  await targetFilter.fill("E2E Rate Target");
  await page.keyboard.press("Enter");

  const rateInput = page.getByPlaceholder("Rate multiplier...");
  await expect(rateInput).toBeVisible();
  await rateInput.fill("2.5");
  await page.keyboard.press("Enter");

  await expect(
    timelineSurface.locator('[data-timeline-action="true"]').filter({
      hasText: /Rate 2\.50x: E2E Rate Target/,
    }),
  ).toBeVisible();
  await expect
    .poll(() => insertedClipRateAction(page))
    .toEqual({ uid: CLIP_RATE_UID, rate: 2.5 });
});

/** Keeps retained timeline portals and keyboard handlers scoped to their active layout. */
test("suspends timeline popouts across layouts with duplicate panel IDs", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const timelineUid = await openOwnedTimelineApp(page);
  await page.evaluate(async () => {
    const { createNamedLayout } = await import("/lib/layout-management.ts");
    const layout = await createNamedLayout(
      (window as any).appStores.dockApi.get(),
      "Duplicate timeline",
    );
    if (!layout) throw new Error("Could not create duplicate timeline layout");
  });
  const surface = page.locator(
    `[data-workspace-active="true"] [data-timeline-surface="true"][data-timeline-uid="${timelineUid}"]`,
  );
  const picker = page.locator('[data-component="InsertActionPicker"]');
  const jump = page.locator('[data-timeline-popout="goto"]');

  /** Recalls a layout without an outside click dismissing the popout under test. */
  const recall = async (slot: number) => {
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
    await page.keyboard.press(`F${slot}`);
    await expect(
      page.getByRole("button", { name: new RegExp(`^Layout ${slot}:`) }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(surface).toBeVisible();
  };

  /** Opens the jump picker on the active copy of the shared timeline panel. */
  const openJump = async () => {
    await surface.click({ position: { x: 320, y: 120 } });
    await page.keyboard.press("ControlOrMeta+G");
    await expect(jump).toBeVisible();
    return jump.getByLabel("Timeline jump target");
  };

  await surface
    .locator('[data-timeline-track-lane="true"]')
    .first()
    .click({ button: "right", position: { x: 80, y: 18 } });
  await page
    .locator('[data-menu-kind="context"]')
    .getByRole("menuitem", { name: "Insert Action..." })
    .click();
  await page.getByPlaceholder("Insert action...").fill("Desk Eval");
  await page.keyboard.press("Enter");
  const command = "group 1 at 42";
  await page.getByPlaceholder("Desk command...").fill(command);
  await recall(2);
  await expect(picker).not.toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  expect(await hasDeskEvalCommand(page, command)).toBe(false);
  await page.screenshot({
    path: testInfo.outputPath("inactive-insert-picker.png"),
  });

  await recall(1);
  await expect(picker).toBeVisible();
  await expect(page.getByPlaceholder("Desk command...")).toHaveValue(command);
  await page.keyboard.press("Enter");
  await expect.poll(() => hasDeskEvalCommand(page, command)).toBe(true);
  await expect(picker).toHaveCount(0);

  await (await openJump()).fill("t 5");
  await recall(2);
  await expect(jump).toHaveCount(0);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  await (await openJump()).fill("t 9");
  await recall(1);
  await expect(jump).toHaveCount(1);
  await expect(jump.getByLabel("Timeline jump target")).toHaveValue("t 5");
  await recall(2);
  await expect(jump).toHaveCount(1);
  await expect(jump.getByLabel("Timeline jump target")).toHaveValue("t 9");
  await page.screenshot({
    path: testInfo.outputPath("active-jump-picker.png"),
  });
  await page.keyboard.press("Escape");
  await expect(jump).toHaveCount(0);
});

/** Verifies Desk Eval inserts a command-string timeline action without a target list. */
test("insert action picker inserts desk eval command actions", async ({
  page,
}) => {
  const timelineUid = await openOwnedTimelineApp(page);
  const timelineSurface = page.locator(
    `[data-timeline-surface="true"][data-timeline-uid="${timelineUid}"]`,
  );
  await expect(timelineSurface).toBeVisible();
  const trackId = await page.evaluate((uid) => {
    const stores = (window as any).appStores;
    const timeline = stores.timelines.get()[uid];
    if (!timeline) throw new Error(`Timeline ${uid} was not available`);
    const id = `e2e-desk-eval-track-${Date.now()}`;
    stores.timelines.setKey(uid, {
      ...timeline,
      tracks: [
        ...timeline.tracks,
        {
          id,
          label: "E2E Desk Eval Insert",
          muted: false,
          solo: false,
          expanded: false,
          actions: [],
          automation_lanes: [],
        },
      ],
    });
    return id;
  }, timelineUid);
  const targetLane = timelineSurface.locator(
    `[data-timeline-track-lane="true"][data-track-id="${trackId}"]`,
  );
  await expect(targetLane).toBeVisible();
  await targetLane.click({ button: "right", position: { x: 80, y: 18 } });

  const menu = page.locator('[data-menu-kind="context"]');
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "Insert Action..." }).click();
  await page.getByPlaceholder("Insert action...").fill("Desk Eval");
  await page.keyboard.press("Enter");

  const commandInput = page.getByPlaceholder("Desk command...");
  await expect(commandInput).toBeVisible();
  const command = `group 1 at ${Date.now()}`;
  await commandInput.fill(command);
  await page.keyboard.press("Enter");

  await expect(
    timelineSurface
      .locator('[data-timeline-action="true"]')
      .filter({
        hasText: `Eval: ${command}`,
      })
      .first(),
  ).toBeVisible();
  await expect.poll(() => hasDeskEvalCommand(page, command)).toBe(true);
});

/** Verifies keyboard insertion targets the selected timeline track. */
test("keyboard insert action uses the selected track target", async ({
  page,
}) => {
  const timelineUid = await openOwnedTimelineApp(page);
  const timelineSurface = page.locator(
    `[data-timeline-surface="true"][data-timeline-uid="${timelineUid}"]`,
  );
  await expect(timelineSurface).toBeVisible();

  const { targetTrackId, targetTrackLabel } = await page.evaluate((uid) => {
    const stores = (window as any).appStores;
    const timeline = stores.timelines.get()[uid];
    if (!timeline) throw new Error(`Timeline ${uid} was not available`);
    const id = `e2e-selected-insert-track-${Date.now()}`;
    const label = "E2E Selected Insert Target";
    stores.timelines.setKey(uid, {
      ...timeline,
      tracks: [
        ...timeline.tracks,
        {
          id,
          label,
          muted: false,
          solo: false,
          expanded: false,
          actions: [],
          automation_lanes: [],
        },
      ],
    });
    return { targetTrackId: id, targetTrackLabel: label };
  }, timelineUid);

  const targetHeader = timelineSurface.locator(
    `[data-timeline-track-header="true"][data-track-id="${targetTrackId}"]`,
  );
  const targetRow = timelineSurface.locator(
    `[data-timeline-track-row="true"][data-track-id="${targetTrackId}"]`,
  );
  await expect(targetHeader).toBeVisible();
  await targetHeader.getByRole("button", { name: targetTrackLabel }).click();
  await expect(targetRow).toHaveAttribute("data-record-target", "true");

  await page.keyboard.press("i");
  await page.getByPlaceholder("Insert action...").fill("Desk Eval");
  await page.keyboard.press("Enter");

  const commandInput = page.getByPlaceholder("Desk command...");
  await expect(commandInput).toBeVisible();
  const command = `group 2 at ${Date.now()}`;
  await commandInput.fill(command);
  await page.keyboard.press("Enter");

  await expect(
    timelineSurface
      .locator(
        `[data-timeline-action="true"][data-track-id="${targetTrackId}"]`,
      )
      .filter({ hasText: `Eval: ${command}` }),
  ).toBeVisible();
  await expect
    .poll(() => deskEvalCommandTrackIds(page, command))
    .toEqual([targetTrackId]);
});

/** Verifies selected actions take precedence over a previous track target. */
test("keyboard insert action uses the selected action track first", async ({
  page,
}) => {
  const timelineUid = await openOwnedTimelineApp(page);
  const timelineSurface = page.locator(
    `[data-timeline-surface="true"][data-timeline-uid="${timelineUid}"]`,
  );
  await expect(timelineSurface).toBeVisible();

  const { staleTargetTrackId, selectedItemTrackId, selectedItemId } =
    await page.evaluate((uid) => {
      const stores = (window as any).appStores;
      const timeline = stores.timelines.get()[uid];
      if (!timeline) throw new Error(`Timeline ${uid} was not available`);
      const staleTargetTrackId = `e2e-stale-target-track-${Date.now()}`;
      const selectedItemTrackId = `e2e-selected-item-track-${Date.now()}`;
      const selectedItemId = `e2e-selected-item-${Date.now()}`;
      stores.timelines.setKey(uid, {
        ...timeline,
        tracks: [
          ...timeline.tracks,
          {
            id: staleTargetTrackId,
            label: "E2E Stale Insert Target",
            muted: false,
            solo: false,
            expanded: false,
            actions: [],
            automation_lanes: [],
          },
          {
            id: selectedItemTrackId,
            label: "E2E Selected Action Track",
            muted: false,
            solo: false,
            expanded: false,
            actions: [
              {
                id: selectedItemId,
                label: "Selected Insert Anchor",
                position: { secs: 1, nanos: 0 },
                duration: { secs: 1, nanos: 0 },
                action: { type: "DeskEval", data: "group 1 at 10" },
              },
            ],
            automation_lanes: [],
          },
        ],
      });
      return { staleTargetTrackId, selectedItemTrackId, selectedItemId };
    }, timelineUid);

  const staleTargetHeader = timelineSurface.locator(
    `[data-timeline-track-header="true"][data-track-id="${staleTargetTrackId}"]`,
  );
  const staleTargetRow = timelineSurface.locator(
    `[data-timeline-track-row="true"][data-track-id="${staleTargetTrackId}"]`,
  );
  await expect(staleTargetHeader).toBeVisible();
  await staleTargetHeader
    .getByRole("button", { name: "E2E Stale Insert Target" })
    .click();
  await expect(staleTargetRow).toHaveAttribute("data-record-target", "true");

  await timelineSurface
    .locator(
      `[data-timeline-action="true"][data-track-id="${selectedItemTrackId}"][data-action-id="${selectedItemId}"]`,
    )
    .click();

  await page.keyboard.press("i");
  await page.getByPlaceholder("Insert action...").fill("Desk Eval");
  await page.keyboard.press("Enter");

  const commandInput = page.getByPlaceholder("Desk command...");
  await expect(commandInput).toBeVisible();
  const command = `group 3 at ${Date.now()}`;
  await commandInput.fill(command);
  await page.keyboard.press("Enter");

  await expect(
    timelineSurface
      .locator(
        `[data-timeline-action="true"][data-track-id="${selectedItemTrackId}"]`,
      )
      .filter({ hasText: `Eval: ${command}` }),
  ).toBeVisible();
  await expect
    .poll(() => deskEvalCommandTrackIds(page, command))
    .toEqual([selectedItemTrackId]);
});

/** Verifies compact footer alignment and zoom/scroll interactions at normal and narrow widths. */
test("timeline footer uses consistent compact sizing", async ({ page }) => {
  await openOwnedTimelineApp(page);
  const footer = page.locator('[data-timeline-footer-toolbar="true"]');
  await expect(footer).toBeVisible();
  const zoom = footer.getByRole("textbox", { name: "Timeline zoom" });
  await zoom.fill("125");
  await zoom.press("Tab");
  await expect(zoom).toHaveValue("125");
  await footer.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect(zoom).toHaveValue("138");
  await footer
    .getByRole("combobox", { name: "Timeline scroll mode" })
    .selectOption("follow");
  const toolbar = page.locator('[data-timeline-toolbar="true"]');
  await expect(toolbar.locator(".nf-toolbar-separator")).toHaveCount(4);
  const snap = toolbar.getByRole("button", { name: "Snap", exact: true });
  await expect(snap).toHaveText("");
  await snap.click();
  await expect(snap).toHaveAttribute("aria-pressed", "true");
  const bpm = toolbar.getByRole("switch", { name: "Use beatgrid" });
  await expect(bpm).not.toBeChecked();
  await expect(toolbar.locator(".nf-switch-label")).toHaveText("BPM");
  await bpm.click();
  await expect(bpm).toBeChecked();
  await expect(toolbar.locator(".nf-switch-label")).toHaveText("BPM");
  const heights = await footer
    .locator(".nf-input-group, select, .timeline-position-display")
    .evaluateAll(
      /** Measures the visible controls without relying on their CSS declarations. */
      (elements) =>
        elements.map((element) => element.getBoundingClientRect().height),
    );
  expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(2);
  await page.screenshot({
    path: test.info().outputPath("timeline-footer.png"),
  });
  await page.setViewportSize({ width: 700, height: 700 });
  await expect(footer.getByText("SMPTE", { exact: true })).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("timeline-footer-narrow.png"),
  });
});
