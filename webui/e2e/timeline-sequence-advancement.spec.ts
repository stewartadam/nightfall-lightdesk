// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

test.use({ sampleDataOnly: true, viewport: { width: 1920, height: 1080 } });

/** Exercises all three Lo-fi Go markers through real-time playback and the engine. */
test("Lo-fi playback advances its sequence through cue four", async ({
  page,
}, testInfo) => {
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  await page.waitForFunction(() =>
    Object.values((window as any).appStores?.timelines?.get() ?? {}).some(
      (timeline: any) => timeline.identifiers.label === "Lo-fi",
    ),
  );
  const timelineUid = await page.evaluate(() => {
    const stores = (window as any).appStores;
    const timeline = Object.values(stores.timelines.get()).find(
      (entry: any) => entry.identifiers.label === "Lo-fi",
    ) as any;
    const api = stores.dockApi.get();
    api.addPanel({
      id: "lofi-playback",
      component: "Timeline",
      title: "Lo-fi playback",
      params: { initialTimelineUid: timeline.identifiers.uid },
    });
    api.addPanel({
      id: "lofi-layers",
      component: "LayerStack",
      title: "Live sequence",
      position: { referencePanel: "lofi-playback", direction: "right" },
    });
    (window as any).lofiCuePositions = [];
    stores.activeInstances.subscribe((instances: Record<string, any>) => {
      for (const instance of Object.values(instances)) {
        const position = instance.status?.position;
        if (instance.bound_clip_id === 1 && position?.type === "Sequence") {
          const positions = (window as any).lofiCuePositions as number[];
          const cue = position.data.current_position;
          if (positions.at(-1) !== cue) positions.push(cue);
        }
      }
    });
    return timeline.identifiers.uid as string;
  });
  const surface = page.locator(
    `[data-timeline-surface="true"][data-timeline-uid="${timelineUid}"]:visible`,
  );
  await expect(surface).toBeVisible();
  try {
    await surface
      .getByRole("button", { name: "Play timeline", exact: true })
      .click();
    await expect
      .poll(() => page.evaluate(() => (window as any).lofiCuePositions), {
        intervals: [25],
      })
      .toEqual([1, 2, 3, 4]);
    await surface
      .getByRole("button", { name: "Pause timeline", exact: true })
      .click();
    await expect
      .poll(() =>
        page.evaluate(() =>
          Object.values((window as any).appStores.activeInstances.get()).some(
            (instance: any) =>
              instance.bound_clip_id === 1 &&
              instance.is_paused &&
              instance.status?.position?.data?.current_position === 4,
          ),
        ),
      )
      .toBe(true);
    await page.screenshot({ path: testInfo.outputPath("lofi-cue-four.png") });
  } finally {
    await surface
      .getByRole("button", { name: "Stop timeline", exact: true })
      .click();
  }
});
