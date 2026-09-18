// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

const FIXTURE_ID = 311;
const CUE_ID = 1;
const SEQUENCE_ID = 93_311;
const CLIP_ID = 93_311;
const TIMELINE_ID = 93_311;
const TIMECODE_ID = 93_311;
const CUE_UID = "a3110000000000000000000000000001";
const SETUP_CUE_UID = "a3110000000000000000000000000002";
const RELEASE_CUE_UID = "a3110000000000000000000000000003";
const SEQUENCE_UID = "a3110000000000000000000000000004";
const CLIP_UID = "a3110000000000000000000000000005";
const TIMELINE_UID = "a3110000000000000000000000000006";
const TIMECODE_UID = "a3110000000000000000000000000007";

interface FixtureOutputChange {
  after: string;
  before: string;
  fixtureId: string;
  sampleIndex: number;
}

/** Replaces each backend and proves the playback graph is fully disposable. */
test.afterEach(async ({ backendSlot, page }) => {
  await prepareFreshBackendShowfile(backendSlot.backendPort);
  if (page.isClosed() || page.url() === "about:blank") return;
  await page.reload();
  await waitForDockviewApp(page);
  await expect
    .poll(() => ownedPlaybackStoreState(page))
    .toEqual({
      activeInstances: 0,
      cues: 0,
      clips: 0,
      fixtures: 0,
      sequences: 0,
      timecodes: 0,
      timelines: 0,
    });
});

/** Reads every mutable backend store used by the owned playback graph. */
async function ownedPlaybackStoreState(page: Page): Promise<object> {
  return page.evaluate(() => {
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
  });
}

/** Opens the app against a fresh backend and verifies all owned stores are blank. */
async function openOwnedJitterApp(
  page: Page,
  backendPort: number,
): Promise<void> {
  await prepareFreshBackendShowfile(backendPort);
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("nightfall.currentShowfileName", "default");
  });
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await expect(page.locator("main#app")).toBeVisible();
  await waitForDockviewApp(page);
  await page.waitForFunction(
    () =>
      typeof (window as any).appStores?.sendAndAwait === "function" &&
      Boolean((window as any).appStores?.activeInstances?.get) &&
      Boolean((window as any).appStores?.cues?.get) &&
      Boolean((window as any).appStores?.clips?.get) &&
      Boolean((window as any).appStores?.fixtures?.get) &&
      Boolean((window as any).appStores?.sequences?.get) &&
      Boolean((window as any).appStores?.timecodes?.get) &&
      Boolean((window as any).appStores?.timelines?.get),
  );
  await expect
    .poll(() => ownedPlaybackStoreState(page))
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

/** Sends one backend command and rejects a failed terminal outcome. */
async function sendCommand(page: Page, data: object): Promise<void> {
  const result = await page.evaluate(
    async (commandData) => (window as any).appStores.sendAndAwait(commandData),
    data,
  );
  expect(result.outcome.type, JSON.stringify(result)).toBe("Succeeded");
}

/** Builds an inline absolute parameter value for cue instructions. */
function absolute(value: number): object {
  return {
    type: "Inline",
    data: { type: "Absolute", data: { value } },
  };
}

/** Builds the fixed zero duration used by the owned sequence. */
function fixedZero(): object {
  return { type: "Fixed", data: { secs: 0, nanos: 0 } };
}

/** Builds a complete zero-length transition for the owned sequence. */
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

/** Builds one sequence setup or release cue with no fixture instructions. */
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

/** Builds the RGB cue that produces stable multi-element fixture output. */
function pixelCue(fixtureUid: string): object {
  return {
    identifiers: { id: CUE_ID, uid: CUE_UID, label: "Owned Pixel Output" },
    trigger: { type: "Manual" },
    transitions: {},
    transitions_by_attribute: {},
    instructions: [
      {
        selection: {
          source: {
            type: "Resolved",
            data: [{ fixture_uid: fixtureUid, index: null }],
          },
          clauses: [],
        },
        cue_instruction: {
          values: {
            Blue: absolute(40),
            Green: absolute(20),
            Red: absolute(180),
          },
          transitions: {},
          transitions_by_attribute: {},
          transitions_by_fixture_attribute: [],
        },
      },
    ],
    parts: [],
    tracking_flags: "HTP",
  };
}

/** Builds the sequence started when the owned timeline crosses five seconds. */
function sequence(): object {
  return {
    identifiers: {
      id: SEQUENCE_ID,
      uid: SEQUENCE_UID,
      label: "Owned Pixel Sequence",
    },
    steps: [CUE_UID],
    wrap: false,
    release_on_start: false,
    setup_cue: metaCue(SETUP_CUE_UID, "Setup"),
    release_cue: metaCue(RELEASE_CUE_UID, "Release"),
    default_timing: zeroTransition(),
    tracking_mode: { type: "Inherit" },
  };
}

/** Builds the clip targeted by the owned timeline action. */
function clip(): object {
  return {
    identifiers: {
      id: CLIP_ID,
      uid: CLIP_UID,
      label: "Owned Pixel Clip",
    },
    source: { type: "Sequence", data: SEQUENCE_UID },
    priority: 0,
    options: { auto_release: false, deactivate_on_sequence_end: false },
  };
}

/** Builds the internal timecode that drives the owned timeline. */
function timecode(): object {
  return {
    identifiers: {
      id: TIMECODE_ID,
      uid: TIMECODE_UID,
      label: "Owned Pixel Timecode",
    },
    rate: "Fps30",
    source: "Internal",
  };
}

/** Builds a timeline that starts the owned clip at five seconds. */
function timeline(): object {
  return {
    identifiers: {
      id: TIMELINE_ID,
      uid: TIMELINE_UID,
      label: "Owned Pixel Timeline",
    },
    timecode_uid: TIMECODE_UID,
    timecode_start: { secs: 0, nanos: 0 },
    trigger_mode: "FollowTimecode",
    audio_path: "",
    tracks: [
      {
        id: "owned-pixel-track",
        label: "Owned Pixel Output",
        muted: false,
        solo: false,
        expanded: false,
        automation_lanes: [],
        actions: [
          {
            id: "owned-pixel-start-clip",
            label: "Start Owned Pixel Clip",
            position: { secs: 5, nanos: 0 },
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
    lookahead: "disabled",
    scroll_mode: "free",
  };
}

/** Creates the exact fixture and playback graph exercised by this scenario. */
async function storeOwnedPlaybackGraph(page: Page): Promise<void> {
  await sendCommand(page, {
    module: "FixtureLibraryCommand",
    command: {
      type: "CreateFixtureFromLibrary",
      data: {
        id: FIXTURE_ID,
        make: "Generic",
        model: "RGBPixelTape 120ch RGB",
        mode: "RGB",
        label: "Owned Paused Pixel Tape",
        update_existing_ids: [],
        update_existing_only: false,
      },
    },
  });
  await expect
    .poll(() =>
      page.evaluate((fixtureId) => {
        const fixture = (
          Object.values((window as any).appStores.fixtures.get()) as any[]
        ).find((candidate) => candidate.identifiers.id === fixtureId);
        return fixture
          ? {
              elementCount: fixture.elements.length,
              uid: fixture.identifiers.uid,
            }
          : null;
      }, FIXTURE_ID),
    )
    .toMatchObject({ elementCount: 40 });
  const fixtureUid = await page.evaluate((fixtureId) => {
    const fixture = (
      Object.values((window as any).appStores.fixtures.get()) as any[]
    ).find((candidate) => candidate.identifiers.id === fixtureId);
    if (!fixture) throw new Error(`owned fixture ${fixtureId} not found`);
    return fixture.identifiers.uid;
  }, FIXTURE_ID);

  await sendCommand(page, {
    module: "CueCommand",
    command: { type: "StoreCue", data: pixelCue(fixtureUid) },
  });
  await sendCommand(page, {
    module: "CueCommand",
    command: { type: "StoreSequence", data: sequence() },
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

  await expect
    .poll(() => ownedPlaybackStoreState(page))
    .toEqual({
      activeInstances: 0,
      cues: 1,
      clips: 1,
      fixtures: 1,
      sequences: 1,
      timecodes: 1,
      timelines: 1,
    });
}

/** Plays the owned timeline and pauses after its fixture-output item fires. */
async function playAndPauseOwnedTimeline(page: Page): Promise<void> {
  await sendCommand(page, {
    module: "InstanceCommand",
    command: { type: "StopAll" },
  });
  await sendCommand(page, {
    module: "TimecodeCommand",
    command: {
      type: "SeekTimecode",
      data: {
        id: TIMECODE_ID,
        position: { secs: 4, nanos: 900_000_000 },
      },
    },
  });
  await sendCommand(page, {
    module: "TimecodeCommand",
    command: { type: "StartTimecode", data: TIMECODE_ID },
  });
  await page.waitForTimeout(700);
  await sendCommand(page, {
    module: "TimecodeCommand",
    command: { type: "PauseTimecode", data: TIMECODE_ID },
  });
}

/** Stops the owned timecode and clip playback after output assertions. */
async function stopOwnedPlayback(page: Page): Promise<void> {
  await sendCommand(page, {
    module: "TimecodeCommand",
    command: { type: "StopTimecode", data: TIMECODE_ID },
  });
  await sendCommand(page, {
    module: "InstanceCommand",
    command: { type: "StopAll" },
  });
}

/** Waits until websocket-backed stores have hydrated multi-element fixture output. */
async function waitForMultiElementFixtureOutput(page: Page): Promise<void> {
  await expect(page.locator("main#app")).toBeVisible();
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const stores = (window as any).appStores;
          if (!stores?.parameters?.get || !stores?.fixtures?.get) return 0;
          const fixtures = stores.fixtures.get();
          const parameters = stores.parameters.get();
          return Array.from(parameters.values()).filter((param: any) => {
            const fixture = fixtures[param.uid];
            const fixtureId = Number(fixture?.identifiers?.id);
            return (
              fixtureId >= 300 &&
              fixtureId < 400 &&
              fixture?.elements?.length > 1 &&
              Array.isArray(param.elements) &&
              param.elements.length > 1
            );
          }).length;
        }),
      { timeout: 15_000 },
    )
    .toBeGreaterThan(0);
}

/** Samples multi-element fixture output signatures while the timeline is paused. */
async function samplePausedFixtureOutputChanges(
  page: Page,
): Promise<FixtureOutputChange[]> {
  return page.evaluate(() => {
    const stores = (window as any).appStores;

    /** Builds stable row signatures for visible RGBPixelTape multi-element output. */
    const snapshot = () => {
      const fixtures = stores.fixtures.get();
      const parameters = stores.parameters.get();
      const rows: Array<[string, string]> = [];

      for (const param of parameters.values() as Iterable<any>) {
        const fixture = fixtures[param.uid];
        const fixtureId = Number(fixture?.identifiers?.id);
        if (
          !fixture ||
          fixtureId < 300 ||
          fixtureId >= 400 ||
          fixture.elements?.length <= 1 ||
          !Array.isArray(param.elements)
        ) {
          continue;
        }

        const rawEntries = Object.entries(param.raw ?? {})
          .filter(([, value]) => typeof value === "number")
          .map(([attribute, value]) => [
            attribute,
            Math.round((value as number) * 10) / 10,
          ])
          .sort(([left], [right]) => String(left).localeCompare(String(right)));
        const conflicts = Array.from(param.conflicts ?? []).sort();
        rows.push([
          String(fixture.identifiers?.id ?? param.uid),
          `${JSON.stringify(conflicts)}|${JSON.stringify(rawEntries)}`,
        ]);
      }

      return rows.sort(([left], [right]) => left.localeCompare(right));
    };

    return new Promise<FixtureOutputChange[]>((resolve) => {
      const samples: Array<Array<[string, string]>> = [];

      /** Records one paused output snapshot and schedules the next sample. */
      const collect = () => {
        samples.push(snapshot());
        if (samples.length < 16) {
          window.setTimeout(collect, 100);
          return;
        }

        const baseline = new Map(samples[0] ?? []);
        const changes: FixtureOutputChange[] = [];
        for (const [index, sample] of samples.entries()) {
          for (const [fixtureId, after] of sample) {
            const before = baseline.get(fixtureId) ?? "";
            if (after !== before) {
              changes.push({ after, before, fixtureId, sampleIndex: index });
            }
          }
        }
        resolve(changes.slice(0, 5));
      };

      collect();
    });
  });
}

/** Waits until RGBPixelTape output stops changing after seek/play/pause propagation. */
async function waitForPausedFixtureOutputToSettle(page: Page): Promise<void> {
  await expect
    .poll(async () => samplePausedFixtureOutputChanges(page), {
      timeout: 8_000,
      intervals: [500],
    })
    .toEqual([]);
}

/**
 * Verifies paused timeline playback freezes RGBPixelTape fixture output and
 * aggregate conflict state after seek/play/pause output propagation settles.
 */
test("paused multi-element fixture output remains stable after timeline playback", async ({
  backendSlot,
  page,
}) => {
  await openOwnedJitterApp(page, backendSlot.backendPort);
  await storeOwnedPlaybackGraph(page);

  try {
    await playAndPauseOwnedTimeline(page);
    await waitForMultiElementFixtureOutput(page);
    await waitForPausedFixtureOutputToSettle(page);

    await expect(await samplePausedFixtureOutputChanges(page)).toEqual([]);
  } finally {
    await stopOwnedPlayback(page);
  }
});
