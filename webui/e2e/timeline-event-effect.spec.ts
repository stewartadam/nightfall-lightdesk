// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { harnessPageUrl } from "./app-hooks";
import { expect, frontendOnlyTest as test } from "./playwright-fixtures";

/**
 * Verifies a timeline command is sent once per UI event: replacing or re-adding the timeline's
 * store entry (as a resync or reload does) must not send the last event's command again.
 */
test("timeline event commands are not re-sent when the timeline entry is replaced", async ({
  page,
}) => {
  await page.goto(harnessPageUrl("timeline-event-effect"));
  const sends = await page.evaluate(async () => {
    const harness = await window.__nightfallHarness.load(
      "timeline-event-effect",
    );
    return harness.replaceTimelineAfterOneEvent();
  });
  expect(sends).toEqual(["1:10", "3:20"]);
});

/** Verifies an edit made before the timeline reaches the store is sent once, when it arrives. */
test("timeline event commands wait for the timeline to load", async ({
  page,
}) => {
  await page.goto(harnessPageUrl("timeline-event-effect"));
  const sends = await page.evaluate(async () => {
    const harness = await window.__nightfallHarness.load(
      "timeline-event-effect",
    );
    return harness.eventBeforeTimelineLoads();
  });
  expect(sends).toEqual(["1:10"]);
});
