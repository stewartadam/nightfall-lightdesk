// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

test.use({ experimentalFlows: true });

const COMMAND_INPUT_PLACEHOLDER = "Type a command or search...";

type DirectInstanceContext = {
  clipId: number;
  flowId: number;
  flowInstanceName: string;
  stepFxId: number;
  stepFxLabel: string;
};

/** Opens the direct-instance scenario against a blank backend. */
async function openOwnedDirectInstanceApp(
  page: Page,
  backendPort: number,
): Promise<void> {
  await prepareFreshBackendShowfile(backendPort);
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("nightfall.currentShowfileName", "default");
  });
  await page.setViewportSize({ width: 1800, height: 1100 });
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await expect(page.locator("main#app")).toBeVisible();
  await waitForDockviewApp(page);
  await page.waitForFunction(
    () =>
      typeof (window as any).appStores?.sendAndAwait === "function" &&
      Boolean((window as any).appStores?.activeInstances?.get) &&
      Boolean((window as any).appStores?.clips?.get) &&
      Boolean((window as any).appStores?.flows?.get) &&
      Boolean((window as any).appStores?.stepFx?.get),
  );
  await expect
    .poll(() =>
      page.evaluate(() => {
        const stores = (window as any).appStores;
        return {
          clips: Object.keys(stores.clips.get()).length,
          flows: Object.keys(stores.flows.get()).length,
          instances: Object.keys(stores.activeInstances.get()).length,
          stepFx: Object.keys(stores.stepFx.get()).length,
        };
      }),
    )
    .toEqual({ clips: 0, flows: 0, instances: 0, stepFx: 0 });
}

/** Stores the Step FX, Flow, and bound clip used by direct starts. */
async function storeOwnedDirectInstanceData(
  page: Page,
): Promise<DirectInstanceContext> {
  const context = await page.evaluate(async () => {
    const stores = (window as any).appStores;
    const baseId = Math.floor(900_000 + Math.random() * 30_000);
    const stepFxId = baseId;
    const flowId = baseId + 1;
    const clipId = baseId + 2;
    const stepFxUid = crypto.randomUUID().replaceAll("-", "");
    const flowUid = crypto.randomUUID().replaceAll("-", "");
    const clipUid = crypto.randomUUID().replaceAll("-", "");
    const stepFxLabel = "Owned Direct Step FX";
    const flowLabel = "Owned Direct Flow";

    /** Sends one store command and rejects failed backend outcomes. */
    const store = async (message: object): Promise<void> => {
      const result = await stores.sendAndAwait(message);
      if (result.outcome.type !== "Succeeded") {
        throw new Error(
          `failed to store direct instance data: ${JSON.stringify(result)}`,
        );
      }
    };

    await store({
      module: "StepFxCommand",
      command: {
        type: "Store",
        data: {
          identifiers: {
            uid: stepFxUid,
            id: stepFxId,
            label: stepFxLabel,
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
      module: "FlowCommand",
      command: {
        type: "StoreFlow",
        data: {
          identifiers: {
            uid: flowUid,
            id: flowId,
            label: flowLabel,
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
            uid: clipUid,
            id: clipId,
            label: "Owned Direct Step FX Clip",
          },
          source: { type: "StepFx", data: stepFxUid },
          priority: 0,
          options: {
            auto_release: false,
            deactivate_on_sequence_end: false,
          },
        },
      },
    });

    return {
      clipId,
      flowId,
      flowInstanceName: flowLabel,
      stepFxId,
      stepFxLabel,
    };
  });

  await expect
    .poll(() =>
      page.evaluate(({ clipId, flowId, stepFxId }) => {
        const stores = (window as any).appStores;
        /** Reports whether a definition collection contains a numeric ID. */
        const hasId = (
          entries: Array<{ identifiers: { id: number } }>,
          id: number,
        ) => entries.some((entry) => entry.identifiers.id === id);
        return {
          clip: hasId(
            Object.values(stores.clips.get()).map((entry: any) => entry[0]),
            clipId,
          ),
          flow: hasId(Object.values(stores.flows.get()), flowId),
          stepFx: hasId(Object.values(stores.stepFx.get()), stepFxId),
        };
      }, context),
    )
    .toEqual({ clip: true, flow: true, stepFx: true });

  return context;
}

/**
 * Opens a panel used by direct instance tests.
 */
async function openPanel(page: Page, panelName: string): Promise<void> {
  await page.keyboard.press("Meta+Shift+P");

  const commandInput = page.getByPlaceholder(COMMAND_INPUT_PLACEHOLDER);
  await expect(commandInput).toBeVisible();
  await commandInput.fill(`Open ${panelName}`);
  await page.keyboard.press("Enter");
}

/** Verifies direct Step FX and Flow starts stay unbound from an owned clip. */
test("direct fx and flow starts create unbound instances", async ({
  backendSlot,
  page,
}, testInfo) => {
  await openOwnedDirectInstanceApp(page, backendSlot.backendPort);
  const context = await storeOwnedDirectInstanceData(page);

  await page.evaluate(async (clipId) => {
    await (window as any).appStores.send({
      module: "ClipCommand",
      command: {
        type: "StartClip",
        data: { type: "Single", data: clipId },
      },
    });
  }, context.clipId);

  await expect
    .poll(
      () =>
        page.evaluate(
          ({ clipId, stepFxLabel }) =>
            Object.values((window as any).appStores.activeInstances.get()).some(
              (instance: any) =>
                instance.bound_clip_id === clipId &&
                instance.name === stepFxLabel,
            ),
          context,
        ),
      { timeout: 10_000 },
    )
    .toBe(true);

  await page.evaluate(async (clipId) => {
    await (window as any).appStores.send({
      module: "ClipCommand",
      command: {
        type: "StopClip",
        data: { type: "Single", data: clipId },
      },
    });
  }, context.clipId);

  await expect
    .poll(
      () =>
        page.evaluate(
          (stepFxLabel) =>
            Object.values(
              (window as any).appStores.activeInstances.get(),
            ).filter((instance: any) => instance.name === stepFxLabel).length,
          context.stepFxLabel,
        ),
      { timeout: 10_000 },
    )
    .toBe(0);

  await page.evaluate(async ({ flowId, stepFxId }) => {
    const stores = (window as any).appStores;

    /** Evaluates one direct instance command and rejects failed outcomes. */
    const evaluate = async (command: string): Promise<void> => {
      const result = await stores.sendAndAwait({
        module: "DeskCommand",
        command: { type: "Eval", data: command },
      });
      if (result.outcome.type !== "Succeeded") {
        throw new Error(
          `failed to evaluate direct instance command: ${JSON.stringify(result)}`,
        );
      }
    };

    await evaluate(`fx ${stepFxId} start`);
    await evaluate(`flow ${flowId} start`);
  }, context);

  const expectedDirectNames = [
    context.flowInstanceName,
    context.stepFxLabel,
  ].sort();
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const instances = Object.values(
            (window as any).appStores.activeInstances.get(),
          ) as Array<{
            bound_clip_id?: number | null;
            name?: string | null;
          }>;

          return instances
            .filter((instance) => instance.bound_clip_id == null)
            .map((instance) => instance.name)
            .sort();
        }),
      { timeout: 10_000 },
    )
    .toEqual(expectedDirectNames);

  await page.evaluate(async ({ clipId, stepFxId }) => {
    await (window as any).appStores.send({
      module: "ClipCommand",
      command: {
        type: "StopClip",
        data: { type: "Single", data: clipId },
      },
    });
    const result = await (window as any).appStores.sendAndAwait({
      module: "DeskCommand",
      command: { type: "Eval", data: `fx ${stepFxId} start` },
    });
    if (result.outcome.type !== "Succeeded") {
      throw new Error(
        `failed to restart direct Step FX: ${JSON.stringify(result)}`,
      );
    }
  }, context);

  await expect
    .poll(
      () =>
        page.evaluate(({ clipId, stepFxLabel }) => {
          const instances = Object.values(
            (window as any).appStores.activeInstances.get(),
          ) as Array<{
            bound_clip_id?: number | null;
            name?: string | null;
          }>;

          return {
            boundStepFx: instances.some(
              (instance) =>
                instance.name === stepFxLabel &&
                instance.bound_clip_id === clipId,
            ),
            directNames: instances
              .filter((instance) => instance.bound_clip_id == null)
              .map((instance) => instance.name)
              .sort(),
          };
        }, context),
      { timeout: 10_000 },
    )
    .toEqual({
      boundStepFx: false,
      directNames: expectedDirectNames,
    });

  await openPanel(page, "Status Display");

  await expect(
    page.getByRole("heading", { name: "Active Instances" }),
  ).toBeVisible();
  await expect(
    page.getByRole("row", {
      name: new RegExp(`Step FX ${context.stepFxLabel} .*Unbound`),
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("row", {
      name: new RegExp(`Flow FX ${context.flowInstanceName} .*Unbound`),
    }),
  ).toBeVisible();
  await expect(page.getByText("Exec null")).toHaveCount(0);

  await page.screenshot({
    path: testInfo.outputPath("direct-instance-start.png"),
    fullPage: true,
  });

  await page.evaluate(async ({ flowId, stepFxId }) => {
    const stores = (window as any).appStores;

    /** Stops one owned direct instance and rejects failed outcomes. */
    const stop = async (command: string): Promise<void> => {
      const result = await stores.sendAndAwait({
        module: "DeskCommand",
        command: { type: "Eval", data: command },
      });
      if (result.outcome.type !== "Succeeded") {
        throw new Error(
          `failed to stop owned direct instance: ${JSON.stringify(result)}`,
        );
      }
    };

    await stop(`fx ${stepFxId} stop`);
    await stop(`flow ${flowId} stop`);
  }, context);

  await expect
    .poll(
      () =>
        page.evaluate(
          ({ flowInstanceName, stepFxLabel }) =>
            Object.values((window as any).appStores.activeInstances.get())
              .filter((instance: any) =>
                [flowInstanceName, stepFxLabel].includes(instance.name),
              )
              .map((instance: any) => instance.name)
              .sort(),
          context,
        ),
      { timeout: 10_000 },
    )
    .toEqual([]);
});
