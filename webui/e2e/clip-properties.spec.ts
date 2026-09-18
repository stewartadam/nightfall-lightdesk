// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import { expect, type Locator, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

test.use({ experimentalFlows: true });

type ClipPropertiesContext = {
  firstClipId: number;
  firstClipUid: string;
  inspectedClipId: number;
  inspectedClipUid: string;
  firstFxLabel: string;
  firstFxUid: string;
  firstStepFxLabel: string;
  firstStepFxUid: string;
  firstFxModuleLabel: string;
  firstFxModuleUid: string;
  firstFlowLabel: string;
  firstFlowUid: string;
};

/** Opens the clip properties scenario against a blank backend. */
async function openOwnedClipPropertiesApp(
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
      Boolean((window as any).appStores?.cues?.get) &&
      Boolean((window as any).appStores?.sequences?.get) &&
      Boolean((window as any).appStores?.clips?.get) &&
      Boolean((window as any).appStores?.fx?.get) &&
      Boolean((window as any).appStores?.stepFx?.get) &&
      Boolean((window as any).appStores?.fxModules?.get) &&
      Boolean((window as any).appStores?.flows?.get),
  );
  await expect
    .poll(() =>
      page.evaluate(() => {
        const stores = (window as any).appStores;
        return {
          cues: Object.keys(stores.cues.get()).length,
          clips: Object.keys(stores.clips.get()).length,
          flows: Object.keys(stores.flows.get()).length,
          fx: Object.keys(stores.fx.get()).length,
          fxModules: Object.keys(stores.fxModules.get()).length,
          sequences: Object.keys(stores.sequences.get()).length,
          stepFx: Object.keys(stores.stepFx.get()).length,
        };
      }),
    )
    .toEqual({
      cues: 0,
      clips: 0,
      flows: 0,
      fx: 0,
      fxModules: 0,
      sequences: 0,
      stepFx: 0,
    });
}

/** Stores every clip and source record exercised by the properties editor. */
async function storeOwnedClipPropertiesData(
  page: Page,
): Promise<ClipPropertiesContext> {
  const context = await page.evaluate(async () => {
    const stores = (window as any).appStores;
    const baseId = Math.floor(900_000 + Math.random() * 30_000);
    const firstClipId = baseId;
    const inspectedClipId = baseId + 1;
    const fxId = baseId + 10;
    const stepFxId = baseId + 11;
    const fxModuleId = baseId + 12;
    const flowId = baseId + 13;
    const cueUid = crypto.randomUUID().replaceAll("-", "");
    const sequenceUid = crypto.randomUUID().replaceAll("-", "");
    const setupCueUid = crypto.randomUUID().replaceAll("-", "");
    const releaseCueUid = crypto.randomUUID().replaceAll("-", "");
    const firstClipUid = crypto.randomUUID().replaceAll("-", "");
    const inspectedClipUid = crypto.randomUUID().replaceAll("-", "");
    const fxUid = crypto.randomUUID().replaceAll("-", "");
    const stepFxUid = crypto.randomUUID().replaceAll("-", "");
    const fxModuleUid = crypto.randomUUID().replaceAll("-", "");
    const flowUid = crypto.randomUUID().replaceAll("-", "");
    const fixedZero = {
      type: "Fixed",
      data: { secs: 0, nanos: 0 },
    };

    /** Builds an empty sequence metadata cue. */
    const metaCue = (uid: string, label: string): object => ({
      identifiers: { uid, id: 0, label },
      trigger: { type: "Manual" },
      transitions: {},
      transitions_by_attribute: {},
      instructions: [],
      parts: [],
      references: {},
      tracking_flags: "HTP",
    });

    /** Sends one store command and rejects failed backend outcomes. */
    const store = async (message: object): Promise<void> => {
      const result = await stores.sendAndAwait(message);
      if (result.outcome.type !== "Succeeded") {
        throw new Error(
          `failed to store clip properties data: ${JSON.stringify(result)}`,
        );
      }
    };

    await store({
      module: "CueCommand",
      command: {
        type: "StoreCue",
        data: {
          identifiers: {
            uid: cueUid,
            id: baseId + 20,
            label: "Clip Properties Cue",
          },
          trigger: { type: "Manual" },
          transitions: {},
          transitions_by_attribute: {},
          instructions: [],
          parts: [],
          tracking_flags: "HTP",
        },
      },
    });
    await store({
      module: "CueCommand",
      command: {
        type: "StoreSequence",
        data: {
          identifiers: {
            uid: sequenceUid,
            id: baseId + 20,
            label: "Clip Properties Sequence",
          },
          steps: [cueUid],
          wrap: false,
          release_on_start: false,
          setup_cue: metaCue(setupCueUid, "Setup"),
          release_cue: metaCue(releaseCueUid, "Release"),
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
    await store({
      module: "FxCommand",
      command: {
        type: "StoreFx",
        data: {
          identifiers: {
            uid: fxUid,
            id: fxId,
            label: "Clip Properties FX",
          },
          selection: {
            source: { type: "Resolved", data: [] },
            clauses: [],
          },
          attributes: {},
        },
      },
    });
    await store({
      module: "StepFxCommand",
      command: {
        type: "Store",
        data: {
          identifiers: {
            uid: stepFxUid,
            id: stepFxId,
            label: "Clip Properties Step FX",
          },
          selection: {
            source: { type: "Resolved", data: [] },
            clauses: [],
          },
          timing: { beat_duration: { secs: 1, nanos: 0 } },
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
                  width_beats: 1,
                  transition: { start: 0, end: 1 },
                  curve: { type: "Snap", data: {} },
                })),
              },
            },
          ],
        },
      },
    });
    await store({
      module: "FxModuleCommand",
      command: {
        type: "StoreFxModule",
        data: {
          identifiers: {
            uid: fxModuleUid,
            id: fxModuleId,
            label: "Clip Properties Module FX",
          },
          module_name: "clip-properties",
          selection: {
            source: { type: "Resolved", data: [] },
            clauses: [],
          },
          config: {},
          merge: false,
        },
      },
    });
    await store({
      module: "FlowCommand",
      command: {
        type: "StoreFlow",
        data: {
          identifiers: {
            uid: flowUid,
            id: flowId,
            label: "Clip Properties Flow",
          },
          flow_version: 0,
          nodes: [],
          edges: [],
        },
      },
    });
    await store({
      module: "ClipCommand",
      command: {
        type: "StoreClip",
        data: {
          identifiers: {
            uid: firstClipUid,
            id: firstClipId,
            label: "Clip Properties Selection",
          },
          source: { type: "Fx", data: fxUid },
          priority: 0,
          options: {
            auto_release: false,
            deactivate_on_sequence_end: false,
          },
        },
      },
    });
    await store({
      module: "ClipCommand",
      command: {
        type: "StoreClip",
        data: {
          identifiers: {
            uid: inspectedClipUid,
            id: inspectedClipId,
            label: "Clip Properties Inspector",
          },
          source: { type: "Sequence", data: sequenceUid },
          priority: 7,
          options: {
            auto_release: false,
            deactivate_on_sequence_end: false,
          },
        },
      },
    });

    return {
      firstClipId,
      firstClipUid,
      inspectedClipId,
      inspectedClipUid,
      firstFxLabel: `${fxId}: Clip Properties FX`,
      firstFxUid: fxUid,
      firstStepFxLabel: `${stepFxId}: Clip Properties Step FX`,
      firstStepFxUid: stepFxUid,
      firstFxModuleLabel: `${fxModuleId}: Clip Properties Module FX`,
      firstFxModuleUid: fxModuleUid,
      firstFlowLabel: `${flowId}: Clip Properties Flow`,
      firstFlowUid: flowUid,
    };
  });

  await expect
    .poll(() =>
      page.evaluate(
        ({
          firstClipUid,
          firstFlowUid,
          firstFxModuleUid,
          firstFxUid,
          firstStepFxUid,
          inspectedClipUid,
        }) => {
          const stores = (window as any).appStores;
          return {
            clips: [firstClipUid, inspectedClipUid].every((uid) =>
              Boolean(stores.clips.get()[uid]),
            ),
            flow: Boolean(stores.flows.get()[firstFlowUid]),
            fx: Boolean(stores.fx.get()[firstFxUid]),
            fxModule: Boolean(stores.fxModules.get()[firstFxModuleUid]),
            stepFx: Boolean(stores.stepFx.get()[firstStepFxUid]),
          };
        },
        context,
      ),
    )
    .toEqual({
      clips: true,
      flow: true,
      fx: true,
      fxModule: true,
      stepFx: true,
    });

  return context;
}

/** Activates and focuses one Dockview panel by its stable identifier. */
async function activatePanel(page: Page, id: string): Promise<void> {
  await page.evaluate((panelId) => {
    const panel = (window as any).appStores.dockApi.get().getPanel(panelId);
    panel?.api.setActive();
    panel?.focus();
  }, id);
}

/** Locates the Properties Inspector heading for one clip. */
function clipPropertiesHeading(page: Page, clipId: number): Locator {
  return page.getByRole("heading", {
    name: `Clip ${clipId}`,
    exact: true,
  });
}

/** Verifies clip selection, property edits, and all supported source types. */
test("clip properties can be opened from grid cards and edited", async ({
  backendSlot,
  page,
}) => {
  test.setTimeout(45_000);
  await openOwnedClipPropertiesApp(page, backendSlot.backendPort);
  const context = await storeOwnedClipPropertiesData(page);
  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    api.getPanel("panel-ClipList")?.api.close();
    api.getPanel("panel-ClipList-e2e")?.api.close();
    if (!api.getPanel("panel-ClipList-e2e")) {
      api.addPanel({
        id: "panel-ClipList-e2e",
        component: "ClipList",
        title: "Clips",
        position: {
          referencePanel: "panel-FixtureGrid",
          direction: "within",
        },
        params: { initialPanelId: "panel-ClipList-e2e" },
      });
    }
    if (!api.getPanel("panel-PropertiesInspector")) {
      api.addPanel({
        id: "panel-PropertiesInspector",
        component: "PropertiesInspector",
        title: "Properties",
        params: {},
      });
    }
  });

  await activatePanel(page, "panel-ClipList-e2e");
  const clipPanel = page.locator(
    '[data-panel-kind="clips"][data-panel-id="panel-ClipList-e2e"]:visible',
  );
  await expect(clipPanel).toBeVisible();
  const switchToGrid = clipPanel.getByRole("button", {
    name: "Switch to grid view",
  });
  if (await switchToGrid.isVisible()) {
    await switchToGrid.click();
  }

  await clipPanel
    .getByRole("button", { name: "Toggle selection mode" })
    .click();
  await clipPanel
    .locator(`[data-crud-select-id="${context.firstClipUid}"]`)
    .click();
  await activatePanel(page, "panel-PropertiesInspector");

  await expect(clipPropertiesHeading(page, context.firstClipId)).toBeVisible();

  await activatePanel(page, "panel-ClipList-e2e");
  await page.evaluate(() =>
    (window as any).appStores.dockApi.get().getEdgeGroup("right")?.collapse(),
  );
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).appStores.dockApi
          .get()
          .getEdgeGroup("right")
          ?.isCollapsed(),
      ),
    )
    .toBe(true);

  await clipPanel
    .getByRole("button", { name: "Toggle selection mode" })
    .click();

  const inspectButton = clipPanel.getByRole("button", {
    name: `Inspect clip ${context.inspectedClipId}`,
    exact: true,
  });
  await expect(inspectButton).toBeVisible();
  await inspectButton.click();

  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).appStores.dockApi.get().activePanel?.id,
      ),
    )
    .toBe("panel-ClipList-e2e");

  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).appStores.dockApi
          .get()
          .getEdgeGroup("right")
          ?.isCollapsed(),
      ),
    )
    .toBe(false);

  await expect(
    clipPropertiesHeading(page, context.inspectedClipId),
  ).toBeVisible();

  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    const clipPanel = api.getPanel("panel-ClipList-e2e");
    const propertiesPanel = api.getPanel("panel-PropertiesInspector");
    propertiesPanel?.api.moveTo({
      group: clipPanel?.api.group,
      position: "center",
    });
    clipPanel?.api.setActive();
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).appStores.dockApi.get().activePanel?.id,
      ),
    )
    .toBe("panel-ClipList-e2e");

  await inspectButton.click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).appStores.dockApi.get().activePanel?.id,
      ),
    )
    .toBe("panel-PropertiesInspector");
  await expect(
    clipPropertiesHeading(page, context.inspectedClipId),
  ).toBeVisible();

  const priorityInput = page.getByLabel("Clip priority");
  await expect(priorityInput).toBeVisible();
  const initialPriority = await page.evaluate((clipUid) => {
    const entry = (window as any).appStores.clips.get()[clipUid];
    return entry?.[0].priority ?? 0;
  }, context.inspectedClipUid);
  const nextPriority = initialPriority === 23 ? 24 : 23;
  await expect(priorityInput).toHaveValue(String(initialPriority));
  await priorityInput.fill(String(nextPriority));
  await priorityInput.press("Enter");

  await expect
    .poll(
      async () =>
        page.evaluate((clipUid) => {
          const entry = (window as any).appStores.clips.get()[clipUid];
          return entry?.[0].priority ?? 0;
        }, context.inspectedClipUid),
      { timeout: 10_000 },
    )
    .toBe(nextPriority);

  await priorityInput.fill("");
  await priorityInput.press("Enter");
  await expect(priorityInput).toHaveValue(String(nextPriority));
  await expect
    .poll(
      async () =>
        page.evaluate((clipUid) => {
          const entry = (window as any).appStores.clips.get()[clipUid];
          return entry?.[0].priority ?? 0;
        }, context.inspectedClipUid),
      { timeout: 10_000 },
    )
    .toBe(nextPriority);

  await page.screenshot({
    path: test.info().outputPath("shared-clip-fields.png"),
    fullPage: true,
  });

  const autoReleaseToggle = page.locator(
    'label:has-text("Auto-release") input[type="checkbox"]',
  );
  const initialAutoRelease = await autoReleaseToggle.isChecked();
  await autoReleaseToggle.click();

  await expect
    .poll(
      async () =>
        page.evaluate((clipUid) => {
          const entry = (window as any).appStores.clips.get()[clipUid];
          return entry?.[0].options?.auto_release ?? false;
        }, context.inspectedClipUid),
      { timeout: 10_000 },
    )
    .toBe(!initialAutoRelease);

  const deactivateOnEndToggle = page.locator(
    'label:has-text("Deactivate on sequence end") input[type="checkbox"]',
  );
  const initialDeactivateOnEnd = await deactivateOnEndToggle.isChecked();
  await deactivateOnEndToggle.click();

  await expect
    .poll(
      async () =>
        page.evaluate((clipUid) => {
          const entry = (window as any).appStores.clips.get()[clipUid];
          return entry?.[0].options?.deactivate_on_sequence_end ?? false;
        }, context.inspectedClipUid),
      { timeout: 10_000 },
    )
    .toBe(!initialDeactivateOnEnd);

  await page.getByRole("button", { name: "FX", exact: true }).click();
  await page
    .getByRole("button", { name: context.firstFxLabel, exact: true })
    .click();

  await expect
    .poll(
      async () =>
        page.evaluate((clipUid) => {
          const entry = (window as any).appStores.clips.get()[clipUid];
          const source = entry?.[0].source;
          return source ? `${source.type}:${source.data}` : "none";
        }, context.inspectedClipUid),
      { timeout: 10_000 },
    )
    .toBe(`Fx:${context.firstFxUid}`);

  await expect(
    page.getByRole("button", { name: "FX", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({
    path: test.info().outputPath("shared-clip-source.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Step FX", exact: true }).click();
  await page
    .getByRole("button", { name: context.firstStepFxLabel, exact: true })
    .click();

  await expect
    .poll(
      async () =>
        page.evaluate((clipUid) => {
          const entry = (window as any).appStores.clips.get()[clipUid];
          const source = entry?.[0].source;
          return source ? `${source.type}:${source.data}` : "none";
        }, context.inspectedClipUid),
      { timeout: 10_000 },
    )
    .toBe(`StepFx:${context.firstStepFxUid}`);

  await page.getByRole("button", { name: "Module FX", exact: true }).click();
  await page
    .getByRole("button", { name: context.firstFxModuleLabel, exact: true })
    .click();

  await expect
    .poll(
      async () =>
        page.evaluate((clipUid) => {
          const entry = (window as any).appStores.clips.get()[clipUid];
          const source = entry?.[0].source;
          return source ? `${source.type}:${source.data}` : "none";
        }, context.inspectedClipUid),
      { timeout: 10_000 },
    )
    .toBe(`FxModule:${context.firstFxModuleUid}`);

  await page.getByRole("button", { name: "Flow", exact: true }).click();
  await page
    .getByRole("button", { name: context.firstFlowLabel, exact: true })
    .click();

  await expect
    .poll(
      async () =>
        page.evaluate((clipUid) => {
          const entry = (window as any).appStores.clips.get()[clipUid];
          const source = entry?.[0].source;
          return source ? `${source.type}:${source.data}` : "none";
        }, context.inspectedClipUid),
      { timeout: 10_000 },
    )
    .toBe(`Flow:${context.firstFlowUid}`);

  await activatePanel(page, "panel-ClipList-e2e");
  await clipPanel.getByRole("button", { name: "Switch to list view" }).click();

  const clipGrid = clipPanel.getByRole("grid");
  await expect(clipGrid).toBeVisible();
  await clipGrid
    .getByRole("gridcell", {
      name: String(context.firstClipId),
      exact: true,
    })
    .click();
  await activatePanel(page, "panel-PropertiesInspector");

  await expect(clipPropertiesHeading(page, context.firstClipId)).toBeVisible();
});

/** Verifies numeric source commands resolve every domain and visibly update the assigned clip. */
test("numeric clip source references resolve through domain registrations", async ({
  backendSlot,
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  await openOwnedClipPropertiesApp(page, backendSlot.backendPort);
  const context = await storeOwnedClipPropertiesData(page);
  await page.getByRole("button", { name: "Open command palette" }).click();
  const commandInput = page.getByPlaceholder("Type a command or search...");
  await commandInput.fill("Open Clips");
  await commandInput.press("Enter");
  const panel = page.locator('[data-panel-kind="clips"]:visible');
  await expect(panel).toBeVisible();
  const gridSwitch = panel.getByRole("button", { name: "Switch to grid view" });
  if (await gridSwitch.isVisible()) await gridSwitch.click();
  const card = panel.locator(
    `[data-crud-select-id="${context.inspectedClipUid}"]`,
  );
  await expect(card).toBeVisible();

  for (const [kind, offset] of [
    ["Sequence", 20],
    ["Fx", 10],
    ["StepFx", 11],
    ["FxModule", 12],
    ["Flow", 13],
  ] as const) {
    const result = await page.evaluate(
      async ({ clipId, sourceId, kind }) => {
        return (window as any).appStores.sendAndAwait({
          module: "ClipCommand",
          command: {
            type: "AssignSourceById",
            data: { clip_id: clipId, source: { type: kind, data: sourceId } },
          },
        });
      },
      {
        clipId: context.inspectedClipId,
        sourceId: context.firstClipId + offset,
        kind,
      },
    );
    expect(result.outcome.type).toBe("Succeeded");
    await expect(card.getByText(kind, { exact: true })).toBeVisible();
  }
  const before = await page.evaluate(
    (uid) => (window as any).appStores.clips.get()[uid][0].source,
    context.inspectedClipUid,
  );
  const missing = await page.evaluate(async (clipId) => {
    return (window as any).appStores.sendAndAwait({
      module: "ClipCommand",
      command: {
        type: "AssignSourceById",
        data: { clip_id: clipId, source: { type: "Fx", data: 4_000_000_000 } },
      },
    });
  }, context.inspectedClipId);
  expect(missing.outcome.type).toBe("Failed");
  expect(missing.outcome.data.code).toBe("clip.source_not_found");
  expect(
    await page.evaluate(
      (uid) => (window as any).appStores.clips.get()[uid][0].source,
      context.inspectedClipUid,
    ),
  ).toEqual(before);
  await expect(card.getByText("Flow", { exact: true })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("numeric-source-assignment.png"),
  });
});
