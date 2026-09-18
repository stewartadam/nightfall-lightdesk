// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

type RgbOutput = {
  red?: number;
  green?: number;
  blue?: number;
};

type RgbFixtureContext = {
  fixtureId: number;
  fixtureUid: string;
  elementIndex: number;
  rgbElementIndices: number[];
  position: { x: number; y: number; z: number };
};

/** Builds an inline absolute-percent cue value for seeded RGB playback checks. */
function inlinePercent(value: number): object {
  return {
    type: "Inline",
    data: { type: "AbsolutePercent", data: { value } },
  };
}

/** Builds a fixed transition mode for seeded sequences. */
function fixed(secs: number, nanos = 0): object {
  return {
    type: "Fixed",
    data: { secs, nanos },
  };
}

/** Builds deterministic metadata cue UIDs from the sequence UID. */
function sequenceMetaCueUid(sequenceUid: string, suffix: string): string {
  return sequenceUid.replace(/[0-9a-f]{12}$/i, suffix);
}

/** Builds an empty setup or release meta-cue for a sequence definition. */
function metaCue(cueUid: string, label: string): object {
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

/** Builds a cue with one RGB fixture-element row. */
function rgbCue(
  cueId: number,
  cueUid: string,
  fixture: RgbFixtureContext,
  label: string,
  color: Required<RgbOutput>,
  colorPathId?: number,
): object {
  return {
    identifiers: {
      id: cueId,
      uid: cueUid,
      label,
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
            VirtualIntensity: inlinePercent(1),
            Red: inlinePercent(color.red),
            Green: inlinePercent(color.green),
            Blue: inlinePercent(color.blue),
          },
          transitions: {},
          transitions_by_attribute: {},
          transitions_by_fixture_attribute: [],
          color_path_id: colorPathId,
        },
      },
    ],
    parts: [],
    references: {},
    tracking_flags: "HTP",
  };
}

/** Builds a sequence containing the seeded red and blue cues. */
function playbackSequence(
  sequenceId: number,
  sequenceUid: string,
  cueUids: [string, string],
): object {
  return {
    identifiers: {
      id: sequenceId,
      uid: sequenceUid,
      label: `Color Path Playback ${sequenceId}`,
    },
    steps: cueUids,
    references: {},
    wrap: false,
    release_on_start: false,
    setup_cue: metaCue(
      sequenceMetaCueUid(sequenceUid, "000000000000"),
      "Setup",
    ),
    release_cue: metaCue(
      sequenceMetaCueUid(sequenceUid, "000000000003"),
      "Release",
    ),
    default_timing: {
      delay_in: fixed(0),
      fade_in: fixed(6),
      curve_in: "Linear",
      delay_out: fixed(0),
      fade_out: fixed(0),
      curve_out: "Linear",
    },
    tracking_mode: { type: "Flags", data: "HTP" },
  };
}

/** Builds a clip bound to the seeded playback sequence. */
function sequenceClip(
  clipId: number,
  clipUid: string,
  sequenceUid: string,
): object {
  return {
    identifiers: {
      id: clipId,
      uid: clipUid,
      label: `Color Path Playback ${clipId}`,
    },
    source: { type: "Sequence", data: sequenceUid },
    priority: 0,
    options: { auto_release: false, deactivate_on_sequence_end: false },
  };
}

/** Opens the color-path playback scenario against an empty backend showfile. */
async function openOwnedColorPathPlaybackApp(
  page: Page,
  backendPort: number,
): Promise<void> {
  await prepareFreshBackendShowfile(backendPort);
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("nightfall.currentShowfileName", "default");
  });
  await page.goto(
    "/?startup:draftRecovery=false&visualizer:offscreenCanvas=false&e2e=1",
  );
  await expect(page.locator("main#app")).toBeVisible();
  await waitForDockviewApp(page);
  await page.waitForFunction(
    () =>
      typeof (window as any).appStores?.sendAndAwait === "function" &&
      Boolean((window as any).appStores?.fixtures?.get) &&
      Boolean((window as any).visualizerApi?.getScene?.()),
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

/** Stores the complete RGB fixture sampled by the playback assertions. */
async function storeOwnedRgbFixture(page: Page): Promise<RgbFixtureContext> {
  const fixture = await page.evaluate(async () => {
    const stores = (window as any).appStores;
    const fixtureId = Math.floor(900_000 + Math.random() * 50_000);
    const result = await stores.sendAndAwait({
      module: "FixtureLibraryCommand",
      command: {
        type: "CreateFixtureFromLibrary",
        data: {
          id: fixtureId,
          make: "Generic",
          model: "Moving Head RGBW",
          mode: "Spot",
          label: `Owned Color Path RGB Fixture ${fixtureId}`,
          update_existing_ids: [],
          update_existing_only: false,
        },
      },
    });
    if (result.outcome.type !== "Succeeded") {
      throw new Error(
        `owned RGB fixture store failed: ${JSON.stringify(result)}`,
      );
    }

    let storedFixture: any;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      storedFixture = Object.values(stores.fixtures.get()).find(
        (candidate: any) => candidate.identifiers.id === fixtureId,
      );
      if (storedFixture) break;
      await new Promise((resolve) => window.setTimeout(resolve, 50));
    }
    if (!storedFixture) {
      throw new Error("owned RGB fixture did not hydrate");
    }
    const rgbElementIndices = storedFixture.elements.flatMap(
      (element: any, index: number) => {
        const attributes = new Set(
          element.parameters.map((parameter: any) => parameter.attribute?.type),
        );
        return attributes.has("Red") &&
          attributes.has("Green") &&
          attributes.has("Blue")
          ? [index + 1]
          : [];
      },
    );
    if (rgbElementIndices.length === 0) {
      throw new Error("owned fixture did not expose an RGB element");
    }
    return {
      fixtureId,
      fixtureUid: storedFixture.identifiers.uid,
      elementIndex: rgbElementIndices[0],
      rgbElementIndices,
      position: storedFixture.placement?.position ?? { x: 0, y: 0, z: 0 },
    };
  });
  await expect
    .poll(() =>
      page.evaluate(({ fixtureUid }) => {
        const scene = (window as any).visualizerApi?.getScene?.();
        const normalizedUid = fixtureUid.replaceAll("-", "").toLowerCase();
        return {
          fixture: Boolean(
            (window as any).appStores.fixtures.get()[fixtureUid],
          ),
          scene: Boolean(
            scene?.getObjectByName?.(`Fixture_${fixtureUid}`) ??
              scene?.getObjectByName?.(`Fixture_${normalizedUid}`),
          ),
        };
      }, fixture),
    )
    .toEqual({ fixture: true, scene: true });
  return fixture;
}

/** Frames the owned RGB fixture in the main-thread visualizer. */
async function frameOwnedRgbFixture(
  page: Page,
  fixture: RgbFixtureContext,
): Promise<void> {
  await page.evaluate((position) => {
    (window as any).visualizerApi.setCameraState({
      position: { x: position.x, y: position.y + 0.4, z: position.z + 5 },
      target: position,
    });
  }, fixture.position);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );
}

/** Sends an app command through the websocket helper. */
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
      throw new Error(`playback command failed: ${JSON.stringify(result)}`);
    }
  }, data);
}

/** Removes every record owned by the color-path scenario and releases playback. */
async function cleanupOwnedColorPathPlayback(
  page: Page,
  fixture: RgbFixtureContext,
  clipId: number,
  sequenceId: number,
  cueIds: number[],
): Promise<void> {
  await sendCommand(page, {
    module: "ClipCommand",
    command: {
      type: "StopClip",
      data: { type: "Single", data: clipId },
    },
  });
  await expect
    .poll(() =>
      page.evaluate((id) => {
        const instances = Object.values(
          (window as any).appStores.activeInstances.get(),
        ) as Array<{ bound_clip_id?: number }>;
        return instances.filter((playback) => playback.bound_clip_id === id)
          .length;
      }, clipId),
    )
    .toBe(0);
  await sendCommand(page, {
    module: "ClipCommand",
    command: { type: "DeleteClip", data: clipId },
  });
  await waitForBackendCommandDrain(page);
  for (const cueId of cueIds) {
    await sendCommand(page, {
      module: "CueCommand",
      command: {
        type: "DeleteCue",
        data: { sequence_id: sequenceId, cue_id: cueId },
      },
    });
  }
  await sendCommand(page, {
    module: "CueCommand",
    command: { type: "DeleteSequence", data: sequenceId },
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
          fixtures: Boolean(stores.fixtures.get()[fixtureUid]),
          sequences: Object.keys(stores.sequences.get()).length,
        };
      }, fixture),
    )
    .toEqual({ cues: 0, clips: 0, fixtures: false, sequences: 0 });
}

/** Waits for pending backend commands to cross at least one 5 FPS app frame. */
async function waitForBackendCommandDrain(page: Page): Promise<void> {
  await page.waitForTimeout(650);
}

/** Reads live RGB output for the seeded fixture element. */
async function rgbOutputForFixtureElement(
  page: Page,
  fixture: RgbFixtureContext,
): Promise<RgbOutput | undefined> {
  return page.evaluate(({ fixtureUid, elementIndex }) => {
    const stores = (window as any).appStores;
    const normalizedUid = String(fixtureUid).replaceAll("-", "").toLowerCase();
    const outputMap = stores.getParametersImmediate();
    const elementOutputs =
      outputMap.get(fixtureUid) ?? outputMap.get(normalizedUid);
    const output = elementOutputs?.[elementIndex - 1];
    if (!output) return undefined;
    return {
      red: typeof output.Red === "number" ? output.Red : undefined,
      green: typeof output.Green === "number" ? output.Green : undefined,
      blue: typeof output.Blue === "number" ? output.Blue : undefined,
    };
  }, fixture);
}

/** Returns whether the output sample proves an HSV red-to-blue midpoint. */
function isHsvMagentaOutput(output: RgbOutput | undefined): boolean {
  return (
    output !== undefined &&
    (output.red ?? 0) > 200 &&
    (output.blue ?? 0) > 200 &&
    (output.green ?? 255) < 40
  );
}

/** Waits for the HSV transition midpoint and reports sampled RGB output on failure. */
async function waitForHsvMagentaOutput(
  page: Page,
  fixture: RgbFixtureContext,
): Promise<void> {
  const samples: RgbOutput[] = [];
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const output = await rgbOutputForFixtureElement(page, fixture);
    if (output) {
      samples.push(output);
      if (isHsvMagentaOutput(output)) return;
    }
    await page.waitForTimeout(250);
  }
  throw new Error(
    `HSV transition never reached magenta; samples=${JSON.stringify(samples)}`,
  );
}

/** Verifies color path playback reaches the HSV route in visualizer-facing output. */
test("HSV color path playback drives visualizer output through magenta", async ({
  backendSlot,
  page,
}) => {
  test.setTimeout(120_000);
  await openOwnedColorPathPlaybackApp(page, backendSlot.backendPort);
  const fixture = await storeOwnedRgbFixture(page);
  await frameOwnedRgbFixture(page, fixture);
  const sequenceId = 996_001;
  const clipId = 996_001;
  const redCueId = 996_001;
  const blueCueId = 996_002;
  const redCueUid = "99600100-0000-0000-0000-000000000001";
  const blueCueUid = "99600100-0000-0000-0000-000000000002";
  const sequenceUid = "99600100-0000-0000-0000-000000000099";
  const clipUid = "99600100-0000-0000-0000-0000000000ee";

  try {
    await sendCommand(page, {
      module: "CueCommand",
      command: {
        type: "StoreCue",
        data: rgbCue(redCueId, redCueUid, fixture, "Color Path Playback Red", {
          red: 1,
          green: 0,
          blue: 0,
        }),
      },
    });
    await sendCommand(page, {
      module: "CueCommand",
      command: {
        type: "StoreCue",
        data: rgbCue(
          blueCueId,
          blueCueUid,
          fixture,
          "Color Path Playback Blue HSV",
          {
            red: 0,
            green: 0,
            blue: 1,
          },
          2,
        ),
      },
    });
    await sendCommand(page, {
      module: "CueCommand",
      command: {
        type: "StoreSequence",
        data: playbackSequence(sequenceId, sequenceUid, [
          redCueUid,
          blueCueUid,
        ]),
      },
    });
    await waitForBackendCommandDrain(page);
    await sendCommand(page, {
      module: "ClipCommand",
      command: {
        type: "StoreClip",
        data: sequenceClip(clipId, clipUid, sequenceUid),
      },
    });
    await waitForBackendCommandDrain(page);
    await sendCommand(page, {
      module: "ClipCommand",
      command: {
        type: "StartClip",
        data: { type: "Single", data: clipId },
      },
    });
    await expect
      .poll(() => rgbOutputForFixtureElement(page, fixture), {
        timeout: 10_000,
      })
      .toMatchObject({ red: expect.any(Number) });
    await expect
      .poll(
        async () => {
          const output = await rgbOutputForFixtureElement(page, fixture);
          return output?.red ?? 0;
        },
        { timeout: 15_000 },
      )
      .toBeGreaterThan(220);

    await sendCommand(page, {
      module: "ClipCommand",
      command: {
        type: "GoClip",
        data: { type: "Single", data: clipId },
      },
    });

    await waitForHsvMagentaOutput(page, fixture);
  } finally {
    await cleanupOwnedColorPathPlayback(page, fixture, clipId, sequenceId, [
      redCueId,
      blueCueId,
    ]);
  }
});
