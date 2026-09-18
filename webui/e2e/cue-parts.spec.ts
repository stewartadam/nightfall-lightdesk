// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

const COMMAND_INPUT_PLACEHOLDER = "Type a command or search...";
const CLIP_VIEW_MODE_KEY = "nightfall-crud-panel-view-mode:clips-list";
const OWNED_FIXTURE_ID = 601;
const OWNED_SEQUENCE_LABEL = "Owned Cue Parts Sequence";
const OWNED_CLIP_ID = 29;

type OwnedCuePartsContext = {
  cueId: number;
  cueIds: number[];
  cueUid: string;
  clipId: number;
  fixtureId: number;
  fixtureUid: string;
  panelId: string;
  partLabel: string;
  sequenceId: number;
  sequenceUid: string;
};

test.setTimeout(120_000);

/** Opens the cue-parts workflow against a blank backend with one owned RGB fixture. */
async function openOwnedCuePartsApp(
  page: Page,
  backendPort: number,
): Promise<void> {
  await prepareFreshBackendShowfile(backendPort);
  await page.addInitScript(
    ([storageKey, storageValue]) => {
      window.localStorage.clear();
      window.localStorage.setItem("nightfall.currentShowfileName", "default");
      window.localStorage.setItem(storageKey, storageValue);
    },
    [CLIP_VIEW_MODE_KEY, "grid"],
  );
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await expect(page.locator("main#app")).toBeVisible();
  await waitForDockviewApp(page);
  await page.waitForFunction(
    () =>
      Boolean((window as any).appStores?.dockApi?.get?.()) &&
      typeof (window as any).appStores?.sendAndAwait === "function" &&
      Boolean((window as any).appStores?.fixtures?.get) &&
      Boolean((window as any).appStores?.cues?.get) &&
      Boolean((window as any).appStores?.sequences?.get) &&
      Boolean((window as any).appStores?.clips?.get),
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

  const createResult = await page.evaluate(async (fixtureId) => {
    return (window as any).appStores.sendAndAwait({
      module: "FixtureLibraryCommand",
      command: {
        type: "CreateFixtureFromLibrary",
        data: {
          id: fixtureId,
          make: "Generic",
          model: "Moving Head RGBW",
          mode: "Spot",
          label: "Owned Cue Parts RGB Fixture",
          update_existing_ids: [],
          update_existing_only: false,
        },
      },
    });
  }, OWNED_FIXTURE_ID);
  expect(createResult.outcome.type, JSON.stringify(createResult)).toBe(
    "Succeeded",
  );
  await expect
    .poll(() =>
      page.evaluate((fixtureId) => {
        const fixtures = Object.values(
          (window as any).appStores.fixtures.get(),
        ) as any[];
        return fixtures.find((fixture) => fixture.identifiers.id === fixtureId)
          ?.identifiers.uid;
      }, OWNED_FIXTURE_ID),
    )
    .toBeTruthy();
}

/**
 * Opens a panel used by cue part workflow tests.
 */
async function openPanel(page: Page, panelName: string) {
  await page.keyboard.press("Meta+Shift+P");

  const commandInput = page.getByPlaceholder(COMMAND_INPUT_PLACEHOLDER);
  await expect(commandInput).toBeVisible();
  await commandInput.fill(`Open ${panelName}`);
  await page.keyboard.press("Enter");
}

/** Deletes every backend record and local instance row owned by this scenario. */
async function cleanupOwnedCuePartsData(
  page: Page,
  context: OwnedCuePartsContext,
): Promise<void> {
  await page.evaluate(async (owned) => {
    const stores = (window as any).appStores;

    /** Sends one cleanup command and rejects failed backend outcomes. */
    const remove = async (message: object): Promise<void> => {
      const result = await stores.sendAndAwait(message);
      if (result.outcome.type !== "Succeeded") {
        throw new Error(
          `failed to delete owned cue parts data: ${JSON.stringify(result)}`,
        );
      }
    };

    stores.activeInstances.set({});
    await remove({
      module: "ClipCommand",
      command: { type: "DeleteClip", data: owned.clipId },
    });
    for (const cueId of owned.cueIds) {
      await remove({
        module: "CueCommand",
        command: {
          type: "DeleteCue",
          data: { sequence_id: owned.sequenceId, cue_id: cueId },
        },
      });
    }
    await remove({
      module: "CueCommand",
      command: { type: "DeleteSequence", data: owned.sequenceId },
    });
    await remove({
      module: "FixtureCommand",
      command: { type: "DeleteFixture", data: owned.fixtureId },
    });
  }, context);

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

test("owned cue parts render as expandable rows, edit, and report status", async ({
  backendSlot,
  page,
}) => {
  await openOwnedCuePartsApp(page, backendSlot.backendPort);

  const setupContext = (await page.evaluate(async (ownedSequenceLabel) => {
    const ownedClipId = 29;
    const cue1Uid = "a1000001-0004-0001-0001-000000000001";
    const cue2Uid = "a1000001-0004-0001-0001-000000000002";
    const sequenceUid = "a1000001-0004-0001-0001-000000000010";
    const clipUid = "a1000001-0004-0001-0001-000000000100";
    const setupCueUid = "a1000001-0004-0001-0001-000000000101";
    const releaseCueUid = "a1000001-0004-0001-0001-000000000102";

    type Duration = { secs: number; nanos: number };
    type TransitionMode = { type: "Fixed"; data: Duration };
    type PartialTransition = {
      delay_in?: TransitionMode;
      fade_in?: TransitionMode;
      curve_in?: "Linear" | "EaseIn" | "EaseOut" | "EaseInOut";
      delay_out?: TransitionMode;
      fade_out?: TransitionMode;
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
      trigger: { type: "Manual" } | { type: "FollowPrevious" };
      transitions: PartialTransition;
      transitions_by_attribute: Record<string, PartialTransition>;
      instructions: BoundCueInstruction[];
      parts?: CuePart[];
      references: Record<string, unknown>;
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
        curve_in: "Linear" | "EaseIn" | "EaseOut" | "EaseInOut";
        delay_out: TransitionMode;
        fade_out: TransitionMode;
        curve_out: "Linear" | "EaseIn" | "EaseOut" | "EaseInOut";
      };
      tracking_mode: { type: "Flags"; data: "HTP" };
    };
    type Fixture = {
      identifiers: { id: number; uid: string; label: string };
    };
    type ClipSummary = {
      identifiers: { id: number; uid: string; label: string };
      source?: { type: "Sequence" | "Fx" | "StepFx" | "Flow"; data: string };
    };
    type ClipEntry = [ClipSummary, boolean];

    const fixed = (secs: number, nanos = 0): TransitionMode => ({
      type: "Fixed",
      data: { secs, nanos },
    });

    /** Builds an inline absolute-percent cue value. */
    const percent = (value: number) => ({
      type: "Inline",
      data: { type: "AbsolutePercent", data: { value } },
    });

    /** Builds an empty cue used for sequence setup and release metadata. */
    const metaCue = (uid: string, label: string): Cue => ({
      identifiers: { id: 0, uid, label },
      trigger: { type: "Manual" },
      transitions: {},
      transitions_by_attribute: {},
      instructions: [],
      parts: [],
      references: {},
      tracking_flags: "HTP",
    });

    /** Finds the exact cue, sequence, and clip records owned by this test. */
    const findOwned = (stores: any) => {
      const cues = stores?.cues?.get?.() ?? {};
      const sequences = stores?.sequences?.get?.() ?? {};
      const clips = stores?.clips?.get?.() ?? {};
      const sequence = Object.values(sequences).find(
        (candidate) =>
          (candidate as Sequence).identifiers.label === ownedSequenceLabel,
      ) as Sequence | undefined;
      const cue = sequence?.steps
        .map((cueUid) => cues[cueUid] as Cue | undefined)
        .find((candidate) => (candidate?.parts?.length ?? 0) > 0);
      const part = cue?.parts?.find(
        (candidate) => candidate.identifiers.id === 1,
      );
      const clip = (Object.values(clips) as ClipEntry[]).find(
        ([candidate]) =>
          candidate.identifiers.label === ownedSequenceLabel &&
          candidate.source?.type === "Sequence" &&
          candidate.source.data === sequence?.identifiers.uid,
      )?.[0];

      return sequence && cue && part && clip
        ? { sequence, cue, part, clip }
        : undefined;
    };

    /** Waits for stores and optionally for every record owned by this test. */
    const waitForStores = (requireOwnedData: boolean) =>
      new Promise<{
        api: any;
        stores: any;
        owned?: {
          sequence: Sequence;
          cue: Cue;
          part: CuePart;
          clip: ClipSummary;
        };
      }>((resolve, reject) => {
        const started = Date.now();

        /** Polls browser state until the awaited test condition is satisfied. */
        const tick = () => {
          const stores = (window as any).appStores;
          const api = stores?.dockApi?.get?.();
          const canSendCommands =
            typeof stores?.send === "function" &&
            typeof stores?.sendAndAwait === "function";
          const hasFixtures = Object.keys(
            stores?.fixtures?.get?.() ?? {},
          ).length;
          const owned = findOwned(stores);

          if (
            api &&
            canSendCommands &&
            hasFixtures &&
            (!requireOwnedData || owned)
          ) {
            resolve({ api, stores, owned });
            return;
          }
          if (Date.now() - started > 15_000) {
            reject(new Error("owned cue parts data did not load"));
            return;
          }
          window.setTimeout(tick, 100);
        };
        tick();
      });

    const initial = await waitForStores(false);

    /** Sends one store command and rejects failed backend outcomes. */
    const store = async (message: object): Promise<void> => {
      const result = await initial.stores.sendAndAwait(message);
      if (result.outcome.type !== "Succeeded") {
        throw new Error(
          `failed to store owned cue parts data: ${JSON.stringify(result)}`,
        );
      }
    };

    /** Waits until the backend-reflected clip active state matches the expected value. */
    const waitForClipActive = (clipId: number, expected: boolean) =>
      new Promise<void>((resolve, reject) => {
        const started = Date.now();

        /** Polls clip state until backend playback updates have propagated. */
        const tick = () => {
          const entries = Object.values(
            initial.stores.clips.get(),
          ) as ClipEntry[];
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
                `clip ${clipId} did not become ${expected ? "active" : "inactive"}`,
              ),
            );
            return;
          }
          window.setTimeout(tick, 100);
        };
        tick();
      });

    {
      const fixtures = Object.values(
        initial.stores.fixtures.get(),
      ) as Fixture[];
      const fixture = fixtures.find(
        (candidate) => candidate.identifiers.id === 601,
      );
      if (!fixture) {
        throw new Error("owned cue parts fixture 601 did not load");
      }

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
      const cue1: Cue = {
        identifiers: { uid: cue1Uid, id: 1, label: "RGB Parts" },
        trigger: { type: "Manual" },
        transitions: {},
        transitions_by_attribute: {},
        instructions: [instruction("Red", 1.0)],
        parts: [
          {
            identifiers: {
              uid: "a1000001-0004-0001-0001-000000000011",
              id: 1,
              label: "Green Layer",
            },
            transitions: {},
            transitions_by_attribute: {},
            instructions: [instruction("Green", 1.0)],
            tracking_flags: "HTP",
          },
          {
            identifiers: {
              uid: "a1000001-0004-0001-0001-000000000012",
              id: 2,
              label: "Blue Accent",
            },
            transitions: {
              delay_in: fixed(0, 250_000_000),
              fade_in: fixed(0, 750_000_000),
              delay_out: fixed(0),
              fade_out: fixed(0, 500_000_000),
              curve_in: "EaseOut",
              curve_out: "Linear",
            },
            transitions_by_attribute: {},
            instructions: [instruction("Blue", 1.0)],
            tracking_flags: "HTP",
          },
        ],
        references: {},
        tracking_flags: "HTP",
      };
      const cue2: Cue = {
        identifiers: { uid: cue2Uid, id: 2, label: "RGB Parts Blackout" },
        trigger: { type: "Manual" },
        transitions: {},
        transitions_by_attribute: {},
        instructions: [
          {
            ...instruction("Red", 0.0),
            cue_instruction: {
              values: {
                Red: percent(0.0),
                Green: percent(0.0),
                Blue: percent(0.0),
              },
              transitions_by_attribute: {},
              transitions: {},
            },
          },
        ],
        references: {},
        tracking_flags: "HTP",
      };
      const sequence: Sequence = {
        identifiers: {
          uid: sequenceUid,
          id: ownedClipId,
          label: ownedSequenceLabel,
        },
        steps: [cue1Uid, cue2Uid],
        wrap: false,
        release_on_start: false,
        setup_cue: metaCue(setupCueUid, "Owned Cue Parts Setup"),
        release_cue: metaCue(releaseCueUid, "Owned Cue Parts Release"),
        default_timing: {
          delay_in: fixed(0),
          fade_in: fixed(1, 500_000_000),
          curve_in: "EaseInOut",
          delay_out: fixed(0),
          fade_out: fixed(0, 500_000_000),
          curve_out: "Linear",
        },
        tracking_mode: { type: "Flags", data: "HTP" },
      };
      const clip = {
        identifiers: {
          uid: clipUid,
          id: ownedClipId,
          label: ownedSequenceLabel,
        },
        source: { type: "Sequence", data: sequenceUid },
        priority: 0,
        options: { auto_release: false, deactivate_on_sequence_end: false },
      };

      await store({
        module: "CueCommand",
        command: { type: "StoreCue", data: cue1 },
      });
      await store({
        module: "CueCommand",
        command: { type: "StoreCue", data: cue2 },
      });
      await store({
        module: "CueCommand",
        command: { type: "StoreSequence", data: sequence },
      });
      await store({
        module: "ClipCommand",
        command: { type: "StoreClip", data: clip },
      });
    }

    const {
      api,
      owned: { sequence, cue, clip },
    } = (await waitForStores(true)) as {
      api: any;
      owned: {
        sequence: Sequence;
        cue: Cue;
        clip: ClipSummary;
      };
    };
    await initial.stores.send({
      module: "ClipCommand",
      command: {
        type: "StartClip",
        data: { type: "Single", data: ownedClipId },
      },
    });
    await waitForClipActive(ownedClipId, true);
    await initial.stores.send({
      module: "ClipCommand",
      command: {
        type: "StopClip",
        data: { type: "Single", data: ownedClipId },
      },
    });
    await waitForClipActive(ownedClipId, false);

    const panelId = "panel-SequenceEditor-cue-parts-owned";
    api.getPanel(panelId)?.api.close();
    api.addPanel({
      id: panelId,
      component: "SequenceEditor",
      title: ownedSequenceLabel,
      position: {
        referencePanel: "panel-FixtureGrid",
        direction: "within",
      },
      params: {
        initialPanelId: panelId,
        initialSequenceUid: sequence.identifiers.uid,
      },
    });
    if (!api.getPanel("panel-PropertiesInspector")) {
      api.addPanel({
        id: "panel-PropertiesInspector",
        component: "PropertiesInspector",
        title: "Properties",
        params: {},
      });
    }
    const panel = api.getPanel(panelId);
    panel?.api.setActive();
    panel?.focus();
    const ownedFixture = (
      Object.values(initial.stores.fixtures.get()) as Fixture[]
    ).find((fixture) => fixture.identifiers.id === 601);
    if (!ownedFixture) {
      throw new Error("owned cue parts fixture disappeared before assertions");
    }

    return {
      cueUid: cue.identifiers.uid,
      cueIds: [1, 2],
      fixtureId: ownedFixture.identifiers.id,
      fixtureUid: ownedFixture.identifiers.uid,
      sequenceUid: sequence.identifiers.uid,
      sequenceId: sequence.identifiers.id,
      cueId: cue.identifiers.id,
      partLabel: "Green Layer",
      clipId: clip.identifiers.id,
      panelId,
    };
  }, OWNED_SEQUENCE_LABEL)) as OwnedCuePartsContext;

  expect(setupContext.clipId).toBe(OWNED_CLIP_ID);
  await expect
    .poll(() =>
      page.evaluate((owned) => {
        const stores = (window as any).appStores;
        const clips = Object.values(stores.clips.get()) as Array<
          [{ identifiers: { id: number } }, boolean]
        >;
        return {
          cueCount: Object.keys(stores.cues.get()).length,
          clipCount: clips.length,
          clipId: clips.find(
            ([clip]) => clip.identifiers.id === owned.clipId,
          )?.[0].identifiers.id,
          fixtureCount: Object.keys(stores.fixtures.get()).length,
          fixtureUid: stores.fixtures.get()[owned.fixtureUid]?.identifiers.uid,
          sequenceCount: Object.keys(stores.sequences.get()).length,
          sequenceUid:
            stores.sequences.get()[owned.sequenceUid]?.identifiers.uid,
        };
      }, setupContext),
    )
    .toEqual({
      cueCount: 2,
      clipCount: 1,
      clipId: setupContext.clipId,
      fixtureCount: 1,
      fixtureUid: setupContext.fixtureUid,
      sequenceCount: 1,
      sequenceUid: setupContext.sequenceUid,
    });

  const sequencePanel = page.locator(
    `[data-panel-id="${setupContext.panelId}"]:visible`,
  );
  const sequenceGrid = sequencePanel.locator(
    '[data-grid-owner="sequence-editor"]',
  );
  const grid = sequenceGrid.locator('[data-grid-kind="tanstack"]');
  await expect(grid).toBeVisible();

  const cueIdCell = grid
    .locator('[data-grid-column-key="cue_id"]')
    .filter({ hasText: "▶ 1" })
    .first();
  await expect(cueIdCell).toContainText("▶ 1");
  await cueIdCell.click();

  const basePartIdCell = grid
    .locator('[data-grid-column-key="cue_id"]')
    .filter({ hasText: "p0" })
    .first();
  await expect(basePartIdCell).toContainText("p0");
  await expect(
    grid
      .locator('[data-grid-column-key="label"]')
      .filter({
        hasText: "RGB Parts",
      })
      .first(),
  ).toBeVisible();

  const partIdCell = grid
    .locator('[data-grid-column-key="cue_id"]')
    .filter({ hasText: "p1" })
    .first();
  await expect(partIdCell).toContainText("p1");
  await expect(
    grid
      .locator('[data-grid-column-key="label"]')
      .filter({
        hasText: setupContext.partLabel,
      })
      .first(),
  ).toBeVisible();
  await partIdCell.click();
  await sequencePanel
    .getByRole("button", { name: "Open cue part editor" })
    .click();
  const cuePartPropertiesTitle = page.getByText(
    `Cue ${setupContext.sequenceId}.${setupContext.cueId}p1 Properties`,
  );
  await expect(cuePartPropertiesTitle).toBeAttached();
  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    api.getPanel("panel-PropertiesInspector")?.api.setActive();
    api.setEdgeGroupVisible("right", true);
    api.getEdgeGroup("right")?.expand();
  });
  await expect(cuePartPropertiesTitle).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: `Cue ${setupContext.sequenceId}.${setupContext.cueId}p1`,
    }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        (partLabel) =>
          [...document.querySelectorAll("input")].some(
            (input) => input.value === partLabel,
          ),
        setupContext.partLabel,
      ),
    )
    .toBe(true);
  await expect
    .poll(() => page.getByText("1 instruction").count())
    .toBeGreaterThan(0);

  await page.evaluate((panelId) => {
    (window as any).appStores.dockApi.get().getPanel(panelId)?.api.setActive();
  }, setupContext.panelId);
  await partIdCell.click();
  const deletePartButton = sequencePanel.getByRole("button", {
    name: "Delete Cue Part",
  });
  await expect(deletePartButton).toBeVisible();
  await deletePartButton.click();
  await expect
    .poll(() =>
      page.evaluate(
        ({ cueUid, sequenceUid }) => {
          const cue = (window as any).appStores.cues.get()[cueUid];
          const sequence = (window as any).appStores.sequences.get()[
            sequenceUid
          ];
          return {
            cueExists: !!cue,
            sequenceSteps: sequence?.steps?.length ?? 0,
            partIds: cue?.parts?.map((part: any) => part.identifiers.id) ?? [],
          };
        },
        {
          cueUid: setupContext.cueUid,
          sequenceUid: setupContext.sequenceUid,
        },
      ),
    )
    .toEqual({
      cueExists: true,
      sequenceSteps: 2,
      partIds: [2],
    });

  await openPanel(page, "Status Display");
  await expect
    .poll(
      () =>
        page.evaluate(
          ({ clipId, sequenceLabel }) => {
            const instanceId = "a1000001000441118001000000000100";
            (window as any).appStores.activeInstances.set({
              [instanceId]: {
                instance_id: instanceId,
                kind: "Sequence",
                display_kind: "Sequence",
                name: sequenceLabel,
                tags: [],
                is_preview: false,
                is_releasing: false,
                is_paused: false,
                owner_uids: [new Uint8Array(16).fill(0xaa)],
                priority: 42,
                activation_epoch_ms: 2000,
                transition_elapsed: { secs: 0, nanos: 500_000_000 },
                bound_clip_id: clipId,
                intensity_scale: 1,
                rate: 1,
                rate_master_scale: 1,
                effective_rate: 1,
                status: {
                  position: {
                    type: "Sequence",
                    data: {
                      current_position: 1,
                      cue_count: 2,
                      current_label: "RGB Parts",
                      current_part_count: 1,
                      next_position: 2,
                      next_label: "RGB Parts Blackout",
                      retained_cues: [],
                    },
                  },
                },
              },
            });
            const text = document.body.textContent ?? "";
            return (
              text.includes(sequenceLabel) &&
              text.includes("1/2 RGB Parts (1 part)") &&
              text.includes("Next 2 RGB Parts Blackout")
            );
          },
          {
            clipId: setupContext.clipId,
            sequenceLabel: OWNED_SEQUENCE_LABEL,
          },
        ),
      { timeout: 8000 },
    )
    .toBe(true);
  await cleanupOwnedCuePartsData(page, setupContext);
});
