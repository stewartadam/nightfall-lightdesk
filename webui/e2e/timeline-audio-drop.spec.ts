// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createSilentWavBuffer } from "./audio-fixture";
import { prepareFreshBackendShowfile } from "./backend-showfile";
import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

/** Opens a blank app and stores the timecode and timeline required by the audio test. */
async function openOwnedTimelineAudioApp(
  page: Page,
  backendPort: number,
): Promise<string> {
  await prepareFreshBackendShowfile(backendPort);
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("nightfall.currentShowfileName", "default");
  });
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await expect(page.locator("main#app")).toBeVisible();
  await waitForDockviewApp(page);
  await expect
    .poll(() =>
      page.evaluate(() => ({
        timecodes: Object.keys((window as any).appStores.timecodes.get())
          .length,
        timelines: Object.keys((window as any).appStores.timelines.get())
          .length,
      })),
    )
    .toEqual({ timecodes: 0, timelines: 0 });

  const timelineUid = await page.evaluate(async () => {
    const stores = (window as any).appStores;
    const idBase = Math.floor(800_000 + Math.random() * 100_000);
    const timecodeUid = crypto.randomUUID().replaceAll("-", "");
    const timelineUid = crypto.randomUUID().replaceAll("-", "");
    const timecodeResult = await stores.sendAndAwait({
      module: "TimecodeCommand",
      command: {
        type: "StoreTimecode",
        data: {
          identifiers: {
            id: idBase,
            uid: timecodeUid,
            label: "Timeline Audio Drop Timecode",
          },
          rate: "Fps30",
          source: "Internal",
        },
      },
    });
    if (timecodeResult.outcome.type !== "Succeeded") {
      throw new Error(
        `failed to store timeline audio timecode: ${JSON.stringify(timecodeResult)}`,
      );
    }

    const timelineResult = await stores.sendAndAwait({
      module: "TimelineCommand",
      command: {
        type: "StoreTimeline",
        data: {
          identifiers: {
            id: idBase + 1,
            uid: timelineUid,
            label: "Timeline Audio Drop",
          },
          timecode_uid: timecodeUid,
          timecode_start: { secs: 0, nanos: 0 },
          audio_path: "",
          audio_enabled: true,
          trigger_mode: "FollowTimecode",
          nondeterministic_seek_behavior: "Ignore",
          lookahead: "inherit",
          tracks: [],
          markers: [],
          regions: [],
          bpm: 120,
          beats_per_bar: 4,
          use_beat_grid: false,
          scroll_mode: "free",
        },
      },
    });
    if (timelineResult.outcome.type !== "Succeeded") {
      throw new Error(
        `failed to store timeline audio timeline: ${JSON.stringify(timelineResult)}`,
      );
    }

    return timelineUid;
  });

  await expect
    .poll(() =>
      page.evaluate(
        (uid) => Boolean((window as any).appStores.timelines.get()[uid]),
        timelineUid,
      ),
    )
    .toBe(true);

  await page.evaluate((uid) => {
    const stores = (window as any).appStores;
    const timeline = stores.timelines.get()[uid];
    const api = stores.dockApi.get();
    const panelId = `e2e-timeline-${uid}`;
    api.addPanel({
      id: panelId,
      component: "Timeline",
      title: `Timeline ${timeline.identifiers.id}`,
      params: { initialTimelineUid: uid },
      position: {
        referencePanel: "panel-FixtureGrid",
        direction: "within",
      },
    });
    api.getPanel(panelId)?.focus();
  }, timelineUid);

  return timelineUid;
}

/** Verifies dropped timeline audio is persisted and served from its showfile. */
test("drops audio onto a timeline and serves it from the showfile resource root", async ({
  backendSlot,
  page,
}) => {
  const timelineUid = await openOwnedTimelineAudioApp(
    page,
    backendSlot.backendPort,
  );

  const surface = page.locator(
    `[data-timeline-surface="true"][data-timeline-uid="${timelineUid}"]:visible`,
  );
  await expect(surface).toBeVisible();

  const wavBytes = createSilentWavBuffer();
  const dataTransfer = await page.evaluateHandle(
    ({ bytes, name, type }) => {
      const transfer = new DataTransfer();
      const file = new File([new Uint8Array(bytes)], name, { type });
      transfer.items.add(file);
      return transfer;
    },
    {
      bytes: [...wavBytes],
      name: "drop-audio.wav",
      type: "audio/wav",
    },
  );

  await surface.dispatchEvent("dragenter", { dataTransfer });
  await expect(
    page.locator('[data-timeline-audio-drop-overlay="true"]'),
  ).toBeVisible();
  await surface.dispatchEvent("dragover", { dataTransfer });
  await surface.dispatchEvent("drop", { dataTransfer });

  await expect(
    page.getByText("Updated timeline audio to drop-audio.wav"),
  ).toBeVisible();
  await expect(
    page.locator('[data-timeline-audio-drop-overlay="true"]'),
  ).toBeHidden();

  await page.waitForFunction((uid) => {
    const stores = (window as any).appStores;
    const timeline = stores?.timelines?.get?.()?.[uid];
    return (
      typeof timeline?.audio_path === "string" &&
      timeline.audio_path.startsWith(`timeline-audio/${uid}/`) &&
      timeline.audio_path.endsWith(".wav")
    );
  }, timelineUid);

  const storedAudioPath = await page.evaluate((uid) => {
    const stores = (window as any).appStores;
    return stores.timelines.get()[uid].audio_path as string;
  }, timelineUid);
  const response = await page.request.get(
    `/api/showfiles/current/${storedAudioPath}`,
  );
  expect(response.ok()).toBeTruthy();
  expect(response.headers()["content-type"]).toContain("audio/wav");

  const rangeResponse = await page.request.get(
    `/api/showfiles/current/${storedAudioPath}`,
    { headers: { Range: "bytes=0-7" } },
  );
  expect(rangeResponse.status()).toBe(206);
  expect(rangeResponse.headers()["content-range"]).toMatch(/^bytes 0-7\//);
});
