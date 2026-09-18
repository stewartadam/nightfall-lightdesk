// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, type Page, test } from "./playwright-fixtures";
import { prepareStoreSeededTestApp } from "./showfile-startup";

type DurationTrailFixture = {
  timelineUid: string;
  timecodeUid: string;
  clipUid: string;
  sequenceUid: string;
  cueUid: string;
  panelId: string;
  durationTrackId: string;
  durationItemId: string;
  instantItemId: string;
  stepFxUid?: string;
};

type CrossTrackStopDurationTrailFixture = DurationTrailFixture & {
  stopTrackId: string;
  stopItemId: string;
};

type FxModuleDurationTrailFixture = {
  timelineUid: string;
  timecodeUid: string;
  clipUid: string;
  fxModuleUid: string;
  panelId: string;
  trackId: string;
  actionId: string;
};

/** Returns the timeline surface rendered inside the fixture's isolated panel. */
function fixtureTimelineSurface(
  page: Page,
  fixture: Pick<
    DurationTrailFixture | FxModuleDurationTrailFixture,
    "panelId" | "timelineUid"
  >,
) {
  return page.locator(
    `.${fixture.panelId} [data-timeline-surface="true"][data-timeline-uid="${fixture.timelineUid}"]`,
  );
}

/** Sets the zoom input belonging to the fixture's isolated timeline surface. */
async function setFixtureTimelineZoom(
  surface: ReturnType<typeof fixtureTimelineSurface>,
  value: string,
): Promise<void> {
  const zoomInput = surface.getByLabel("Timeline zoom");
  await zoomInput.fill(value);
  await zoomInput.blur();
}

/** Opens an empty disconnected app for owned timeline duration fixtures. */
async function openTimelineDurationTrailApp(page: Page): Promise<void> {
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto("/?e2e=1");
  await prepareStoreSeededTestApp(page);
}

/** Opens an isolated Pattern FX module item with a finite stop span. */
async function openFxModuleDurationTrailFixture(
  page: Page,
): Promise<FxModuleDurationTrailFixture> {
  return page.evaluate(() => {
    const stores = (window as any).appStores;
    const api = stores?.dockApi?.get?.();
    if (!api) {
      throw new Error("App stores were not ready");
    }

    const suffix = crypto.randomUUID().replace(/-/g, "");
    const timelineUid = `e2edurationtimeline${suffix}`;
    const timecodeUid = `e2edurationtimecode${suffix}`;
    const clipUid = `e2edurationclip${suffix}`;
    const fxModuleUid = `e2edurationfxmodule${suffix}`;
    const trackId = `e2e-pattern-track-${suffix}`;
    const actionId = `e2e-pattern-start-${suffix}`;

    stores.fxModules.set({
      [fxModuleUid]: {
        identifiers: {
          id: 910_400,
          uid: fxModuleUid,
          label: "Pattern Duration Trail",
        },
        module_name: "example-pattern",
        selection: {
          source: { type: "Fixture", data: { fixture_id: 1 } },
          clauses: [],
          union: [],
        },
        config: { pattern_ms: "7868.852" },
      },
    });
    stores.clips.set({
      [clipUid]: [
        {
          identifiers: {
            id: 910_401,
            uid: clipUid,
            label: "Pattern Duration Trail",
          },
          source: { type: "FxModule", data: fxModuleUid },
          priority: 0,
          options: {
            auto_release: false,
            deactivate_on_sequence_end: false,
          },
        },
        false,
      ],
    });
    stores.timecodes.set({
      [timecodeUid]: [
        {
          identifiers: {
            id: 910_403,
            uid: timecodeUid,
            label: "Pattern Duration Trail Timecode",
          },
          rate: "Fps30",
          source: "Internal",
        },
        {
          timecode_id: 910_403,
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
          id: 910_402,
          uid: timelineUid,
          label: "Pattern Duration Trail",
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
        lookahead: "Inherit",
        tracks: [
          {
            id: trackId,
            label: "Pattern",
            muted: false,
            solo: false,
            expanded: false,
            actions: [
              {
                id: actionId,
                label: "Pattern Start",
                position: { secs: 0, nanos: 0 },
                duration: { secs: 1, nanos: 0 },
                action: { type: "StartClip", data: clipUid },
              },
              {
                id: `e2e-pattern-stop-${suffix}`,
                label: "Pattern Stop",
                position: { secs: 29, nanos: 500_000_000 },
                duration: { secs: 0, nanos: 0 },
                action: { type: "StopClip", data: clipUid },
              },
            ],
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

    const panelId = `e2e-duration-fx-module-${timelineUid}`;
    const panel = api.addPanel({
      id: panelId,
      component: "Timeline",
      title: "Pattern Duration Trails",
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
      timecodeUid,
      clipUid,
      fxModuleUid,
      panelId,
      trackId,
      actionId,
    };
  });
}

/** Opens an isolated timeline with one positive-duration and one zero-duration item. */
async function openDurationTrailFixture(
  page: Page,
): Promise<DurationTrailFixture> {
  return page.evaluate(() => {
    const stores = (window as any).appStores;
    const api = stores?.dockApi?.get?.();
    if (!api) {
      throw new Error("App stores were not ready");
    }

    const timelineUid = crypto.randomUUID().replace(/-/g, "");
    const timecodeUid = crypto.randomUUID().replace(/-/g, "");
    const clipUid = crypto.randomUUID().replace(/-/g, "");
    const sequenceUid = crypto.randomUUID().replace(/-/g, "");
    const cueUid = crypto.randomUUID().replace(/-/g, "");
    const setupCueUid = crypto.randomUUID().replace(/-/g, "");
    const releaseCueUid = crypto.randomUUID().replace(/-/g, "");
    const idBase = Math.floor(980_000 + Math.random() * 10_000);
    const durationTrackId = `e2e-duration-track-${Date.now()}`;
    const durationItemId = `e2e-duration-item-${Date.now()}`;
    const instantItemId = `e2e-instant-item-${Date.now()}`;

    const zeroDuration = { secs: 0, nanos: 0 };
    const threeSecondDuration = { secs: 3, nanos: 0 };
    const cue = {
      identifiers: { id: idBase + 2, uid: cueUid, label: "Duration Cue" },
      trigger: { type: "Manual" },
      transitions: {},
      transitions_by_attribute: {},
      instructions: [],
      parts: [],
      tracking_flags: "HTP",
    };
    const cueDurationProfile = {
      cue_uid: cueUid,
      cue_id: idBase + 2,
      profile: {
        max_delay_in: zeroDuration,
        max_fade_in: zeroDuration,
        max_delay_out: zeroDuration,
        max_fade_out: zeroDuration,
        assertion_duration: threeSecondDuration,
        release_duration: zeroDuration,
        max_transition_duration: threeSecondDuration,
      },
    };
    const sequence = {
      identifiers: {
        id: idBase + 3,
        uid: sequenceUid,
        label: "Duration Sequence",
      },
      steps: [cueUid],
      wrap: false,
      release_on_start: false,
      setup_cue: {
        identifiers: { id: 0, uid: setupCueUid, label: "Setup" },
        trigger: { type: "Manual" },
        transitions: {},
        transitions_by_attribute: {},
        instructions: [],
        parts: [],
        tracking_flags: "HTP",
      },
      release_cue: {
        identifiers: { id: 0, uid: releaseCueUid, label: "Release" },
        trigger: { type: "Manual" },
        transitions: {},
        transitions_by_attribute: {},
        instructions: [],
        parts: [],
        tracking_flags: "HTP",
      },
      default_timing: {
        delay_in: { type: "Fixed", data: zeroDuration },
        fade_in: { type: "Fixed", data: zeroDuration },
        curve_in: "Linear",
        delay_out: { type: "Fixed", data: zeroDuration },
        fade_out: { type: "Fixed", data: zeroDuration },
        curve_out: "Linear",
      },
      tracking_mode: { type: "Inherit" },
    };
    const clipTuple = [
      {
        identifiers: {
          id: idBase + 6,
          uid: clipUid,
          label: "Auto Duration Clip",
        },
        source: { type: "Sequence", data: sequenceUid },
        priority: 0,
        options: {
          auto_release: true,
          deactivate_on_sequence_end: true,
        },
      },
      false,
    ];
    const timelineFixture = {
      identifiers: {
        id: idBase + 1,
        uid: timelineUid,
        label: "E2E Duration Trail Timeline",
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
      lookahead: "Inherit",
      tracks: [
        {
          id: durationTrackId,
          label: "Duration Trail Track",
          muted: false,
          solo: false,
          expanded: false,
          actions: [
            {
              id: durationItemId,
              label: "Duration Item",
              position: { secs: 1, nanos: 0 },
              duration: { secs: 1, nanos: 0 },
              action: { type: "StartClip", data: clipUid },
            },
            {
              id: instantItemId,
              label: "Instant Item",
              position: { secs: 5, nanos: 0 },
              duration: { secs: 0, nanos: 0 },
              action: { type: "DeskEval", data: "noop" },
            },
          ],
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
    };

    /** Seeds the browser stores used by the duration trail resolver. */
    const seedFixtureState = () => {
      stores.cues.set({ [cueUid]: cue });
      stores.cueDurationProfiles.set({
        [cueUid]: cueDurationProfile,
      });
      stores.sequences.set({
        [sequenceUid]: sequence,
      });
      stores.clips.set({
        [clipUid]: clipTuple,
      });
      stores.timecodes.set({
        [timecodeUid]: [
          {
            identifiers: {
              id: idBase,
              uid: timecodeUid,
              label: "E2E Duration Trail Timecode",
            },
            rate: "Fps30",
            source: "Internal",
          },
          {
            timecode_id: idBase,
            is_active: false,
            current_time: zeroDuration,
            start_time: null,
            end_time: null,
          },
        ],
      });
      stores.timelines.set({ [timelineUid]: timelineFixture });
      stores.cueDefinitionsLoaded.set(true);
      stores.sequenceDefinitionsLoaded.set(true);
      stores.timelineDefinitionsLoaded.set(true);
    };

    seedFixtureState();

    const panelId = `e2e-duration-trails-${timelineUid}`;
    const panel =
      api.getPanel(panelId) ??
      api.addPanel({
        id: panelId,
        component: "Timeline",
        title: "Duration Trails",
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
      timecodeUid,
      clipUid,
      sequenceUid,
      cueUid,
      panelId,
      durationTrackId,
      durationItemId,
      instantItemId,
    };
  });
}

/** Opens a wrapping Step FX fixture with the stop action authored on the same track. */
async function openSameTrackStepFxStopDurationTrailFixture(
  page: Page,
): Promise<DurationTrailFixture> {
  const fixture = await openDurationTrailFixture(page);
  return page.evaluate((fixture) => {
    const stores = (window as any).appStores;
    const stepFxUid = crypto.randomUUID().replace(/-/g, "");
    const stopItemId = `e2e-duration-step-fx-stop-${Date.now()}`;
    const stepFxDuration = { secs: 1, nanos: 500_000_000 };

    stores.stepFx.set({
      ...stores.stepFx.get(),
      [stepFxUid]: {
        identifiers: {
          id: 980_500,
          uid: stepFxUid,
          label: "Step FX Duration Trail",
        },
        selection: {
          source: { type: "Fixture", data: { fixture_id: 1 } },
          clauses: [],
          union: [],
        },
        timing: { beat_duration: stepFxDuration },
        phase: { waypoints: [0, 1] },
        direction: "Forward",
        cycle_scale: { type: "Auto" },
        lanes: [
          {
            attribute: { type: "Intensity" },
            absolute: {
              steps: [1, 0].map((value) => ({
                uid: crypto.randomUUID(),
                target: { type: "AbsolutePercent", data: { value } },
                width_beats: 0.5,
                transition: { start: 0, end: 1 },
                curve: { type: "Snap", data: {} },
              })),
            },
          },
        ],
      },
    });

    const clips = { ...stores.clips.get() };
    clips[fixture.clipUid] = [
      {
        ...clips[fixture.clipUid][0],
        source: { type: "StepFx", data: stepFxUid },
      },
      false,
    ];
    stores.clips.set(clips);

    const timelines = { ...stores.timelines.get() };
    const timeline = timelines[fixture.timelineUid];
    const durationTrack = {
      id: fixture.durationTrackId,
      label: "Duration Trail Track",
      muted: false,
      solo: false,
      expanded: false,
      actions: [
        {
          id: fixture.durationItemId,
          label: "Duration Item",
          position: { secs: 1, nanos: 0 },
          duration: { secs: 1, nanos: 0 },
          action: { type: "StartClip", data: fixture.clipUid },
        },
        {
          id: fixture.instantItemId,
          label: "Instant Item",
          position: { secs: 5, nanos: 0 },
          duration: { secs: 0, nanos: 0 },
          action: { type: "DeskEval", data: "noop" },
        },
        {
          id: stopItemId,
          label: "Stop Step FX Duration Clip",
          position: { secs: 7, nanos: 0 },
          duration: { secs: 0, nanos: 0 },
          action: { type: "StopClip", data: fixture.clipUid },
        },
      ],
      automation_lanes: [],
    };
    timelines[fixture.timelineUid] = {
      ...timeline,
      tracks: timeline.tracks.some(
        (track: any) => track.id === fixture.durationTrackId,
      )
        ? timeline.tracks.map((track: any) =>
            track.id === fixture.durationTrackId ? durationTrack : track,
          )
        : [...timeline.tracks, durationTrack],
    };
    stores.timelines.set(timelines);

    return {
      ...fixture,
      stepFxUid,
    };
  }, fixture);
}

/** Opens a wrapping sequence fixture with the stop action authored on another track. */
async function openCrossTrackStopDurationTrailFixture(
  page: Page,
): Promise<CrossTrackStopDurationTrailFixture> {
  const fixture = await openDurationTrailFixture(page);
  return page.evaluate((fixture) => {
    const stores = (window as any).appStores;
    const stopTrackId = `e2e-duration-stop-track-${Date.now()}`;
    const stopItemId = `e2e-duration-stop-item-${Date.now()}`;

    const sequences = { ...stores.sequences.get() };
    sequences[fixture.sequenceUid] = {
      ...sequences[fixture.sequenceUid],
      wrap: true,
    };
    stores.sequences.set(sequences);

    const timelines = { ...stores.timelines.get() };
    const timeline = timelines[fixture.timelineUid];
    timelines[fixture.timelineUid] = {
      ...timeline,
      tracks: [
        ...timeline.tracks,
        {
          id: stopTrackId,
          label: "Cross Track Stop",
          muted: false,
          solo: false,
          expanded: false,
          actions: [
            {
              id: stopItemId,
              label: "Stop Duration Clip",
              position: { secs: 7, nanos: 0 },
              duration: { secs: 0, nanos: 0 },
              action: { type: "StopClip", data: fixture.clipUid },
            },
          ],
          automation_lanes: [],
        },
      ],
    };
    stores.timelines.set(timelines);

    return {
      ...fixture,
      stopTrackId,
      stopItemId,
    };
  }, fixture);
}

/** Opens a wrapping sequence fixture whose tiny loop interval must be sampled. */
async function openDenseLoopDurationTrailFixture(
  page: Page,
): Promise<CrossTrackStopDurationTrailFixture> {
  const fixture = await openCrossTrackStopDurationTrailFixture(page);
  return page.evaluate((fixture) => {
    const stores = (window as any).appStores;
    const tinyLoopDuration = { secs: 0, nanos: 10_000_000 };
    const cues = { ...stores.cues.get() };
    cues[fixture.cueUid] = {
      ...cues[fixture.cueUid],
      trigger: { type: "AfterDelay", data: tinyLoopDuration },
    };
    stores.cues.set(cues);

    const timelines = { ...stores.timelines.get() };
    const timeline = timelines[fixture.timelineUid];
    timelines[fixture.timelineUid] = {
      ...timeline,
      tracks: timeline.tracks.map((track: any) =>
        track.id === fixture.stopTrackId
          ? {
              ...track,
              actions: track.actions.map((item: any) =>
                item.id === fixture.stopItemId
                  ? { ...item, position: { secs: 61, nanos: 0 } }
                  : item,
              ),
            }
          : track,
      ),
    };
    stores.timelines.set(timelines);

    return fixture;
  }, fixture);
}

/** Opens a short auto-ending clip fixture whose trail ends under the item label. */
async function openShortDurationTrailFixture(
  page: Page,
): Promise<DurationTrailFixture> {
  const fixture = await openDurationTrailFixture(page);
  return page.evaluate((fixture) => {
    const stores = (window as any).appStores;
    const cueDurationProfiles = { ...stores.cueDurationProfiles.get() };
    const profile = cueDurationProfiles[fixture.cueUid];
    const shortDuration = { secs: 0, nanos: 150_000_000 };
    cueDurationProfiles[fixture.cueUid] = {
      ...profile,
      profile: {
        ...profile.profile,
        assertion_duration: shortDuration,
        max_transition_duration: shortDuration,
      },
    };
    stores.cueDurationProfiles.set(cueDurationProfiles);
    return fixture;
  }, fixture);
}

/** Removes the owned FX module duration fixture from browser stores. */
async function cleanupFxModuleDurationTrailFixture(
  page: Page,
  fixture: FxModuleDurationTrailFixture,
): Promise<void> {
  await page.evaluate(
    ({ clipUid, fxModuleUid, panelId, timecodeUid, timelineUid }) => {
      const stores = (window as any).appStores;
      stores.dockApi?.get?.()?.getPanel(panelId)?.api.close();
      const transientEntries: Array<[string, string]> = [
        ["timelines", timelineUid],
        ["timecodes", timecodeUid],
        ["clips", clipUid],
        ["fxModules", fxModuleUid],
      ];
      for (const [storeName, uid] of transientEntries) {
        const entries = { ...stores[storeName].get() };
        delete entries[uid];
        stores[storeName].set(entries);
      }
    },
    fixture,
  );
}

/** Removes the owned sequence duration fixture from browser stores. */
async function cleanupDurationTrailFixture(
  page: Page,
  fixture: DurationTrailFixture,
): Promise<void> {
  await page.evaluate(
    ({
      timelineUid,
      timecodeUid,
      clipUid,
      sequenceUid,
      cueUid,
      panelId,
      stepFxUid,
    }) => {
      const stores = (window as any).appStores;
      stores.dockApi?.get?.()?.getPanel(panelId)?.api.close();

      const transientEntries: Array<[string, string | undefined]> = [
        ["timelines", timelineUid],
        ["timecodes", timecodeUid],
        ["clips", clipUid],
        ["sequences", sequenceUid],
        ["cues", cueUid],
        ["cueDurationProfiles", cueUid],
        ["stepFx", stepFxUid],
      ];

      for (const [storeName, uid] of transientEntries) {
        if (!uid) continue;
        const entries = { ...stores[storeName].get() };
        delete entries[uid];
        stores[storeName].set(entries);
      }
    },
    fixture,
  );
}

/** Verifies the duration trail toggle renders trails only for known item lengths. */
test("timeline duration trail toggle renders known item lengths", async ({
  page,
}) => {
  await openTimelineDurationTrailApp(page);

  const fixture = await openDurationTrailFixture(page);
  try {
    const surface = fixtureTimelineSurface(page, fixture);
    await expect(surface).toBeVisible();

    const toggle = surface.locator("[data-timeline-duration-trail-toggle]");
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(toggle).toHaveAttribute(
      "title",
      "Show item duration trails (D)",
    );

    const durationItem = surface.locator(
      `[data-timeline-action="true"][data-track-id="${fixture.durationTrackId}"][data-action-id="${fixture.durationItemId}"]`,
    );
    const instantItem = surface.locator(
      `[data-timeline-action="true"][data-track-id="${fixture.durationTrackId}"][data-action-id="${fixture.instantItemId}"]`,
    );
    await expect(durationItem).toBeVisible();
    await expect(instantItem).toBeVisible();
    await expect(
      durationItem.locator("[data-timeline-action-duration-trail]"),
    ).toHaveCount(0);

    await surface.click({ position: { x: 20, y: 20 } });
    await page.keyboard.press("d");
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(toggle).toHaveAttribute(
      "title",
      "Hide item duration trails (D)",
    );

    const trail = durationItem.locator("[data-timeline-action-duration-trail]");
    await expect(trail).toBeVisible();
    await expect(
      instantItem.locator("[data-timeline-action-duration-trail]"),
    ).toHaveCount(0);

    const trailBox = await trail.boundingBox();
    const itemBox = await durationItem.boundingBox();
    expect(trailBox).not.toBeNull();
    expect(itemBox).not.toBeNull();
    expect(trailBox!.x).toBeCloseTo(itemBox!.x, 0);
    expect(trailBox!.width).toBeGreaterThanOrEqual(299);
    expect(trailBox!.width).toBeLessThanOrEqual(301);

    await page.keyboard.press("d");
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(trail).toHaveCount(0);
  } finally {
    await cleanupDurationTrailFixture(page, fixture);
  }
});

/** Verifies Step FX duration trails use same-track stop spans and loop markers. */
test("timeline duration trail toggle renders Step FX same-track stop spans", async ({
  page,
}) => {
  await openTimelineDurationTrailApp(page);

  const fixture = await openSameTrackStepFxStopDurationTrailFixture(page);
  try {
    const surface = fixtureTimelineSurface(page, fixture);
    await expect(surface).toBeVisible();

    await setFixtureTimelineZoom(surface, "100");

    const toggle = surface.locator("[data-timeline-duration-trail-toggle]");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");

    const durationItem = surface.locator(
      `[data-timeline-action="true"][data-track-id="${fixture.durationTrackId}"][data-action-id="${fixture.durationItemId}"]`,
    );
    await expect(durationItem).toBeVisible();

    const trail = durationItem.locator("[data-timeline-action-duration-trail]");
    await expect(trail).toBeVisible();

    const trailBox = await trail.boundingBox();
    expect(trailBox).not.toBeNull();
    expect(trailBox!.width).toBeGreaterThanOrEqual(599);
    expect(trailBox!.width).toBeLessThanOrEqual(601);

    const loopMarkers = trail.locator(
      "[data-timeline-action-duration-loop-marker]",
    );
    await expect(loopMarkers).toHaveCount(3);
    const firstLoopMarkerBox = await loopMarkers.first().boundingBox();
    expect(firstLoopMarkerBox).not.toBeNull();
    expect(firstLoopMarkerBox!.x - trailBox!.x).toBeGreaterThanOrEqual(149);
    expect(firstLoopMarkerBox!.x - trailBox!.x).toBeLessThanOrEqual(151);
  } finally {
    await cleanupDurationTrailFixture(page, fixture);
  }
});

/** Verifies selected short duration trails highlight and expose a full-height fin. */
test("timeline duration trail selection highlights short tail fins", async ({
  page,
}) => {
  await openTimelineDurationTrailApp(page);

  const fixture = await openShortDurationTrailFixture(page);
  try {
    const surface = fixtureTimelineSurface(page, fixture);
    await expect(surface).toBeVisible();

    await setFixtureTimelineZoom(surface, "100");

    const toggle = surface.locator("[data-timeline-duration-trail-toggle]");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");

    const durationItem = surface.locator(
      `[data-timeline-action="true"][data-track-id="${fixture.durationTrackId}"][data-action-id="${fixture.durationItemId}"]`,
    );
    await expect(durationItem).toBeVisible();

    const trail = durationItem.locator("[data-timeline-action-duration-trail]");
    await expect(trail).toBeVisible();
    await expect(trail).toHaveAttribute("data-selected", "false");

    const trailBox = await trail.boundingBox();
    expect(trailBox).not.toBeNull();
    expect(trailBox!.width).toBeGreaterThanOrEqual(14);
    expect(trailBox!.width).toBeLessThanOrEqual(16);

    await durationItem.click();
    await expect(durationItem).toHaveAttribute("data-selected", "true");
    await expect(trail).toHaveAttribute("data-selected", "true");

    const itemBox = await durationItem.boundingBox();
    const finBarBox = await trail
      .locator("[data-timeline-action-duration-fin-bar]")
      .boundingBox();
    expect(itemBox).not.toBeNull();
    expect(finBarBox).not.toBeNull();
    expect(finBarBox!.height).toBeGreaterThanOrEqual(itemBox!.height - 1);
  } finally {
    await cleanupDurationTrailFixture(page, fixture);
  }
});

/** Verifies wrapping clip trails can terminate at stop actions on other tracks. */
test("timeline duration trail toggle uses stops from other tracks", async ({
  page,
}) => {
  await openTimelineDurationTrailApp(page);

  const fixture = await openCrossTrackStopDurationTrailFixture(page);
  try {
    const surface = fixtureTimelineSurface(page, fixture);
    await expect(surface).toBeVisible();

    await setFixtureTimelineZoom(surface, "100");

    const toggle = surface.locator("[data-timeline-duration-trail-toggle]");
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");

    const durationItem = surface.locator(
      `[data-timeline-action="true"][data-track-id="${fixture.durationTrackId}"][data-action-id="${fixture.durationItemId}"]`,
    );
    const stopItem = surface.locator(
      `[data-timeline-action="true"][data-track-id="${fixture.stopTrackId}"][data-action-id="${fixture.stopItemId}"]`,
    );
    await expect(durationItem).toBeVisible();
    await expect(stopItem).toBeVisible();

    const trail = durationItem.locator("[data-timeline-action-duration-trail]");
    await expect(trail).toBeVisible();

    const trailBox = await trail.boundingBox();
    expect(trailBox).not.toBeNull();
    expect(trailBox!.width).toBeGreaterThanOrEqual(599);
    expect(trailBox!.width).toBeLessThanOrEqual(601);

    const loopMarkers = trail.locator(
      "[data-timeline-action-duration-loop-marker]",
    );
    await expect(loopMarkers).toHaveCount(1);
    const loopMarkerBox = await loopMarkers.first().boundingBox();
    expect(loopMarkerBox).not.toBeNull();
    expect(loopMarkerBox!.x - trailBox!.x).toBeGreaterThanOrEqual(299);
    expect(loopMarkerBox!.x - trailBox!.x).toBeLessThanOrEqual(301);
  } finally {
    await cleanupDurationTrailFixture(page, fixture);
  }
});

/** Verifies dense loop marker trails show sampled ticks and an ellipsis marker. */
test("timeline duration trail toggle samples dense loop markers", async ({
  page,
}) => {
  await openTimelineDurationTrailApp(page);

  const fixture = await openDenseLoopDurationTrailFixture(page);
  try {
    const surface = fixtureTimelineSurface(page, fixture);
    await expect(surface).toBeVisible();

    await setFixtureTimelineZoom(surface, "100");

    const toggle = surface.locator("[data-timeline-duration-trail-toggle]");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");

    const durationItem = surface.locator(
      `[data-timeline-action="true"][data-track-id="${fixture.durationTrackId}"][data-action-id="${fixture.durationItemId}"]`,
    );
    await expect(durationItem).toBeVisible();

    const trail = durationItem.locator("[data-timeline-action-duration-trail]");
    await expect(trail).toBeVisible();

    const loopMarkers = trail.locator(
      "[data-timeline-action-duration-loop-marker]",
    );
    await expect(loopMarkers).toHaveCount(249);
    await expect(loopMarkers.first()).toHaveAttribute("data-loop-index", "24");
    await expect(loopMarkers.first()).toHaveAttribute("data-sampled", "true");

    const samplingMarker = trail.locator(
      "[data-timeline-action-duration-loop-sampling]",
    );
    await expect(samplingMarker).toHaveCount(1);
    await expect(samplingMarker).toHaveText("...");
    await expect(samplingMarker).toHaveAttribute("data-sample-stride", "24");
    await expect(samplingMarker).toHaveAttribute(
      "data-raw-marker-count",
      "5999",
    );
    await expect(samplingMarker).toHaveAttribute(
      "title",
      "Showing every 24th loop marker (5999 total)",
    );
  } finally {
    await cleanupDurationTrailFixture(page, fixture);
  }
});

/** Verifies owned FX module items render loop markers through their stop action. */
test("timeline duration trail toggle renders Pattern FX module length", async ({
  page,
}) => {
  await openTimelineDurationTrailApp(page);

  const fixture = await openFxModuleDurationTrailFixture(page);
  try {
    const surface = fixtureTimelineSurface(page, fixture);
    await expect(surface).toBeVisible();

    await setFixtureTimelineZoom(surface, "100");

    const toggle = surface.locator("[data-timeline-duration-trail-toggle]");
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");

    const durationItem = surface.locator(
      `[data-timeline-action="true"][data-track-id="${fixture.trackId}"][data-action-id="${fixture.actionId}"]`,
    );
    await expect(durationItem).toBeVisible();

    const trail = durationItem.locator("[data-timeline-action-duration-trail]");
    await expect(trail).toBeVisible();

    const trailBox = await trail.boundingBox();
    expect(trailBox).not.toBeNull();
    expect(trailBox!.width).toBeGreaterThanOrEqual(2949);
    expect(trailBox!.width).toBeLessThanOrEqual(2951);

    const loopMarkers = trail.locator(
      "[data-timeline-action-duration-loop-marker]",
    );
    await expect(loopMarkers).toHaveCount(3);
    const firstLoopMarkerBox = await loopMarkers.nth(0).boundingBox();
    expect(firstLoopMarkerBox).not.toBeNull();
    expect(firstLoopMarkerBox!.x - trailBox!.x).toBeGreaterThanOrEqual(786);
    expect(firstLoopMarkerBox!.x - trailBox!.x).toBeLessThanOrEqual(788);
  } finally {
    await cleanupFxModuleDurationTrailFixture(page, fixture);
  }
});
