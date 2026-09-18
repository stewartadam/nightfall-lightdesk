// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import {
  cueGridAttributeValueColumnKey,
  gridCellByIdentifier,
  gridCellByKey,
  gridHeaderByColumnKey,
} from "./data-grid-selectors";
import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

const TARGET_FIXTURE_ID = 601;
const PROJECTION_FIXTURE_ID = 501;
const CUE_1_ID = 9901;
const CUE_2_ID = 9902;
const CUE_3_ID = 9903;
const SEQUENCE_ID = 9901;
const CLIP_ID = 9901;
const TIMELINE_ID = 9901;
const TIMECODE_ID = 9901;
const CUE_1_UID = "b1000001000600010002000000009901";
const CUE_2_UID = "b1000001000600010002000000009902";
const CUE_3_UID = "b1000001000600010002000000009903";
const SEQUENCE_UID = "b1000001000600010003000000009901";
const CLIP_UID = "b1000001000600010004000000009901";
const TIMELINE_UID = "b1000001000600010006000000009901";
const TIMECODE_UID = "b1000001000600010007000000009901";

/** Opens a blank backend showfile and creates the exact fixtures used by Lookahead. */
async function openLookaheadTestApp(
  page: Page,
  backendPort: number,
): Promise<void> {
  await prepareFreshBackendShowfile(backendPort);
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("nightfall.currentShowfileName", "default");
  });
  await page.setViewportSize({ width: 1300, height: 720 });
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await expect(page.locator("main#app")).toBeVisible();
  await waitForDockviewApp(page);
  await page.waitForFunction(
    () =>
      typeof (window as any).appStores?.send === "function" &&
      typeof (window as any).appStores?.sendAndAwait === "function" &&
      Boolean((window as any).appStores?.dockApi?.get?.()) &&
      Boolean((window as any).appStores?.fixtures?.get) &&
      Boolean((window as any).appStores?.cues?.get) &&
      Boolean((window as any).appStores?.sequences?.get),
  );
  await expect
    .poll(() =>
      page.evaluate(() => {
        const stores = (window as any).appStores;
        return {
          cues: Object.keys(stores.cues.get()).length,
          clips: Object.keys(stores.clips.get()).length,
          fixtures: Object.keys(stores.fixtures.get()).length,
          sequences: Object.keys(stores.sequences.get()).length,
          timecodes: Object.keys(stores.timecodes.get()).length,
          timelines: Object.keys(stores.timelines.get()).length,
        };
      }),
    )
    .toEqual({
      cues: 0,
      clips: 0,
      fixtures: 0,
      sequences: 0,
      timecodes: 0,
      timelines: 0,
    });
  await storeOwnedLookaheadFixtures(page);
}

/** Creates the two complete Intensity/Tilt fixtures referenced by the scenarios. */
async function storeOwnedLookaheadFixtures(page: Page): Promise<void> {
  const results = await page.evaluate(
    async ({ projectionFixtureId, targetFixtureId }) => {
      const stores = (window as any).appStores;

      /** Creates one fixture-library record and returns its backend outcome. */
      const createFixture = async (id: number, label: string): Promise<any> =>
        stores.sendAndAwait({
          module: "FixtureLibraryCommand",
          command: {
            type: "CreateFixtureFromLibrary",
            data: {
              id,
              make: "Generic",
              model: "Moving Head RGBW",
              mode: "Spot",
              label,
              update_existing_ids: [],
              update_existing_only: false,
            },
          },
        });

      return [
        await createFixture(
          projectionFixtureId,
          "Owned Lookahead Projection Fixture",
        ),
        await createFixture(targetFixtureId, "Owned Lookahead Target Fixture"),
      ];
    },
    {
      projectionFixtureId: PROJECTION_FIXTURE_ID,
      targetFixtureId: TARGET_FIXTURE_ID,
    },
  );
  for (const result of results) {
    expect(result.outcome.type, JSON.stringify(result)).toBe("Succeeded");
  }

  await expect
    .poll(() =>
      page.evaluate(
        ({ projectionFixtureId, targetFixtureId }) => {
          const fixtures = Object.values(
            (window as any).appStores.fixtures.get(),
          ) as any[];

          /** Returns every serialized attribute name exposed by one fixture. */
          const attributes = (fixtureId: number): string[] => {
            const fixture = fixtures.find(
              (candidate) => candidate.identifiers.id === fixtureId,
            );
            return (fixture?.elements ?? []).flatMap((element: any) =>
              (element.parameters ?? []).map(
                (parameter: any) => parameter.attribute?.type,
              ),
            );
          };

          return {
            fixtureCount: fixtures.length,
            projectionAttributes: attributes(projectionFixtureId),
            targetAttributes: attributes(targetFixtureId),
          };
        },
        {
          projectionFixtureId: PROJECTION_FIXTURE_ID,
          targetFixtureId: TARGET_FIXTURE_ID,
        },
      ),
    )
    .toMatchObject({
      fixtureCount: 2,
      projectionAttributes: expect.arrayContaining(["Intensity", "Tilt"]),
      targetAttributes: expect.arrayContaining(["Intensity", "Tilt"]),
    });
}

/** Sends a command through the same websocket path used by the application UI. */
async function sendCommand(page: Page, command: object): Promise<void> {
  await page.evaluate(async (payload) => {
    await (window as any).appStores.send(payload);
  }, command);
}

/** Finds the loaded patched fixture used for the live backend Lookahead scenario. */
async function findTargetFixtureUid(page: Page): Promise<string> {
  return await findFixtureUidWithAttributes(page, TARGET_FIXTURE_ID, ["Tilt"]);
}

/** Finds a loaded patched fixture that can be dark while moving position in black. */
async function findLookaheadProjectionFixtureUid(page: Page): Promise<string> {
  return await findFixtureUidWithAttributes(page, PROJECTION_FIXTURE_ID, [
    "Intensity",
    "Tilt",
  ]);
}

/** Finds the loaded patched fixture UID for a fixture exposing the requested attribute. */
async function findFixtureUidWithAttributes(
  page: Page,
  fixtureId: number,
  attributeTypes: string[],
): Promise<string> {
  return await page.evaluate(
    ({ fixtureId, attributeTypes }) => {
      const fixtures = Object.values(
        (window as any).appStores.fixtures.get() ?? {},
      ) as any[];
      const fixture = fixtures.find(
        (candidate) => candidate?.identifiers?.id === fixtureId,
      );
      if (!fixture) {
        throw new Error(`fixture ${fixtureId} did not load`);
      }
      const missingAttribute = attributeTypes.find(
        (attributeType) =>
          !fixture.elements?.some((element: any) =>
            element.parameters?.some(
              (parameter: any) => parameter.attribute?.type === attributeType,
            ),
          ),
      );
      if (missingAttribute) {
        throw new Error(
          `fixture ${fixtureId} does not expose ${missingAttribute}`,
        );
      }
      return fixture.identifiers.uid;
    },
    { fixtureId, attributeTypes },
  );
}

/** Waits until the backend snapshot contains the temporary clip. */
async function waitForLookaheadClip(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate((clipId) => {
          const clips = Object.values(
            (window as any).appStores.clips.get() ?? {},
          );
          return clips.some(
            (entry: any) => entry?.[0]?.identifiers?.id === clipId,
          );
        }, CLIP_ID),
      { timeout: 10_000 },
    )
    .toBe(true);
}

/** Waits until the backend snapshot contains the temporary timeline and timecode. */
async function waitForLookaheadTimeline(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          ({ timelineUid, timecodeUid }) => {
            const stores = (window as any).appStores;
            return {
              hasTimeline: Boolean(stores.timelines.get()?.[timelineUid]),
              hasTimecode: Boolean(stores.timecodes.get()?.[timecodeUid]),
            };
          },
          { timelineUid: TIMELINE_UID, timecodeUid: TIMECODE_UID },
        ),
      { timeout: 10_000 },
    )
    .toEqual({ hasTimeline: true, hasTimecode: true });
}

/** Builds a zero-duration transition mode. */
function fixedZero(): object {
  return { type: "Fixed", data: { secs: 0, nanos: 0 } };
}

/** Builds a complete sequence transition with no delay or fade. */
function zeroTransition(): object {
  return {
    delay_in: fixedZero(),
    fade_in: fixedZero(),
    curve_in: "Linear",
    delay_out: fixedZero(),
    fade_out: fixedZero(),
    curve_out: "Linear",
  };
}

/** Builds an empty cue-like sequence meta cue. */
function metaCue(uid: string, label: string): object {
  return {
    identifiers: { id: 0, uid, label },
    trigger: { type: "Manual" },
    transitions: {},
    transitions_by_attribute: {},
    instructions: [],
    parts: [],
    tracking_flags: "HTP",
  };
}

/** Builds one inline absolute cue value. */
function absolute(value: number): object {
  return {
    type: "Inline",
    data: { type: "Absolute", data: { value } },
  };
}

/** Builds a cue instruction targeting the loaded Intensity-capable fixture. */
function intensityInstruction(fixtureUid: string, value: number): object {
  return {
    selection: {
      source: {
        type: "Resolved",
        data: [{ fixture_uid: fixtureUid, index: null }],
      },
      clauses: [],
    },
    cue_instruction: {
      values: { Intensity: absolute(value) },
      transitions: {},
      transitions_by_attribute: {},
      transitions_by_fixture_attribute: [],
    },
  };
}

/** Builds a cue instruction targeting the loaded Tilt-capable fixture. */
function tiltInstruction(fixtureUid: string, value: number): object {
  return {
    selection: {
      source: {
        type: "Resolved",
        data: [{ fixture_uid: fixtureUid, index: null }],
      },
      clauses: [],
    },
    cue_instruction: {
      values: { Tilt: absolute(value) },
      transitions: {},
      transitions_by_attribute: {},
      transitions_by_fixture_attribute: [],
    },
  };
}

/** Builds one sequence cue for the live backend fixture scenario. */
function cue(
  id: number,
  uid: string,
  label: string,
  instructions: object[],
  lookahead = false,
) {
  return {
    identifiers: { id, uid, label },
    trigger: { type: "Manual" },
    transitions: {},
    transitions_by_attribute: {},
    instructions,
    lookahead: lookahead,
    parts: [],
    tracking_flags: "HTP",
  };
}

/** Builds the sequence used by this spec. */
function sequence(steps: string[] = [CUE_1_UID, CUE_2_UID]): object {
  return {
    identifiers: {
      id: SEQUENCE_ID,
      uid: SEQUENCE_UID,
      label: "Lookahead E2E",
    },
    steps,
    wrap: false,
    release_on_start: false,
    setup_cue: metaCue("b1000001000600010005000000009901", "Setup"),
    release_cue: metaCue("b1000001000600010005000000009902", "Release"),
    default_timing: zeroTransition(),
    tracking_mode: { type: "Inherit" },
  };
}

/** Builds the clip that starts the temporary Lookahead sequence. */
function clip(): object {
  return {
    identifiers: {
      id: CLIP_ID,
      uid: CLIP_UID,
      label: "Lookahead E2E",
    },
    source: { type: "Sequence", data: SEQUENCE_UID },
    priority: 0,
    options: { auto_release: false, deactivate_on_sequence_end: false },
  };
}

/** Builds a timeline that preactivates Lookahead before starting the temporary clip. */
function timeline(): object {
  return {
    identifiers: {
      id: TIMELINE_ID,
      uid: TIMELINE_UID,
      label: "Lookahead Timeline E2E",
    },
    timecode_uid: TIMECODE_UID,
    timecode_start: { secs: 0, nanos: 0 },
    audio_path: "",
    tracks: [
      {
        id: "lookahead-timeline-track",
        label: "Lookahead",
        muted: false,
        solo: false,
        expanded: false,
        automation_lanes: [],
        actions: [
          {
            id: "lookahead-start-clip",
            label: "Start Lookahead",
            position: { secs: 30, nanos: 0 },
            duration: { secs: 0, nanos: 0 },
            action: { type: "StartClip", data: CLIP_UID },
          },
        ],
      },
    ],
    markers: [],
    regions: [],
    bpm: 120,
    beats_per_bar: 4,
    use_beat_grid: false,
    lookahead: "enabled",
    scroll_mode: "free",
  };
}

/** Builds the internal timecode that drives the temporary timeline. */
function timecode(): object {
  return {
    identifiers: {
      id: TIMECODE_ID,
      uid: TIMECODE_UID,
      label: "Lookahead Timeline E2E",
    },
    rate: "Fps30",
    source: "Internal",
  };
}

/** Mirrors stored cue and sequence definitions into frontend stores for editor rendering. */
async function mirrorSequenceForEditor(
  page: Page,
  cueOne: object,
  cueTwo: object,
  sequenceDefinition: object,
): Promise<void> {
  await page.evaluate(
    ({
      cueOne,
      cueTwo,
      cueOneUid,
      cueTwoUid,
      sequenceDefinition,
      sequenceUid,
    }) => {
      const stores = (window as any).appStores;
      stores.cues.set({
        ...stores.cues.get(),
        [cueOneUid]: cueOne,
        [cueTwoUid]: cueTwo,
      });
      stores.sequences.set({
        ...stores.sequences.get(),
        [sequenceUid]: sequenceDefinition,
      });
    },
    {
      cueOne,
      cueTwo,
      cueOneUid: CUE_1_UID,
      cueTwoUid: CUE_2_UID,
      sequenceDefinition,
      sequenceUid: SEQUENCE_UID,
    },
  );
}

/** Seeds a live backend Lookahead playback and waits for lookahead layer data. */
async function seedAndStartLookaheadPlayback(page: Page): Promise<string> {
  const fixtureUid = await findTargetFixtureUid(page);
  const cueOne = cue(CUE_1_ID, CUE_1_UID, "Lookahead current", []);
  const cueTwo = cue(
    CUE_2_ID,
    CUE_2_UID,
    "Lookahead target",
    [tiltInstruction(fixtureUid, 90)],
    true,
  );
  const sequenceDefinition = sequence();

  await sendCommand(page, {
    module: "CueCommand",
    command: {
      type: "StoreCue",
      data: cueOne,
    },
  });
  await sendCommand(page, {
    module: "CueCommand",
    command: {
      type: "StoreCue",
      data: cueTwo,
    },
  });
  await sendCommand(page, {
    module: "CueCommand",
    command: { type: "StoreSequence", data: sequenceDefinition },
  });
  await sendCommand(page, {
    module: "ClipCommand",
    command: { type: "StoreClip", data: clip() },
  });
  await waitForLookaheadClip(page);
  await mirrorSequenceForEditor(page, cueOne, cueTwo, sequenceDefinition);
  await sendCommand(page, {
    module: "ClipCommand",
    command: {
      type: "StartClip",
      data: { type: "Single", data: CLIP_ID },
    },
  });

  await expect
    .poll(
      () =>
        page.evaluate(
          ({ sequenceUid, fixtureUid }) => {
            const layers = (window as any).appStores.layerStack.get() as any[];
            const sequenceLayers = layers.filter(
              (layer) =>
                layer.object_ref?.type === "ByUid" &&
                layer.object_ref.data.object_type === "Sequence" &&
                layer.object_ref.data.uid === sequenceUid,
            );
            return sequenceLayers.some((layer) => {
              const fixtureRow = layer.lookahead_asserted_values?.find(
                (row: any) => row.fixture_uid === fixtureUid,
              );
              return fixtureRow?.parameters?.some(
                (parameters: Record<string, unknown>) => parameters.Tilt,
              );
            });
          },
          { sequenceUid: SEQUENCE_UID, fixtureUid },
        ),
      { timeout: 10_000 },
    )
    .toBe(true);
  return fixtureUid;
}

/** Seeds a live backend sequence matching the editor Lookahead badge scenario. */
async function seedLookaheadSequenceEditorProjection(
  page: Page,
): Promise<void> {
  const targetFixtureUid = await findLookaheadProjectionFixtureUid(page);
  const cueOne = cue(CUE_1_ID, CUE_1_UID, "Lookahead current look", [
    intensityInstruction(targetFixtureUid, 0),
  ]);
  const cueTwo = cue(
    CUE_2_ID,
    CUE_2_UID,
    "Lookahead target tilt",
    [tiltInstruction(targetFixtureUid, 90)],
    true,
  );
  const sequenceDefinition = sequence();

  await sendCommand(page, {
    module: "CueCommand",
    command: {
      type: "StoreCue",
      data: cueOne,
    },
  });
  await sendCommand(page, {
    module: "CueCommand",
    command: {
      type: "StoreCue",
      data: cueTwo,
    },
  });
  await sendCommand(page, {
    module: "CueCommand",
    command: { type: "StoreSequence", data: sequenceDefinition },
  });
  await waitForSequenceEditorSeed(page);
}

/** Seeds a deterministic backend-shaped layer for cue-editor Lookahead projection scoping. */
async function seedScopedLookaheadProjection(page: Page): Promise<void> {
  const targetFixtureUid = await findLookaheadProjectionFixtureUid(page);
  const tiltHeaderFixtureUid = await findTargetFixtureUid(page);
  const cueOne = cue(CUE_1_ID, CUE_1_UID, "Lookahead current look", [
    intensityInstruction(targetFixtureUid, 0),
  ]);
  const cueTwo = cue(
    CUE_2_ID,
    CUE_2_UID,
    "Lookahead target tilt",
    [tiltInstruction(targetFixtureUid, 90)],
    true,
  );
  const cueThree = cue(CUE_3_ID, CUE_3_UID, "Lookahead unrelated edit", [
    intensityInstruction(targetFixtureUid, 0),
    tiltInstruction(tiltHeaderFixtureUid, 0),
  ]);
  const sequenceDefinition = sequence();

  for (const storedCue of [cueOne, cueTwo]) {
    await sendCommand(page, {
      module: "CueCommand",
      command: {
        type: "StoreCue",
        data: storedCue,
      },
    });
  }
  await sendCommand(page, {
    module: "CueCommand",
    command: { type: "StoreSequence", data: sequenceDefinition },
  });
  await waitForSequenceEditorSeed(page);

  await page.evaluate(
    ({ sequenceUid, fixtureUid, cueOneUid, cueTwoUid, unrelatedCue }) => {
      const stores = (window as any).appStores;
      stores.cues.set({
        ...stores.cues.get(),
        [(unrelatedCue as any).identifiers.uid]: unrelatedCue,
      });
      stores.layerStack.set([
        {
          creator: "scoped Lookahead projection",
          object_ref: {
            type: "ByUid",
            data: { object_type: "Sequence", uid: sequenceUid },
          },
          priority: 0,
          is_releasing: false,
          runtime_position: {
            type: "Sequence",
            data: {
              sequence_uid: sequenceUid,
              current_position: 1,
              cue_count: 2,
              current_cue_uid: cueOneUid,
              current_label: "Lookahead current look",
              current_part_count: 0,
              next_position: 2,
              next_cue_uid: cueTwoUid,
              next_label: "Lookahead target tilt",
              next_part_count: 0,
              retained_cues: [],
            },
          },
          asserted_absolute_values: [],
          asserted_relative_values: [],
          lookahead_asserted_values: [
            {
              fixture_uid: fixtureUid,
              parameters: [{ Tilt: { type: "Absolute", data: { value: 90 } } }],
            },
          ],
          computed_values: [],
          computed_transitioning: [],
        },
      ]);
    },
    {
      sequenceUid: SEQUENCE_UID,
      fixtureUid: targetFixtureUid,
      cueOneUid: CUE_1_UID,
      cueTwoUid: CUE_2_UID,
      unrelatedCue: cueThree,
    },
  );
}

/** Waits until the live backend seed is reflected through websocket stores. */
async function waitForSequenceEditorSeed(
  page: Page,
  cueUids: string[] = [CUE_1_UID, CUE_2_UID],
): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          ({ cueUids, sequenceUid }) => {
            const cues = (window as any).appStores.cues.get() ?? {};
            const sequences = (window as any).appStores.sequences.get() ?? {};
            return Boolean(
              cueUids.every((cueUid: string) => cues[cueUid]) &&
                sequences[sequenceUid],
            );
          },
          {
            cueUids,
            sequenceUid: SEQUENCE_UID,
          },
        ),
      { timeout: 10_000 },
    )
    .toBe(true);
}

/** Waits until backend-authored Lookahead projection marks cue 1 as applying cue 2. */
async function waitForSequenceLookaheadProjection(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          ({ cueUid, sequenceUid }) => {
            const state = (
              window as any
            ).appStores.sequenceLookaheadStates.get()?.[sequenceUid];
            const row = state?.rows?.find(
              (candidate: any) =>
                candidate.cue_uid === cueUid && candidate.part_id == null,
            );
            return {
              hasState: Boolean(state),
              hasRow: Boolean(row),
              sourceCueIds: row?.source_cue_ids ?? [],
            };
          },
          { cueUid: CUE_1_UID, sequenceUid: SEQUENCE_UID },
        ),
      { timeout: 10_000 },
    )
    .toEqual({ hasState: true, hasRow: true, sourceCueIds: [CUE_2_ID] });
}

/** Opens the sequence editor for the live backend Lookahead sequence. */
async function openLookaheadSequenceEditor(page: Page): Promise<void> {
  await page.evaluate(
    ({ sequenceUid }) => {
      const api = (window as any).appStores.dockApi.get();
      const panelId = "panel-SequenceEditor-lookahead-live-backend-e2e";
      api.getPanel(panelId)?.api.close();
      const panel = api.addPanel({
        id: panelId,
        component: "SequenceEditor",
        title: "Lookahead Live Backend",
        position: {
          referencePanel: "panel-FixtureGrid",
          direction: "within",
        },
        params: {
          initialPanelId: panelId,
          initialSequenceUid: sequenceUid,
        },
      });
      panel.api.setActive();
      panel.focus();
    },
    { sequenceUid: SEQUENCE_UID },
  );
}

/** Opens the timeline editor for the live backend Lookahead timeline. */
async function openLookaheadTimeline(page: Page): Promise<void> {
  await page.evaluate(
    ({ timelineUid }) => {
      const api = (window as any).appStores.dockApi.get();
      const panelId = "panel-Timeline-lookahead-live-backend-e2e";
      api.getPanel(panelId)?.api.close();
      const panel = api.addPanel({
        id: panelId,
        component: "Timeline",
        title: "Lookahead Timeline",
        position: {
          referencePanel: "panel-FixtureGrid",
          direction: "within",
        },
        params: {
          initialTimelineUid: timelineUid,
        },
      });
      panel.api.setActive();
      panel.focus();
    },
    { timelineUid: TIMELINE_UID },
  );
}

/** Seeds live backend timeline definitions for timeline-owned Lookahead. */
async function seedTimelineLookaheadDefinitions(page: Page): Promise<string> {
  const fixtureUid = await findTargetFixtureUid(page);
  const cueOne = cue(CUE_1_ID, CUE_1_UID, "Lookahead current", []);
  const cueTwo = cue(CUE_2_ID, CUE_2_UID, "Lookahead target", [
    tiltInstruction(fixtureUid, 90),
  ]);
  const sequenceDefinition = sequence();

  await sendCommand(page, {
    module: "CueCommand",
    command: {
      type: "StoreCue",
      data: cueOne,
    },
  });
  await sendCommand(page, {
    module: "CueCommand",
    command: {
      type: "StoreCue",
      data: cueTwo,
    },
  });
  await sendCommand(page, {
    module: "CueCommand",
    command: { type: "StoreSequence", data: sequenceDefinition },
  });
  await sendCommand(page, {
    module: "ClipCommand",
    command: { type: "StoreClip", data: clip() },
  });
  await sendCommand(page, {
    module: "TimecodeCommand",
    command: { type: "StoreTimecode", data: timecode() },
  });
  await sendCommand(page, {
    module: "TimelineCommand",
    command: { type: "StoreTimeline", data: timeline() },
  });
  await waitForLookaheadClip(page);
  await waitForLookaheadTimeline(page);
  await mirrorSequenceForEditor(page, cueOne, cueTwo, sequenceDefinition);
  return fixtureUid;
}

/** Waits for a backend-authored timeline Lookahead status for the temporary action. */
async function waitForTimelineLookaheadActionStatus(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          ({ timelineUid }) => {
            const statusesByTimeline = (
              window as any
            ).appStores.timelineLookaheadActionStatuses.get();
            const statuses = statusesByTimeline?.[timelineUid] ?? {};
            return (
              statuses[
                JSON.stringify([
                  "lookahead-timeline-track",
                  "lookahead-start-clip",
                ])
              ]?.kind ?? null
            );
          },
          { timelineUid: TIMELINE_UID },
        ),
      { timeout: 10_000 },
    )
    .toBe("ready");
}

/** Seeds a live backend timeline playback and waits for timeline-owned Lookahead. */
async function seedAndStartTimelineLookaheadPlayback(
  page: Page,
): Promise<string> {
  const fixtureUid = await seedTimelineLookaheadDefinitions(page);
  await sendCommand(page, {
    module: "TimelineCommand",
    command: { type: "StartTimeline", data: TIMELINE_ID },
  });
  await sendCommand(page, {
    module: "TimecodeCommand",
    command: { type: "StartTimecode", data: TIMECODE_ID },
  });

  await expect
    .poll(
      () =>
        page.evaluate(
          ({ timelineUid, fixtureUid }) => {
            const layers = (window as any).appStores.layerStack.get() as any[];
            const timelineLayers = layers.filter(
              (layer) =>
                layer.object_ref?.type === "ByUid" &&
                layer.object_ref.data.object_type === "Timeline" &&
                layer.object_ref.data.uid === timelineUid,
            );
            return timelineLayers.some((layer) => {
              const fixtureRow = layer.lookahead_asserted_values?.find(
                (row: any) => row.fixture_uid === fixtureUid,
              );
              return fixtureRow?.parameters?.some(
                (parameters: Record<string, unknown>) => parameters.Tilt,
              );
            });
          },
          { timelineUid: TIMELINE_UID, fixtureUid },
        ),
      { timeout: 10_000 },
    )
    .toBe(true);
  return fixtureUid;
}

/** Opens the cue editor to one cue with tracked and Lookahead values visible. */
async function openCueEditorForCue(page: Page, cueUid: string): Promise<void> {
  await page.evaluate(
    ({ cueUid, sequenceId }) => {
      const api = (window as any).appStores.dockApi.get();
      const panelId = `panel-CueEditor-lookahead-e2e-${cueUid}`;
      api.getPanel(panelId)?.api.close();
      const panel = api.addPanel({
        id: panelId,
        component: "CueEditor",
        title: "Lookahead E2E",
        position: {
          referencePanel: "panel-FixtureGrid",
          direction: "within",
        },
        params: {
          initialPanelId: panelId,
          initialCueUid: cueUid,
          initialPartId: 0,
          initialSequenceId: sequenceId,
        },
      });
      panel.api.setActive();
      panel.focus();
    },
    { cueUid, sequenceId: SEQUENCE_ID },
  );

  const toggleTracked = page.getByRole("button", {
    name: "Toggle tracked values",
  });
  await expect(toggleTracked).toBeVisible();
  const pressed = await toggleTracked.getAttribute("aria-pressed");
  if (pressed !== "true") {
    await toggleTracked.click();
  }
}

/** Opens cue 1 in the cue editor with tracked and Lookahead values visible. */
async function openCueEditorForCueOne(page: Page): Promise<void> {
  await openCueEditorForCue(page, CUE_1_UID);
}

/** Stops playback, deletes every owned definition, and proves blank teardown. */
async function cleanupLookaheadPlayback(page: Page): Promise<void> {
  const results = await page.evaluate(
    async ({
      cueIds,
      cueUids,
      clipId,
      clipUid,
      fixtureIds,
      sequenceId,
      sequenceUid,
      syntheticCueUid,
      timecodeId,
      timecodeUid,
      timelineId,
      timelineUid,
    }) => {
      const stores = (window as any).appStores;
      stores.layerStack.set([]);
      const cuesWithoutSyntheticProjection = { ...stores.cues.get() };
      delete cuesWithoutSyntheticProjection[syntheticCueUid];
      stores.cues.set(cuesWithoutSyntheticProjection);

      if (stores.timelines.get()[timelineUid]) {
        await stores.send({
          module: "TimelineCommand",
          command: { type: "StopTimeline", data: timelineId },
        });
      }
      if (stores.timecodes.get()[timecodeUid]) {
        await stores.send({
          module: "TimecodeCommand",
          command: { type: "StopTimecode", data: timecodeId },
        });
      }
      const clipHasBoundPlayback = (
        Object.values(stores.activeInstances.get()) as any[]
      ).some((playback) => playback.bound_clip_id === clipId);
      if (clipHasBoundPlayback) {
        await stores.send({
          module: "ClipCommand",
          command: {
            type: "StopClip",
            data: { type: "Single", data: clipId },
          },
        });
        const stopDeadline = Date.now() + 10_000;
        while (
          Date.now() < stopDeadline &&
          (Object.values(stores.activeInstances.get()) as any[]).some(
            (playback) => playback.bound_clip_id === clipId,
          )
        ) {
          await new Promise((resolve) => window.setTimeout(resolve, 50));
        }
        if (
          (Object.values(stores.activeInstances.get()) as any[]).some(
            (playback) => playback.bound_clip_id === clipId,
          )
        ) {
          throw new Error("owned Lookahead clip did not stop");
        }
      }

      const outcomes: any[] = [];

      /** Deletes one present definition and records its correlated outcome. */
      const removeIfPresent = async (
        present: boolean,
        message: object,
      ): Promise<void> => {
        if (present) {
          outcomes.push(await stores.sendAndAwait(message));
        }
      };

      await removeIfPresent(Boolean(stores.clips.get()[clipUid]), {
        module: "ClipCommand",
        command: { type: "DeleteClip", data: clipId },
      });
      for (const [cueId, cueUid] of cueIds.map((id: number, index: number) => [
        id,
        cueUids[index],
      ])) {
        await removeIfPresent(Boolean(stores.cues.get()[cueUid]), {
          module: "CueCommand",
          command: {
            type: "DeleteCue",
            data: { sequence_id: sequenceId, cue_id: cueId },
          },
        });
      }
      await removeIfPresent(Boolean(stores.sequences.get()[sequenceUid]), {
        module: "CueCommand",
        command: { type: "DeleteSequence", data: sequenceId },
      });
      await removeIfPresent(Boolean(stores.timelines.get()[timelineUid]), {
        module: "TimelineCommand",
        command: { type: "DeleteTimeline", data: timelineId },
      });
      await removeIfPresent(Boolean(stores.timecodes.get()[timecodeUid]), {
        module: "TimecodeCommand",
        command: { type: "DeleteTimecode", data: timecodeId },
      });
      for (const fixtureId of fixtureIds) {
        const fixtureIsPresent = (
          Object.values(stores.fixtures.get()) as any[]
        ).some((fixture) => fixture.identifiers.id === fixtureId);
        await removeIfPresent(fixtureIsPresent, {
          module: "FixtureCommand",
          command: { type: "DeleteFixture", data: fixtureId },
        });
      }
      return outcomes;
    },
    {
      cueIds: [CUE_2_ID, CUE_1_ID],
      cueUids: [CUE_2_UID, CUE_1_UID],
      clipId: CLIP_ID,
      clipUid: CLIP_UID,
      fixtureIds: [PROJECTION_FIXTURE_ID, TARGET_FIXTURE_ID],
      sequenceId: SEQUENCE_ID,
      sequenceUid: SEQUENCE_UID,
      syntheticCueUid: CUE_3_UID,
      timecodeId: TIMECODE_ID,
      timecodeUid: TIMECODE_UID,
      timelineId: TIMELINE_ID,
      timelineUid: TIMELINE_UID,
    },
  );
  for (const result of results) {
    expect(result.outcome.type, JSON.stringify(result)).toBe("Succeeded");
  }
  await expect
    .poll(() =>
      page.evaluate(() => {
        const stores = (window as any).appStores;
        return {
          activeInstances: Object.keys(stores.activeInstances.get()).length,
          cues: Object.keys(stores.cues.get()).length,
          clips: Object.keys(stores.clips.get()).length,
          fixtures: Object.keys(stores.fixtures.get()).length,
          sequences: Object.keys(stores.sequences.get()).length,
          timecodes: Object.keys(stores.timecodes.get()).length,
          timelines: Object.keys(stores.timelines.get()).length,
        };
      }),
    )
    .toEqual({
      activeInstances: 0,
      cues: 0,
      clips: 0,
      fixtures: 0,
      sequences: 0,
      timecodes: 0,
      timelines: 0,
    });
}

/** Verifies live backend Lookahead and cue-sheet projection. */
test("lookahead preactivates sequence-local dark fixtures before cue entry", async ({
  backendSlot,
  page,
}) => {
  await openLookaheadTestApp(page, backendSlot.backendPort);

  try {
    await seedAndStartLookaheadPlayback(page);
    await openCueEditorForCueOne(page);

    const grid = page
      .locator('[data-grid-owner="cue-editor"]')
      .locator('[data-grid-kind="tanstack"]');
    await expect(grid).toBeVisible();
    await expect(
      gridHeaderByColumnKey(grid, cueGridAttributeValueColumnKey("Tilt")),
    ).toBeVisible();
    const tiltCell = await gridCellByIdentifier(grid, {
      columnKey: cueGridAttributeValueColumnKey("Tilt"),
      identifierColumnKey: "id",
      identifierText: String(TARGET_FIXTURE_ID),
    });
    await expect(tiltCell).toContainText("90");
  } finally {
    await cleanupLookaheadPlayback(page);
  }
});

/** Verifies cue-editor backend Lookahead projections only apply to the layer's current cue. */
test("cue editor scopes backend lookahead projection to edited cue", async ({
  backendSlot,
  page,
}) => {
  await openLookaheadTestApp(page, backendSlot.backendPort);

  try {
    await seedScopedLookaheadProjection(page);
    await openCueEditorForCue(page, CUE_3_UID);

    const grid = page
      .locator('[data-grid-owner="cue-editor"]')
      .locator('[data-grid-kind="tanstack"]');
    await expect(grid).toBeVisible();
    await expect(
      gridHeaderByColumnKey(grid, cueGridAttributeValueColumnKey("Tilt")),
    ).toBeVisible();
    const tiltCell = await gridCellByIdentifier(grid, {
      columnKey: cueGridAttributeValueColumnKey("Tilt"),
      identifierColumnKey: "id",
      identifierText: String(PROJECTION_FIXTURE_ID),
    });
    await expect(tiltCell).not.toContainText("90");
  } finally {
    await cleanupLookaheadPlayback(page);
  }
});

/** Verifies the sequence editor renders backend-authored Lookahead source badges. */
test("sequence editor shows live backend lookahead source cue badge", async ({
  backendSlot,
  page,
}) => {
  await openLookaheadTestApp(page, backendSlot.backendPort);

  try {
    await seedLookaheadSequenceEditorProjection(page);
    await waitForSequenceLookaheadProjection(page);
    await openLookaheadSequenceEditor(page);

    const grid = page
      .locator(
        '[data-panel-id="panel-SequenceEditor-lookahead-live-backend-e2e"] [data-grid-owner="sequence-editor"]',
      )
      .locator('[data-grid-kind="tanstack"]');
    await expect(grid).toBeVisible();
    const cueOneMibCell = gridCellByKey(grid, {
      columnKey: "lookahead",
      rowKey: `${CUE_1_UID}:cue`,
    });
    await expect(cueOneMibCell).toContainText(String(CUE_2_ID));
    const sourceBadge = cueOneMibCell.getByText(String(CUE_2_ID), {
      exact: true,
    });
    const checkbox = cueOneMibCell.locator('input[type="checkbox"]');
    await expect(sourceBadge).toBeVisible();
    await expect(checkbox).toBeVisible();

    const [cellBox, checkboxBox, badgeBox] = await Promise.all([
      cueOneMibCell.boundingBox(),
      checkbox.boundingBox(),
      sourceBadge.boundingBox(),
    ]);
    if (!cellBox || !checkboxBox || !badgeBox) {
      throw new Error(
        "expected Lookahead cell, checkbox, and source badge boxes",
      );
    }
    const cellCenterX = cellBox.x + cellBox.width / 2;
    const checkboxCenterX = checkboxBox.x + checkboxBox.width / 2;
    expect(Math.abs(checkboxCenterX - cellCenterX)).toBeLessThan(3);
    expect(badgeBox.x).toBeGreaterThan(checkboxBox.x + checkboxBox.width);
    expect(badgeBox.x + badgeBox.width).toBeGreaterThan(
      cellBox.x + cellBox.width - 12,
    );
  } finally {
    await cleanupLookaheadPlayback(page);
  }
});

/** Verifies stopped timelines still publish backend-owned Lookahead item badge state. */
test("lookahead reports timeline action status while stopped", async ({
  backendSlot,
  page,
}) => {
  await openLookaheadTestApp(page, backendSlot.backendPort);

  try {
    await seedTimelineLookaheadDefinitions(page);
    await waitForTimelineLookaheadActionStatus(page);
    await openLookaheadTimeline(page);

    await page.getByLabel("Timeline zoom").fill("20");
    const item = page.locator(
      '[data-timeline-action="true"][data-track-id="lookahead-timeline-track"][data-action-id="lookahead-start-clip"]',
    );
    await expect(item).toBeVisible();
    await expect(
      item.locator('[data-timeline-lookahead-status="ready"]'),
    ).toBeVisible();
  } finally {
    await cleanupLookaheadPlayback(page);
  }
});

/** Verifies live backend timeline Lookahead preactivates before the clip starts. */
test("lookahead preactivates timeline-started sequence before clip start", async ({
  backendSlot,
  page,
}) => {
  await openLookaheadTestApp(page, backendSlot.backendPort);

  try {
    await seedAndStartTimelineLookaheadPlayback(page);
  } finally {
    await cleanupLookaheadPlayback(page);
  }
});
