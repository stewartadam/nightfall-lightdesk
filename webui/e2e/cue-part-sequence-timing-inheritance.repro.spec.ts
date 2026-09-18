// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import { gridCellByIdentifier, gridCellByKey } from "./data-grid-selectors";
import { expect, type Locator, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

test.setTimeout(120_000);

const FIXTURE_ID = 601;

/** Reads the backend-store counts that must remain empty outside this scenario. */
async function ownedTimingStoreCounts(page: Page): Promise<object> {
  return page.evaluate(() => {
    const stores = (window as any).appStores;
    return {
      activeInstances: Object.keys(stores.activeInstances.get()).length,
      cues: Object.keys(stores.cues.get()).length,
      clips: Object.keys(stores.clips.get()).length,
      fixtures: Object.keys(stores.fixtures.get()).length,
      sequences: Object.keys(stores.sequences.get()).length,
    };
  });
}

/** Opens a blank backend and creates the exact RGB fixture used by the repro. */
async function openOwnedTimingApp(
  page: Page,
  backendPort: number,
): Promise<void> {
  await prepareFreshBackendShowfile(backendPort);
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("nightfall.currentShowfileName", "default");
  });
  await page.setViewportSize({ width: 1400, height: 900 });
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
      Boolean((window as any).appStores?.sequences?.get),
  );
  await expect
    .poll(() => ownedTimingStoreCounts(page))
    .toEqual({
      activeInstances: 0,
      cues: 0,
      clips: 0,
      fixtures: 0,
      sequences: 0,
    });

  const result = await page.evaluate(async (fixtureId) => {
    return (window as any).appStores.sendAndAwait({
      module: "FixtureLibraryCommand",
      command: {
        type: "CreateFixtureFromLibrary",
        data: {
          id: fixtureId,
          make: "Generic",
          model: "Moving Head RGBW",
          mode: "Spot",
          label: "Owned Cue Part Timing Fixture",
          update_existing_ids: [],
          update_existing_only: false,
        },
      },
    });
  }, FIXTURE_ID);
  expect(result.outcome.type, JSON.stringify(result)).toBe("Succeeded");
  await expect
    .poll(() =>
      page.evaluate((fixtureId) => {
        const fixtures = Object.values(
          (window as any).appStores.fixtures.get(),
        ) as any[];
        const fixture = fixtures.find(
          (candidate) => candidate.identifiers.id === fixtureId,
        );
        return {
          attributes: (fixture?.elements ?? []).flatMap((element: any) =>
            (element.parameters ?? []).map(
              (parameter: any) => parameter.attribute?.type,
            ),
          ),
          fixtureCount: fixtures.length,
        };
      }, FIXTURE_ID),
    )
    .toMatchObject({
      attributes: expect.arrayContaining(["Red", "Green", "Blue"]),
      fixtureCount: 1,
    });
}

/** Resets the backend after the repro and proves every owned store is blank. */
async function resetOwnedTimingApp(
  page: Page,
  backendPort: number,
): Promise<void> {
  await prepareFreshBackendShowfile(backendPort);
  await page.reload();
  await waitForDockviewApp(page);
  await expect
    .poll(() => ownedTimingStoreCounts(page))
    .toEqual({
      activeInstances: 0,
      cues: 0,
      clips: 0,
      fixtures: 0,
      sequences: 0,
    });
}

/** Guarantees this backend is blank after both passing and failed scenarios. */
test.afterEach(async ({ backendSlot, page }) => {
  if (page.isClosed() || page.url() === "about:blank") {
    await prepareFreshBackendShowfile(backendSlot.backendPort);
    return;
  }
  await resetOwnedTimingApp(page, backendSlot.backendPort);
});

/**
 * Reads the maximum live Green output across the selected fixture's elements.
 */
async function greenOutputForFixture(
  page: Page,
  fixtureUid: string,
): Promise<number | undefined> {
  return page.evaluate((uid) => {
    const outputMap = (window as any).appStores.getParametersImmediate();
    const normalizedFixtureUid = String(uid).replace(/-/g, "").toLowerCase();
    const elementOutputs =
      outputMap.get(uid) ?? outputMap.get(normalizedFixtureUid);
    const values = (elementOutputs ?? [])
      .map((output: Record<string, number>) => output.Green)
      .filter((green: unknown): green is number => typeof green === "number");
    return values.length > 0 ? Math.max(...values) : undefined;
  }, fixtureUid);
}

/** Scrolls the virtualized sequence grid until the requested column is rendered. */
async function scrollSequenceGridToColumn(
  grid: Locator,
  columnKey: string,
): Promise<void> {
  const renderedCells = grid.locator(
    `[data-grid-column-key=${JSON.stringify(columnKey)}]`,
  );
  for (const ratio of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
    await grid.evaluate((element, nextRatio) => {
      element.scrollLeft = Math.round(
        (element.scrollWidth - element.clientWidth) * nextRatio,
      );
      element.dispatchEvent(new Event("scroll", { bubbles: true }));
    }, ratio);
    if ((await renderedCells.count()) > 0) return;
  }
}

/**
 * Confirms cue parts inherit sequence default timings in the table and playback output.
 */
test("cue parts inherit sequence default timings in table and sequence playback", async ({
  backendSlot,
  page,
}) => {
  await openOwnedTimingApp(page, backendSlot.backendPort);

  const setupContext = await page.evaluate(async () => {
    const clipId = 129;
    const fixtureId = 601;
    const cueUid = "b1000001000400010001000000000001";
    const sequenceUid = "b1000001000400010001000000000010";
    const clipUid = "b1000001000400010001000000000100";

    type Duration = { secs: number; nanos: number };
    type TransitionMode = { type: "Fixed"; data: Duration };
    type PartialTransition = {
      delay_in?: TransitionMode;
      fade_in?: TransitionMode;
      delay_out?: TransitionMode;
      fade_out?: TransitionMode;
      curve_in?: "Linear" | "EaseIn" | "EaseOut" | "EaseInOut";
      curve_out?: "Linear" | "EaseIn" | "EaseOut" | "EaseInOut";
    };
    type BoundCueInstruction = {
      selection: {
        source: {
          type: "Resolved";
          data: Array<{ fixture_uid: string; index: number | null }>;
        };
        clauses: [];
      };
      cue_instruction: {
        values: Record<string, unknown>;
        transitions_by_attribute: Record<string, PartialTransition>;
        transitions: PartialTransition;
      };
    };
    type CuePart = {
      identifiers: { id: number; uid: string; label: string };
      transitions: PartialTransition;
      transitions_by_attribute: Record<string, PartialTransition>;
      instructions: BoundCueInstruction[];
      tracking_flags: "HTP";
    };
    type Cue = {
      identifiers: { id: number; uid: string; label: string };
      trigger: { type: "Manual" };
      transitions: PartialTransition;
      transitions_by_attribute: Record<string, PartialTransition>;
      instructions: BoundCueInstruction[];
      parts: CuePart[];
      tracking_flags: "HTP";
    };
    type Sequence = {
      identifiers: { id: number; uid: string; label: string };
      steps: string[];
      wrap: boolean;
      release_on_start: boolean;
      setup_cue: Cue;
      release_cue: Cue;
      default_timing: {
        delay_in: TransitionMode;
        fade_in: TransitionMode;
        delay_out: TransitionMode;
        fade_out: TransitionMode;
        curve_in: "Linear" | "EaseIn" | "EaseOut" | "EaseInOut";
        curve_out: "Linear" | "EaseIn" | "EaseOut" | "EaseInOut";
      };
      tracking_mode: { type: "Inherit" };
    };
    type Fixture = {
      identifiers: { id: number; uid: string; label: string };
    };
    type ClipEntry = [
      {
        identifiers: { id: number; uid: string; label: string };
        source?: { type: string; data: string };
      },
      boolean,
    ];

    /** Builds a fixed transition duration for seeded cue and sequence timing. */
    const fixed = (secs: number): TransitionMode => ({
      type: "Fixed",
      data: { secs, nanos: 0 },
    });

    /** Builds an inline absolute-percent cue value. */
    const percent = (value: number) => ({
      type: "Inline",
      data: { type: "AbsolutePercent", data: { value } },
    });

    /** Waits until app stores and the Sequence Editor API are ready. */
    const waitForStores = () =>
      new Promise<any>((resolve, reject) => {
        const started = Date.now();

        /** Polls for app store readiness. */
        const tick = () => {
          const stores = (window as any).appStores;
          const api = stores?.dockApi?.get?.();
          const canSendCommands = typeof stores?.sendAndAwait === "function";
          if (api && canSendCommands) {
            resolve({ api, stores });
            return;
          }
          if (Date.now() - started > 45_000) {
            reject(new Error("app stores did not become ready"));
            return;
          }
          window.setTimeout(tick, 100);
        };
        tick();
      });

    /** Waits until the backend-reflected clip active state matches the expected value. */
    const waitForClipActive = (
      stores: any,
      clipId: number,
      expected: boolean,
    ) =>
      new Promise<void>((resolve, reject) => {
        const started = Date.now();

        /** Polls clip state until backend playback updates have propagated. */
        const tick = () => {
          const entries = Object.values(stores.clips.get()) as ClipEntry[];
          const active = entries.find(
            ([clip]) => clip.identifiers.id === clipId,
          )?.[1];
          if (active === expected) {
            resolve();
            return;
          }
          if (Date.now() - started > 10_000) {
            reject(
              new Error(
                `clip ${clipId} did not become ${
                  expected ? "active" : "inactive"
                }`,
              ),
            );
            return;
          }
          window.setTimeout(tick, 100);
        };
        tick();
      });

    const { api, stores } = await waitForStores();
    const fixture = (Object.values(stores.fixtures.get()) as Fixture[]).find(
      (candidate) => candidate.identifiers.id === fixtureId,
    );
    if (!fixture) throw new Error(`fixture ${fixtureId} did not load`);

    /** Builds a cue instruction against the suite-owned RGB fixture. */
    const instruction = (
      attribute: "Red" | "Green" | "Blue",
      value: number,
    ): BoundCueInstruction => ({
      selection: {
        source: {
          type: "Resolved",
          data: [{ fixture_uid: fixture.identifiers.uid, index: null }],
        },
        clauses: [],
      },
      cue_instruction: {
        values: { [attribute]: percent(value) },
        transitions_by_attribute: {},
        transitions: {},
      },
    });

    const inheritedPart: CuePart = {
      identifiers: {
        id: 1,
        uid: "b1000001000400010001000000000011",
        label: "Inherited Green",
      },
      transitions: {},
      transitions_by_attribute: {},
      instructions: [instruction("Green", 1.0)],
      tracking_flags: "HTP",
    };
    const overriddenPart: CuePart = {
      identifiers: {
        id: 2,
        uid: "b1000001000400010001000000000012",
        label: "Explicit Blue",
      },
      transitions: { fade_in: fixed(3) },
      transitions_by_attribute: {},
      instructions: [instruction("Blue", 1.0)],
      tracking_flags: "HTP",
    };
    const cue: Cue = {
      identifiers: { uid: cueUid, id: 1, label: "Inherited Parts" },
      trigger: { type: "Manual" },
      transitions: {},
      transitions_by_attribute: {},
      instructions: [instruction("Red", 1.0)],
      parts: [inheritedPart, overriddenPart],
      tracking_flags: "HTP",
    };
    const sequence: Sequence = {
      identifiers: {
        uid: sequenceUid,
        id: clipId,
        label: "Part Timing Inheritance",
      },
      steps: [cueUid],
      wrap: false,
      release_on_start: false,
      setup_cue: {
        identifiers: {
          uid: "b100000100040001000100000000001f",
          id: 0,
          label: "Setup",
        },
        trigger: { type: "Manual" },
        transitions: {},
        transitions_by_attribute: {},
        instructions: [],
        parts: [],
        tracking_flags: "HTP",
      },
      release_cue: {
        identifiers: {
          uid: "b1000001000400010001000000000020",
          id: 0,
          label: "Release",
        },
        trigger: { type: "Manual" },
        transitions: {},
        transitions_by_attribute: {},
        instructions: [],
        parts: [],
        tracking_flags: "HTP",
      },
      default_timing: {
        delay_in: fixed(1),
        fade_in: fixed(2),
        delay_out: fixed(3),
        fade_out: fixed(4),
        curve_in: "Linear",
        curve_out: "Linear",
      },
      tracking_mode: { type: "Inherit" },
    };
    const clip = {
      identifiers: {
        uid: clipUid,
        id: clipId,
        label: "Part Timing Inheritance",
      },
      source: { type: "Sequence", data: sequenceUid },
      priority: 0,
      options: { auto_release: false, deactivate_on_sequence_end: false },
    };

    const outcomes = [
      await stores.sendAndAwait({
        module: "CueCommand",
        command: { type: "StoreCue", data: cue },
      }),
      await stores.sendAndAwait({
        module: "CueCommand",
        command: { type: "StoreSequence", data: sequence },
      }),
      await stores.sendAndAwait({
        module: "ClipCommand",
        command: { type: "StoreClip", data: clip },
      }),
    ];
    for (const outcome of outcomes) {
      if (outcome.outcome.type !== "Succeeded") {
        throw new Error(
          `owned definition store failed: ${JSON.stringify(outcome)}`,
        );
      }
    }

    await waitForClipActive(stores, clipId, false);
    const definitionDeadline = Date.now() + 10_000;
    while (
      Date.now() < definitionDeadline &&
      (!stores.cues.get()[cueUid] || !stores.sequences.get()[sequenceUid])
    ) {
      await new Promise((resolve) => window.setTimeout(resolve, 50));
    }
    if (!stores.cues.get()[cueUid] || !stores.sequences.get()[sequenceUid]) {
      throw new Error("owned cue and sequence did not reach browser stores");
    }

    const panelId = "panel-SequenceEditor-cue-part-timing-inheritance";
    api.getPanel(panelId)?.api.close();
    api.addPanel({
      id: panelId,
      component: "SequenceEditor",
      title: "Part Timing Inheritance",
      position: {
        referencePanel: "panel-FixtureGrid",
        direction: "within",
      },
      params: {
        initialPanelId: panelId,
        initialSequenceUid: sequenceUid,
      },
    });
    const panel = api.getPanel(panelId);
    panel?.api.setActive();
    panel?.focus();

    return {
      clipId,
      fixtureUid: fixture.identifiers.uid,
      panelId,
    };
  });

  const sequenceGrid = page
    .locator(`[data-panel-id="${setupContext.panelId}"]:visible`)
    .locator('[data-grid-owner="sequence-editor"]');
  const table = sequenceGrid.locator('[data-grid-kind="tanstack"]');
  await expect(table).toBeVisible();

  const cueIdCell = await gridCellByIdentifier(table, {
    columnKey: "cue_id",
    identifierColumnKey: "cue_id",
    identifierText: "1",
  });
  await expect(cueIdCell).toContainText("▶ 1");
  await cueIdCell.click();
  const inheritedPartIdCell = await gridCellByIdentifier(table, {
    columnKey: "cue_id",
    identifierColumnKey: "cue_id",
    identifierText: "p1",
  });
  const overriddenPartIdCell = await gridCellByIdentifier(table, {
    columnKey: "cue_id",
    identifierColumnKey: "cue_id",
    identifierText: "p2",
  });
  const inheritedPartRowKey =
    await inheritedPartIdCell.getAttribute("data-grid-row-key");
  const overriddenPartRowKey =
    await overriddenPartIdCell.getAttribute("data-grid-row-key");
  if (!inheritedPartRowKey || !overriddenPartRowKey) {
    throw new Error("expected stable cue-part row keys");
  }
  await expect(inheritedPartIdCell).toContainText("p1");
  await expect(
    gridCellByKey(table, {
      columnKey: "label",
      rowKey: inheritedPartRowKey,
    }),
  ).toContainText("Inherited Green");
  await expect(overriddenPartIdCell).toContainText("p2");
  for (const [columnKey, text] of [
    ["fade_in", "2s"],
    ["delay_in", "1s"],
    ["fade_out", "4s"],
    ["delay_out", "3s"],
  ] as const) {
    await scrollSequenceGridToColumn(table, columnKey);
    await expect(
      gridCellByKey(table, { columnKey, rowKey: inheritedPartRowKey }),
    ).toContainText(text);
  }
  await scrollSequenceGridToColumn(table, "fade_in");
  await expect(
    gridCellByKey(table, {
      columnKey: "fade_in",
      rowKey: overriddenPartRowKey,
    }),
  ).toContainText("3s");
  await scrollSequenceGridToColumn(table, "delay_in");
  await expect(
    gridCellByKey(table, {
      columnKey: "delay_in",
      rowKey: overriddenPartRowKey,
    }),
  ).toContainText("1s");

  try {
    await page.evaluate(async (clipId) => {
      await (window as any).appStores.send({
        module: "ClipCommand",
        command: {
          type: "StartClip",
          data: { type: "Single", data: clipId },
        },
      });
    }, setupContext.clipId);

    await expect
      .poll(
        () =>
          page.evaluate((clipId) => {
            const entries = Object.values(
              (window as any).appStores.clips.get(),
            ) as any[];
            return entries.find(
              ([clip]) => clip.identifiers.id === clipId,
            )?.[1];
          }, setupContext.clipId),
        { timeout: 10_000 },
      )
      .toBe(true);

    await page.waitForTimeout(400);

    const literalGreenDuringInheritedDelay = await greenOutputForFixture(
      page,
      setupContext.fixtureUid,
    );
    expect(literalGreenDuringInheritedDelay ?? 0).toBe(0);

    const greenFadeSamples: Array<number | undefined> = [];
    for (let sampleIndex = 0; sampleIndex < 20; sampleIndex += 1) {
      greenFadeSamples.push(
        await greenOutputForFixture(page, setupContext.fixtureUid),
      );
      await page.waitForTimeout(200);
    }
    if (
      !greenFadeSamples.some(
        (green) => green !== undefined && green > 0 && green < 220,
      )
    ) {
      throw new Error(
        `expected inherited fade to produce an intermediate Green value, saw ${JSON.stringify(
          greenFadeSamples,
        )}`,
      );
    }

    await expect
      .poll(
        async () => {
          const green = await greenOutputForFixture(
            page,
            setupContext.fixtureUid,
          );
          return green ?? 0;
        },
        { timeout: 5_000 },
      )
      .toBeGreaterThanOrEqual(250);
  } finally {
    await page.evaluate(async (clipId) => {
      await (window as any).appStores.send({
        module: "ClipCommand",
        command: {
          type: "StopClip",
          data: { type: "Single", data: clipId },
        },
      });
    }, setupContext.clipId);
  }
});
