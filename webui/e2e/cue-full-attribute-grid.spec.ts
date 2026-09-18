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
  gridHeaderByColumnKey,
} from "./data-grid-selectors";
import { expect, type Locator, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

type OwnedFullAttributeContext = {
  cueId: number;
  cueUid: string;
  editAttribute: string;
  fixtureId: number;
  fixtureIds: number[];
  fixtureUid: string;
  incompatibleAttribute: string;
  panelId: string;
  seedCue: any;
  sequenceId: number;
  sequenceUid: string;
};

test.setTimeout(120_000);

/** Opens the full-attribute scenario against an empty backend showfile. */
async function openOwnedFullAttributeApp(
  page: Page,
  backendPort: number,
): Promise<void> {
  await prepareFreshBackendShowfile(backendPort);
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("nightfall.currentShowfileName", "default");
  });
  await page.setViewportSize({ width: 1200, height: 700 });
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await expect(page.locator("main#app")).toBeVisible();
  await waitForDockviewApp(page);
  await page.waitForFunction(
    () =>
      Boolean((window as any).appStores?.dockApi?.get?.()) &&
      typeof (window as any).appStores?.sendAndAwait === "function" &&
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
          fixtures: Object.keys(stores.fixtures.get()).length,
          sequences: Object.keys(stores.sequences.get()).length,
        };
      }),
    )
    .toEqual({ cues: 0, fixtures: 0, sequences: 0 });
}

/**
 * Scrolls the virtualized grid horizontally until a target column is rendered.
 */
async function scrollGridToColumn(
  grid: Locator,
  column: Locator,
): Promise<void> {
  for (const ratio of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
    await grid.evaluate((element, ratio) => {
      element.scrollLeft = Math.round(
        (element.scrollWidth - element.clientWidth) * ratio,
      );
      element.dispatchEvent(new Event("scroll", { bubbles: true }));
    }, ratio);
    if ((await column.count()) > 0) return;
  }
}

/**
 * Waits for the cue store to contain the seeded cue instruction.
 */
async function waitForSeededCue(
  page: Page,
  cueUid: string,
  fixtureUid: string,
  attribute: string,
): Promise<void> {
  await page.waitForFunction(
    ({ cueUid, fixtureUid, attribute }) => {
      const cue = (window as any).appStores.cues.get()?.[cueUid];
      return cue?.instructions?.some(
        (instruction: any) =>
          instruction.selection?.source?.data?.some(
            (ref: any) => ref.fixture_uid === fixtureUid,
          ) && instruction.cue_instruction?.values?.[attribute] !== undefined,
      );
    },
    { cueUid, fixtureUid, attribute },
    { timeout: 10_000 },
  );
}

/** Stores the complete owned cue through the backend and waits for its live row. */
async function storeCueAndWait(
  page: Page,
  cue: any,
  fixtureUid: string,
  assertedAttribute: string,
): Promise<void> {
  const result = await page.evaluate(async (ownedCue) => {
    return (window as any).appStores.sendAndAwait({
      module: "CueCommand",
      command: { type: "StoreCue", data: ownedCue },
    });
  }, cue);
  expect(result.outcome.type, JSON.stringify(result)).toBe("Succeeded");
  await waitForSeededCue(
    page,
    cue.identifiers.uid,
    fixtureUid,
    assertedAttribute,
  );
}

/** Creates the exact fixtures, cue, and sequence used by the full-grid scenario. */
async function storeOwnedFullAttributeData(
  page: Page,
  panelId: string,
): Promise<OwnedFullAttributeContext> {
  const fixtureIds = await page.evaluate(async () => {
    const stores = (window as any).appStores;
    const targetFixtureId = Math.floor(600_000 + Math.random() * 100_000);
    const incompatibleFixtureId = targetFixtureId + 1;

    /** Creates one fixture-library record and rejects failed backend outcomes. */
    const createFixture = async (
      id: number,
      model: string,
      mode: string,
      label: string,
    ): Promise<void> => {
      const result = await stores.sendAndAwait({
        module: "FixtureLibraryCommand",
        command: {
          type: "CreateFixtureFromLibrary",
          data: {
            id,
            make: "Generic",
            model,
            mode,
            label,
            update_existing_ids: [],
            update_existing_only: false,
          },
        },
      });
      if (result.outcome.type !== "Succeeded") {
        throw new Error(
          `failed to create full-attribute fixture ${id}: ${JSON.stringify(result)}`,
        );
      }
    };

    await createFixture(
      targetFixtureId,
      "12-segment RGBW Bar",
      "RGBW",
      "Owned Full Attribute RGBW Pixels",
    );
    await createFixture(
      incompatibleFixtureId,
      "Moving Head RGBW",
      "Spot",
      "Owned Full Attribute Moving Head",
    );
    return [targetFixtureId, incompatibleFixtureId];
  });

  await expect
    .poll(() =>
      page.evaluate(([targetFixtureId, incompatibleFixtureId]) => {
        /** Returns every serialized attribute name supported by one fixture. */
        const attributeNames = (fixture: any): string[] =>
          (fixture?.elements ?? []).flatMap((element: any) =>
            (element.parameters ?? []).map((parameter: any) => {
              const attribute = parameter.attribute;
              return attribute?.type === "Custom"
                ? attribute.data.label
                : attribute?.type;
            }),
          );
        const fixtures = Object.values(
          (window as any).appStores.fixtures.get(),
        ) as any[];
        const target = fixtures.find(
          (fixture) => fixture.identifiers.id === targetFixtureId,
        );
        const incompatible = fixtures.find(
          (fixture) => fixture.identifiers.id === incompatibleFixtureId,
        );
        return {
          fixtureCount: fixtures.length,
          incompatibleAttributes: attributeNames(incompatible),
          targetAttributes: attributeNames(target),
        };
      }, fixtureIds),
    )
    .toMatchObject({
      fixtureCount: 2,
      incompatibleAttributes: expect.arrayContaining(["Pan"]),
      targetAttributes: expect.arrayContaining(["Red", "Green"]),
    });
  await expect
    .poll(() =>
      page.evaluate(([targetFixtureId]) => {
        const fixture = (
          Object.values((window as any).appStores.fixtures.get()) as any[]
        ).find((candidate) => candidate.identifiers.id === targetFixtureId);
        return (fixture?.elements ?? []).some((element: any) =>
          (element.parameters ?? []).some(
            (parameter: any) => parameter.attribute?.type === "Pan",
          ),
        );
      }, fixtureIds),
    )
    .toBe(false);

  const context = await page.evaluate(
    async ({ fixtureIds: ownedFixtureIds, panelId: ownedPanelId }) => {
      const stores = (window as any).appStores;
      const [targetFixtureId, incompatibleFixtureId] = ownedFixtureIds;
      const fixtures = Object.values(stores.fixtures.get()) as any[];
      const fixture = fixtures.find(
        (candidate) => candidate.identifiers.id === targetFixtureId,
      );
      const incompatibleFixture = fixtures.find(
        (candidate) => candidate.identifiers.id === incompatibleFixtureId,
      );
      if (!fixture || !incompatibleFixture) {
        throw new Error("owned full-attribute fixtures did not load");
      }

      stores.attributeMetadata.set([
        {
          key: "Red",
          attribute: { type: "Red" },
          label: "Red",
          category: "Color",
          sort_order: 1,
        },
        {
          key: "Green",
          attribute: { type: "Green" },
          label: "Green",
          category: "Color",
          sort_order: 2,
        },
      ]);

      const cueId = Math.floor(1_000 + Math.random() * 8_000);
      const sequenceId = Math.floor(900_000 + Math.random() * 50_000);
      const cueUid = crypto.randomUUID().replaceAll("-", "");
      const sequenceUid = crypto.randomUUID().replaceAll("-", "");
      const setupCueUid = crypto.randomUUID().replaceAll("-", "");
      const releaseCueUid = crypto.randomUUID().replaceAll("-", "");
      const fixedZero = {
        type: "Fixed",
        data: { secs: 0, nanos: 0 },
      };
      const seedCue = {
        identifiers: {
          id: cueId,
          uid: cueUid,
          label: "Owned Cue Full Attribute Grid",
        },
        trigger: { type: "Manual" },
        transitions: {},
        transitions_by_attribute: {},
        instructions: [
          {
            selection: {
              source: {
                type: "Resolved",
                data: [{ fixture_uid: fixture.identifiers.uid, index: null }],
              },
              clauses: [],
            },
            cue_instruction: {
              values: {
                Red: {
                  type: "Inline",
                  data: {
                    type: "AbsolutePercent",
                    data: { value: 0.25 },
                  },
                },
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

      /** Builds an empty sequence metadata cue. */
      const metaCue = (uid: string, label: string): object => ({
        identifiers: { id: 0, uid, label },
        trigger: { type: "Manual" },
        transitions: {},
        transitions_by_attribute: {},
        instructions: [],
        parts: [],
        references: {},
        tracking_flags: "HTP",
      });

      /** Stores one owned record and rejects failed backend outcomes. */
      const store = async (message: object): Promise<void> => {
        const result = await stores.sendAndAwait(message);
        if (result.outcome.type !== "Succeeded") {
          throw new Error(
            `failed to store owned full-attribute data: ${JSON.stringify(result)}`,
          );
        }
      };

      await store({
        module: "CueCommand",
        command: { type: "StoreCue", data: seedCue },
      });
      await store({
        module: "CueCommand",
        command: {
          type: "StoreSequence",
          data: {
            identifiers: {
              id: sequenceId,
              uid: sequenceUid,
              label: "Owned Full Attribute Sequence",
            },
            steps: [cueUid],
            wrap: false,
            release_on_start: false,
            setup_cue: metaCue(setupCueUid, "Owned Full Attribute Setup"),
            release_cue: metaCue(releaseCueUid, "Owned Full Attribute Release"),
            default_timing: {
              delay_in: fixedZero,
              fade_in: fixedZero,
              curve_in: "Linear",
              delay_out: fixedZero,
              fade_out: fixedZero,
              curve_out: "Linear",
            },
            tracking_mode: { type: "Flags", data: "HTP" },
          },
        },
      });

      const api = stores.dockApi.get();
      const referencePanel = api.getPanel("panel-FixtureGrid");
      const panel = api.addPanel({
        id: ownedPanelId,
        component: "CueEditor",
        title: "Cue Full Attribute Grid E2E",
        params: {
          initialPanelId: ownedPanelId,
          initialCueUid: cueUid,
        },
        ...(referencePanel
          ? {
              position: {
                referencePanel: referencePanel.id,
                direction: "within",
              },
            }
          : {}),
      });
      panel.api.setActive();
      panel.focus();

      return {
        cueId,
        cueUid,
        editAttribute: "Green",
        fixtureId: targetFixtureId,
        fixtureIds: ownedFixtureIds,
        fixtureUid: fixture.identifiers.uid,
        incompatibleAttribute: "Pan",
        panelId: ownedPanelId,
        seedCue,
        sequenceId,
        sequenceUid,
      };
    },
    { fixtureIds, panelId },
  );

  await expect
    .poll(() =>
      page.evaluate(({ cueUid, sequenceUid }) => {
        const stores = (window as any).appStores;
        return {
          cueCount: Object.keys(stores.cues.get()).length,
          cueUid: stores.cues.get()[cueUid]?.identifiers.uid,
          fixtureCount: Object.keys(stores.fixtures.get()).length,
          sequenceCount: Object.keys(stores.sequences.get()).length,
          sequenceSteps: stores.sequences.get()[sequenceUid]?.steps,
        };
      }, context),
    )
    .toEqual({
      cueCount: 1,
      cueUid: context.cueUid,
      fixtureCount: 2,
      sequenceCount: 1,
      sequenceSteps: [context.cueUid],
    });

  return context;
}

/** Deletes the exact cue, sequence, and fixtures owned by this scenario. */
async function cleanupOwnedFullAttributeData(
  page: Page,
  context: OwnedFullAttributeContext,
): Promise<void> {
  await page.evaluate(async (owned) => {
    const stores = (window as any).appStores;

    /** Deletes one owned record and rejects failed backend outcomes. */
    const remove = async (message: object): Promise<void> => {
      const result = await stores.sendAndAwait(message);
      if (result.outcome.type !== "Succeeded") {
        throw new Error(
          `failed to delete owned full-attribute data: ${JSON.stringify(result)}`,
        );
      }
    };

    await remove({
      module: "CueCommand",
      command: {
        type: "DeleteCue",
        data: { sequence_id: owned.sequenceId, cue_id: owned.cueId },
      },
    });
    await remove({
      module: "CueCommand",
      command: { type: "DeleteSequence", data: owned.sequenceId },
    });
    for (const fixtureId of owned.fixtureIds) {
      await remove({
        module: "FixtureCommand",
        command: { type: "DeleteFixture", data: fixtureId },
      });
    }
  }, context);

  await expect
    .poll(() =>
      page.evaluate(() => {
        const stores = (window as any).appStores;
        return {
          cues: Object.keys(stores.cues.get()).length,
          fixtures: Object.keys(stores.fixtures.get()).length,
          sequences: Object.keys(stores.sequences.get()).length,
        };
      }),
    )
    .toEqual({ cues: 0, fixtures: 0, sequences: 0 });
}

/**
 * Verifies the cue editor can reveal and assert fixture-supported attributes.
 */
test("cue editor full grid reveals unasserted attributes for value edits", async ({
  backendSlot,
  page,
}) => {
  await openOwnedFullAttributeApp(page, backendSlot.backendPort);
  const panelId = `panel-CueEditor-full-attribute-grid-e2e-${Date.now()}`;
  const context = await storeOwnedFullAttributeData(page, panelId);

  try {
    await storeCueAndWait(page, context.seedCue, context.fixtureUid, "Red");
    const cuePanel = page.locator(`[data-panel-id="${panelId}"]:visible`);
    const grid = cuePanel
      .locator('[data-grid-owner="cue-editor"]')
      .locator('[data-grid-kind="tanstack"]');
    await expect(grid).toBeVisible({ timeout: 60_000 });
    const previewTransitionsButton = cuePanel.getByRole("button", {
      name: "Toggle preview transitions",
    });
    const previewTransitionsIcon = previewTransitionsButton.locator("svg");
    await expect(previewTransitionsButton).toBeEnabled();
    await expect(previewTransitionsButton).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(previewTransitionsIcon).toBeVisible();
    const enabledIconMarkup = await previewTransitionsIcon.innerHTML();
    await previewTransitionsButton.click();
    await expect(previewTransitionsButton).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await expect
      .poll(() => previewTransitionsIcon.innerHTML())
      .not.toBe(enabledIconMarkup);
    await previewTransitionsButton.click();
    await expect(previewTransitionsButton).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await storeCueAndWait(page, context.seedCue, context.fixtureUid, "Red");

    const editColumnKey = cueGridAttributeValueColumnKey(context.editAttribute);
    const incompatibleColumnKey = cueGridAttributeValueColumnKey(
      context.incompatibleAttribute,
    );
    await expect(gridHeaderByColumnKey(grid, editColumnKey)).toHaveCount(0);
    await expect(
      gridHeaderByColumnKey(grid, incompatibleColumnKey),
    ).toHaveCount(0);
    await expect
      .poll(async () =>
        page.evaluate((cueUid) => {
          const cue = (window as any).appStores?.cues?.get?.()?.[cueUid];
          return cue?.instructions?.[0]?.cue_instruction?.values?.Green;
        }, context.cueUid),
      )
      .toBeUndefined();

    await cuePanel.getByRole("button", { name: "Column visibility" }).click();
    const columnMenu = page.locator(
      '[data-menu-kind="column-visibility"]:visible',
    );
    const editColumnCheckbox = columnMenu.getByRole("checkbox", {
      name: context.editAttribute,
      exact: true,
    });
    await expect(editColumnCheckbox).toBeVisible();
    await expect(
      columnMenu
        .getByRole("checkbox", {
          name: context.incompatibleAttribute,
          exact: true,
        })
        .first(),
    ).toHaveCount(0);
    await editColumnCheckbox.click();
    await expect(editColumnCheckbox).toBeChecked();
    const editHeader = gridHeaderByColumnKey(grid, editColumnKey);
    await scrollGridToColumn(grid, editHeader);
    await expect(editHeader).toBeVisible();
    await cuePanel.getByRole("button", { name: "Column visibility" }).click();
    await expect(columnMenu).toBeHidden();

    const editCell = await gridCellByIdentifier(grid, {
      columnKey: editColumnKey,
      identifierColumnKey: "id",
      identifierText: String(context.fixtureId),
    });
    await expect(editCell).toBeVisible();
    await expect(editCell).toHaveText("");
    await expect(editCell).toHaveCSS("background-color", "rgb(25, 27, 29)");
    await editCell.click({ force: true });
    await page.keyboard.press("Enter");

    const editor = editCell.locator("input");
    await expect(editor).toBeVisible();
    await editor.fill("50%");
    await editor.press("Enter");

    await page.waitForFunction(
      ({ cueUid: targetCueUid, fixtureUid, attribute, expected }) => {
        const cue = (window as any).appStores?.cues?.get?.()?.[targetCueUid];
        const instruction = cue?.instructions?.find((item: any) =>
          item.selection?.source?.data?.some(
            (ref: any) => ref.fixture_uid === fixtureUid,
          ),
        );
        const value = instruction?.cue_instruction?.values?.[attribute]?.data;
        return (
          value?.type === "AbsolutePercent" &&
          Math.abs(value.data.value - expected) < 0.0001
        );
      },
      {
        cueUid: context.cueUid,
        fixtureUid: context.fixtureUid,
        attribute: context.editAttribute,
        expected: 0.5,
      },
      { timeout: 5_000 },
    );
    await expect(editCell).toContainText("50%");
  } finally {
    await cleanupOwnedFullAttributeData(page, context);
  }
});
