// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, type Page, test } from "./playwright-fixtures";

/** Waits for app stores and Dockview to be ready for direct panel setup. */
async function waitForDeletionLifecycleStores(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      Boolean((window as any).appStores?.dockApi?.get?.()) &&
      Boolean((window as any).appStores?.sequences?.get?.()) &&
      Boolean((window as any).appStores?.timelines?.get?.()) &&
      (window as any).appStores?.cueDefinitionsLoaded?.get?.() === true &&
      (window as any).appStores?.sequenceDefinitionsLoaded?.get?.() === true &&
      (window as any).appStores?.timelineDefinitionsLoaded?.get?.() === true,
  );
}

/** Opens object editor panels against hydrated store entries and returns their IDs. */
async function openObjectEditorPanels(page: Page): Promise<{
  sequenceUid: string;
  timelineUid: string;
  contextCuePanelId: string;
  panelIds: string[];
  cuePanelIds: string[];
}> {
  return await page.evaluate(() => {
    const stores = (window as any).appStores;
    const api = stores.dockApi.get();
    /** Builds a fixed transition mode from seconds for seeded object data. */
    const fixed = (secs: number) => ({
      type: "Fixed",
      data: { secs, nanos: 0 },
    });

    /** Builds a full transition record for seeded sequence timing data. */
    const transition = () => ({
      delay_in: fixed(0),
      fade_in: fixed(0),
      curve_in: "Linear",
      delay_out: fixed(0),
      fade_out: fixed(0),
      curve_out: "Linear",
    });

    /** Builds a minimal cue record accepted by cue and sequence editor panels. */
    const cue = (id: number, uid: string, label: string) => ({
      identifiers: { id, uid, label },
      trigger: { type: "Manual" },
      transitions: {},
      transitions_by_attribute: {},
      instructions: [],
      parts: [],
      tracking_flags: "HTP",
      tracking_mode: { type: "Inherit" },
    });

    const sequenceUid = "sequence-delete-lifecycle-e2e";
    const normalCue = cue(1, "cue-delete-lifecycle-e2e", "Cue 1");
    const sequence = {
      identifiers: {
        id: 990,
        uid: sequenceUid,
        label: "Deletion Lifecycle Sequence",
      },
      steps: [normalCue.identifiers.uid],
      wrap: false,
      release_on_start: false,
      setup_cue: cue(0, "setup-cue-delete-lifecycle-e2e", "Setup"),
      release_cue: cue(0, "release-cue-delete-lifecycle-e2e", "Release"),
      default_timing: transition(),
      tracking_mode: { type: "Flags", data: "HTP" },
    };

    const timelineUid = "timeline-delete-lifecycle-e2e";
    const timeline = {
      identifiers: {
        id: 991,
        uid: timelineUid,
        label: "Deletion Lifecycle Timeline",
      },
      timecode_uid: "timeline-delete-lifecycle-timecode-e2e",
      timecode_start: { secs: 0, nanos: 0 },
      audio_path: "",
      audio_enabled: true,
      end_time: undefined,
      tracks: [],
      markers: [],
      regions: [],
      loop_range: undefined,
      bpm: 120,
      beats_per_bar: 4,
      use_beat_grid: false,
      beatgrid: undefined,
      scroll_mode: "Free",
    };

    stores.cueDefinitionsLoaded?.set?.(true);
    stores.sequenceDefinitionsLoaded?.set?.(true);
    stores.timelineDefinitionsLoaded?.set?.(true);
    stores.cues.set({
      ...stores.cues.get(),
      [normalCue.identifiers.uid]: normalCue,
    });
    stores.sequences.set({
      ...stores.sequences.get(),
      [sequenceUid]: sequence,
    });
    stores.timelines.set({
      ...stores.timelines.get(),
      [timelineUid]: timeline,
    });

    const sequencePanelId = `sequence-editor-panel-${sequenceUid}`;
    const cuePanelId = `cue-editor-${normalCue.identifiers.uid}-p0`;
    const contextCuePanelId = `context-cue-editor-${normalCue.identifiers.uid}-p0`;
    const setupCuePanelId = `setup-cue-editor-${sequenceUid}-p0`;
    const releaseCuePanelId = `release-cue-editor-${sequenceUid}-p0`;
    const timelinePanelId = `panel-Timeline-${timelineUid}`;

    api.addPanel({
      id: sequencePanelId,
      component: "SequenceEditor",
      title: "Deletion Lifecycle Sequence",
      params: { initialSequenceUid: sequenceUid },
    });
    api.addPanel({
      id: cuePanelId,
      component: "CueEditor",
      title: "Deletion Lifecycle Cue",
      params: {
        initialCueUid: normalCue.identifiers.uid,
        initialSequenceId: sequence.identifiers.id,
        initialSequenceUid: sequenceUid,
        closeOnSequenceDelete: true,
      },
    });
    api.addPanel({
      id: contextCuePanelId,
      component: "CueEditor",
      title: "Contextual Deletion Lifecycle Cue",
      params: {
        initialCueUid: normalCue.identifiers.uid,
        initialSequenceId: sequence.identifiers.id,
        initialSequenceUid: sequenceUid,
      },
    });
    api.addPanel({
      id: setupCuePanelId,
      component: "CueEditor",
      title: "Deletion Lifecycle Setup Cue",
      params: {
        initialCueUid: sequence.setup_cue.identifiers.uid,
        initialSetupSequenceUid: sequenceUid,
      },
    });
    api.addPanel({
      id: releaseCuePanelId,
      component: "CueEditor",
      title: "Deletion Lifecycle Release Cue",
      params: {
        initialCueUid: sequence.release_cue.identifiers.uid,
        initialReleaseSequenceUid: sequenceUid,
      },
    });
    api.addPanel({
      id: timelinePanelId,
      component: "Timeline",
      title: "Deletion Lifecycle Timeline",
      params: { initialTimelineUid: timelineUid },
    });

    return {
      sequenceUid,
      timelineUid,
      contextCuePanelId,
      panelIds: [
        sequencePanelId,
        cuePanelId,
        setupCuePanelId,
        releaseCuePanelId,
        timelinePanelId,
      ],
      cuePanelIds: [cuePanelId, setupCuePanelId, releaseCuePanelId],
    };
  });
}

/** Returns whether every panel ID is absent from Dockview. */
async function allPanelsClosed(
  page: Page,
  panelIds: string[],
): Promise<boolean> {
  return await page.evaluate(
    (ids) =>
      ids.every((id) => !(window as any).appStores.dockApi.get().getPanel(id)),
    panelIds,
  );
}

/** Returns the Dockview titles for the requested panel IDs. */
async function panelTitles(
  page: Page,
  panelIds: string[],
): Promise<Record<string, string | undefined>> {
  return await page.evaluate((ids) => {
    const api = (window as any).appStores.dockApi.get();
    return Object.fromEntries(ids.map((id) => [id, api.getPanel(id)?.title]));
  }, panelIds);
}

/** Verifies object editor panels close when their backing objects disappear. */
test("object editor panels close when sequence and timeline objects are deleted", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 800 });
  await page.goto("/?e2e=1");
  await expect(page.locator("main#app")).toBeVisible();
  await waitForDeletionLifecycleStores(page);

  const opened = await openObjectEditorPanels(page);

  await expect
    .poll(() => allPanelsClosed(page, opened.panelIds), { timeout: 10_000 })
    .toBe(false);

  await page.evaluate(({ sequenceUid }) => {
    const stores = (window as any).appStores;
    const sequence = stores.sequences.get()[sequenceUid];
    stores.sequences.set({
      ...stores.sequences.get(),
      [sequenceUid]: {
        ...sequence,
        identifiers: {
          ...sequence.identifiers,
          id: 992,
        },
      },
    });
  }, opened);

  await expect
    .poll(() => panelTitles(page, opened.cuePanelIds), { timeout: 10_000 })
    .toEqual({
      [opened.cuePanelIds[0]]: "Cue 992.1",
      [opened.cuePanelIds[1]]: "Cue 992.0 (Setup)",
      [opened.cuePanelIds[2]]: "Cue 992.0 (Release)",
    });

  await page.evaluate(({ sequenceUid, timelineUid }) => {
    const stores = (window as any).appStores;
    const { [sequenceUid]: _deletedSequence, ...remainingSequences } =
      stores.sequences.get();
    const { [timelineUid]: _deletedTimeline, ...remainingTimelines } =
      stores.timelines.get();
    stores.sequences.set(remainingSequences);
    stores.timelines.set(remainingTimelines);
  }, opened);

  await expect
    .poll(() => allPanelsClosed(page, opened.panelIds), { timeout: 10_000 })
    .toBe(true);
  await expect
    .poll(
      () =>
        page.evaluate(
          (id) => Boolean((window as any).appStores.dockApi.get().getPanel(id)),
          opened.contextCuePanelId,
        ),
      { timeout: 10_000 },
    )
    .toBe(true);
});
