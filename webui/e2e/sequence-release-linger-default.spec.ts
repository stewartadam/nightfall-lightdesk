// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

const CUE_ID = 997_101;
const CUE_UID = "99710100-0000-0000-0000-000000000001";
const COMMAND_INPUT_SELECTOR = "#header-cmdline";
const CLIP_ID = 15;
const CLIP_UID = "99710100-0000-0000-0000-0000000000ee";
const FIXTURE_ID = 997_101;
const RELEASE_DURATION_MS = 2_000;
const SEQUENCE_ID = 997_101;
const SEQUENCE_UID = "99710100-0000-0000-0000-000000000099";

type OwnedRgbFixture = {
  fixtureId: number;
  fixtureUid: string;
  elementIndex: number;
  rgbElementIndices: number[];
};

type OutputSnapshot = {
  peak: number;
};

/** Builds an inline absolute-percent value for owned cue instructions. */
function inlinePercent(value: number): object {
  return {
    type: "Inline",
    data: { type: "AbsolutePercent", data: { value } },
  };
}

/** Builds a fixed transition duration for owned sequence timing. */
function fixed(secs: number): object {
  return {
    type: "Fixed",
    data: { secs, nanos: 0 },
  };
}

/** Builds deterministic metadata cue UIDs from the owned sequence UID. */
function sequenceMetaCueUid(sequenceUid: string, suffix: string): string {
  return sequenceUid.replace(/[0-9a-f]{12}$/i, suffix);
}

/** Builds an empty setup or release metadata cue. */
function metaCue(cueUid: string, label: string): Record<string, unknown> {
  return {
    identifiers: {
      id: 0,
      uid: cueUid,
      label,
    },
    trigger: { type: "Manual" },
    transitions: {},
    transitions_by_attribute: {},
    instructions: [],
    parts: [],
    references: {},
    tracking_flags: "HTP",
  };
}

/** Builds the nonzero RGB look exercised by release playback. */
function playbackCue(fixture: OwnedRgbFixture): object {
  return {
    identifiers: {
      id: CUE_ID,
      uid: CUE_UID,
      label: "Owned Release Linger Look",
    },
    trigger: { type: "Manual" },
    transitions: {},
    transitions_by_attribute: {},
    instructions: [
      {
        selection: {
          source: {
            type: "Resolved",
            data: fixture.rgbElementIndices.map((index) => ({
              fixture_uid: fixture.fixtureUid,
              index,
            })),
          },
          clauses: [],
        },
        cue_instruction: {
          values: {
            Intensity: inlinePercent(1),
            VirtualIntensity: inlinePercent(1),
            Red: inlinePercent(1),
            Green: inlinePercent(0),
            Blue: inlinePercent(0),
          },
          transitions: {},
          transitions_by_attribute: {},
          transitions_by_fixture_attribute: [],
        },
      },
    ],
    parts: [],
    references: {},
    tracking_flags: "HTP",
  };
}

/** Builds a one-step sequence with a two-second global release fade. */
function playbackSequence(): object {
  return {
    identifiers: {
      id: SEQUENCE_ID,
      uid: SEQUENCE_UID,
      label: "Owned Release Linger Sequence",
    },
    steps: [CUE_UID],
    references: {},
    wrap: false,
    release_on_start: false,
    setup_cue: metaCue(
      sequenceMetaCueUid(SEQUENCE_UID, "000000000000"),
      "Setup",
    ),
    release_cue: {
      ...metaCue(sequenceMetaCueUid(SEQUENCE_UID, "000000000003"), "Release"),
      transitions: { fade_out: fixed(RELEASE_DURATION_MS / 1_000) },
    },
    default_timing: {
      delay_in: fixed(0),
      fade_in: fixed(0),
      curve_in: "Linear",
      delay_out: fixed(0),
      fade_out: fixed(0),
      curve_out: "Linear",
    },
    tracking_mode: { type: "Flags", data: "HTP" },
  };
}

/** Builds the clip bound to the owned release sequence. */
function playbackClip(): object {
  return {
    identifiers: {
      id: CLIP_ID,
      uid: CLIP_UID,
      label: "Owned Release Linger Clip",
    },
    source: { type: "Sequence", data: SEQUENCE_UID },
    priority: 0,
    options: { auto_release: false, deactivate_on_sequence_end: false },
  };
}

/** Opens the release scenario against a fresh, empty backend showfile. */
async function openOwnedReleaseApp(
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
  await expect(page.locator(COMMAND_INPUT_SELECTOR)).toBeVisible();
  await page.waitForFunction(
    () =>
      typeof (window as any).appStores?.sendAndAwait === "function" &&
      typeof (window as any).appStores?.getParametersImmediate === "function" &&
      Boolean((window as any).appStores?.fixtures?.get),
    undefined,
    { timeout: 20_000 },
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
        };
      }),
    )
    .toEqual({ cues: 0, clips: 0, fixtures: 0, sequences: 0 });
}

/** Sends a backend command and requires its terminal success result. */
async function sendCommand(page: Page, data: object): Promise<void> {
  await page.evaluate(async (commandData) => {
    const stores = (window as any).appStores;
    if (typeof stores?.sendAndAwait !== "function") {
      throw new Error("appStores.sendAndAwait did not initialize");
    }
    let timeoutId: number | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutId = window.setTimeout(
        () =>
          reject(
            new Error(
              `timed out awaiting command outcome: ${JSON.stringify(commandData)}`,
            ),
          ),
        15_000,
      );
    });
    const result = await Promise.race([
      stores.sendAndAwait(commandData),
      timeout,
    ]).finally(() => {
      window.clearTimeout(timeoutId);
    });
    if (result.outcome.type !== "Succeeded") {
      throw new Error(`release command failed: ${JSON.stringify(result)}`);
    }
  }, data);
}

/** Submits a lifecycle command through the operator-facing command input. */
async function submitCommand(page: Page, command: string): Promise<void> {
  const input = page.locator(COMMAND_INPUT_SELECTOR);
  await input.fill(command);
  await input.press("Enter");
  await expect(input).toHaveValue("");
}

/** Stores a complete RGB fixture and returns its exact playback references. */
async function storeOwnedRgbFixture(page: Page): Promise<OwnedRgbFixture> {
  await sendCommand(page, {
    module: "FixtureLibraryCommand",
    command: {
      type: "CreateFixtureFromLibrary",
      data: {
        id: FIXTURE_ID,
        make: "Generic",
        model: "Moving Head RGBW",
        mode: "Spot",
        label: "Owned Release Linger RGB Fixture",
        update_existing_ids: [],
        update_existing_only: false,
      },
    },
  });
  await expect
    .poll(() =>
      page.evaluate((fixtureId) => {
        const fixtures = Object.values(
          (window as any).appStores.fixtures.get(),
        ) as any[];
        return fixtures.some((fixture) => fixture.identifiers.id === fixtureId);
      }, FIXTURE_ID),
    )
    .toBe(true);

  return page.evaluate((fixtureId) => {
    const fixtures = Object.values(
      (window as any).appStores.fixtures.get(),
    ) as any[];
    const fixture = fixtures.find(
      (candidate) => candidate.identifiers.id === fixtureId,
    );
    if (!fixture) throw new Error("owned release fixture did not hydrate");
    const rgbElementIndices = fixture.elements.flatMap(
      (element: any, index: number) => {
        const attributes = new Set(
          element.parameters.map((parameter: any) => parameter.attribute?.type),
        );
        return (attributes.has("Intensity") ||
          attributes.has("VirtualIntensity")) &&
          attributes.has("Red") &&
          attributes.has("Green") &&
          attributes.has("Blue")
          ? [index + 1]
          : [];
      },
    );
    if (rgbElementIndices.length === 0) {
      throw new Error(
        "owned release fixture has no intensity-and-RGB-capable element",
      );
    }
    return {
      fixtureId,
      fixtureUid: fixture.identifiers.uid,
      elementIndex: rgbElementIndices[0],
      rgbElementIndices,
    };
  }, FIXTURE_ID);
}

/** Waits for deferred backend stores to be visible to dependent commands. */
async function waitForBackendCommandDrain(page: Page): Promise<void> {
  await page.waitForTimeout(650);
}

/** Stores the owned cue, sequence, and clip in dependency order. */
async function storeOwnedPlayback(
  page: Page,
  fixture: OwnedRgbFixture,
): Promise<void> {
  await sendCommand(page, {
    module: "CueCommand",
    command: { type: "StoreCue", data: playbackCue(fixture) },
  });
  await sendCommand(page, {
    module: "CueCommand",
    command: { type: "StoreSequence", data: playbackSequence() },
  });
  await waitForBackendCommandDrain(page);
  await sendCommand(page, {
    module: "ClipCommand",
    command: { type: "StoreClip", data: playbackClip() },
  });
  await waitForBackendCommandDrain(page);
  await expect
    .poll(() =>
      page.evaluate(
        ({ cueId, clipId, sequenceId }) => {
          const stores = (window as any).appStores;
          const cues = Object.values(stores.cues.get()) as any[];
          const clips = Object.values(stores.clips.get()) as Array<
            [any, boolean]
          >;
          const sequences = Object.values(stores.sequences.get()) as any[];
          return {
            cue: cues.some((cue) => cue.identifiers.id === cueId),
            clip: clips.some(([clip]) => clip.identifiers.id === clipId),
            sequence: sequences.some(
              (sequence) => sequence.identifiers.id === sequenceId,
            ),
          };
        },
        {
          cueId: CUE_ID,
          clipId: CLIP_ID,
          sequenceId: SEQUENCE_ID,
        },
      ),
    )
    .toEqual({ cue: true, clip: true, sequence: true });
}

/** Reads live output for the exact fixture element owned by this scenario. */
async function outputSnapshot(
  page: Page,
  fixture: OwnedRgbFixture,
): Promise<OutputSnapshot> {
  return page.evaluate(({ fixtureUid, elementIndex }) => {
    const stores = (window as any).appStores;
    const normalizedUid = fixtureUid.replaceAll("-", "").toLowerCase();
    const outputs = stores.getParametersImmediate();
    const rows = outputs.get(fixtureUid) ?? outputs.get(normalizedUid) ?? [];
    const row = rows[elementIndex - 1] ?? {};
    const values = [
      row.VirtualIntensity,
      row.Intensity,
      row.Red,
      row.Green,
      row.Blue,
    ].filter((value): value is number => typeof value === "number");
    return { peak: Math.max(0, ...values) };
  }, fixture);
}

/** Removes every fixture and instance record owned by the release scenario. */
async function cleanupOwnedPlayback(
  page: Page,
  fixture: OwnedRgbFixture,
): Promise<void> {
  const hasActivePlayback = await page.evaluate((clipId) => {
    const instances = Object.values(
      (window as any).appStores.activeInstances.get(),
    ) as Array<{ bound_clip_id?: number }>;
    return instances.some((playback) => playback.bound_clip_id === clipId);
  }, CLIP_ID);
  if (hasActivePlayback) {
    await submitCommand(page, `exec ${CLIP_ID} stop`);
    await expect
      .poll(() =>
        page.evaluate((clipId) => {
          const instances = Object.values(
            (window as any).appStores.activeInstances.get(),
          ) as Array<{ bound_clip_id?: number }>;
          return instances.filter(
            (playback) => playback.bound_clip_id === clipId,
          ).length;
        }, CLIP_ID),
      )
      .toBe(0);
  }
  await sendCommand(page, {
    module: "ClipCommand",
    command: { type: "DeleteClip", data: CLIP_ID },
  });
  await waitForBackendCommandDrain(page);
  await sendCommand(page, {
    module: "CueCommand",
    command: {
      type: "DeleteCue",
      data: { sequence_id: SEQUENCE_ID, cue_id: CUE_ID },
    },
  });
  await sendCommand(page, {
    module: "CueCommand",
    command: { type: "DeleteSequence", data: SEQUENCE_ID },
  });
  await sendCommand(page, {
    module: "FixtureCommand",
    command: { type: "DeleteFixture", data: fixture.fixtureId },
  });
  await expect
    .poll(() =>
      page.evaluate(({ fixtureUid }) => {
        const stores = (window as any).appStores;
        return {
          cues: Object.keys(stores.cues.get()).length,
          clips: Object.keys(stores.clips.get()).length,
          fixture: Boolean(stores.fixtures.get()[fixtureUid]),
          sequences: Object.keys(stores.sequences.get()).length,
        };
      }, fixture),
    )
    .toEqual({ cues: 0, clips: 0, fixture: false, sequences: 0 });
}

/** Verifies an owned sequence retains output throughout its global release fade. */
test("owned sequence release lingers through global fade", async ({
  backendSlot,
  page,
}) => {
  test.setTimeout(120_000);
  await openOwnedReleaseApp(page, backendSlot.backendPort);
  const fixture = await storeOwnedRgbFixture(page);
  await storeOwnedPlayback(page, fixture);

  try {
    await submitCommand(page, `exec ${CLIP_ID} start`);
    await expect
      .poll(async () => (await outputSnapshot(page, fixture)).peak, {
        timeout: 5_000,
      })
      .toBeGreaterThan(0);

    await submitCommand(page, `exec ${CLIP_ID} stop`);

    await page.waitForTimeout(500);
    expect((await outputSnapshot(page, fixture)).peak).toBeGreaterThan(0);

    await page.waitForTimeout(RELEASE_DURATION_MS);
    await expect
      .poll(async () => (await outputSnapshot(page, fixture)).peak)
      .toBe(0);
  } finally {
    await cleanupOwnedPlayback(page, fixture);
  }
});
