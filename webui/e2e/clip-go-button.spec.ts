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

type ControlSnapshot = {
  index: number;
  assigned_clip_id: number | null;
};

type ClipControlScenario = {
  inactiveSequenceId: number;
  activeSequenceId: number;
  inactiveFxId: number;
  activeFxId: number;
};

/** Opens the control scenario against a blank backend and instruments worker commands. */
async function openOwnedClipControlApp(
  page: Page,
  backendPort: number,
): Promise<void> {
  await prepareFreshBackendShowfile(backendPort);
  await page.addInitScript(() => {
    type WindowWithWorkerMessages = Window & {
      __workerMessages?: unknown[];
    };
    const instrumentedWindow = window as WindowWithWorkerMessages;

    window.localStorage.clear();
    window.localStorage.setItem("nightfall.currentShowfileName", "default");
    instrumentedWindow.__workerMessages = [];

    const originalPostMessage = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (
      message: unknown,
      optionsOrTransfer?: StructuredSerializeOptions | Transferable[],
    ) {
      instrumentedWindow.__workerMessages ??= [];
      instrumentedWindow.__workerMessages.push(message);
      return originalPostMessage.call(
        this,
        message,
        optionsOrTransfer as never,
      );
    };
  });
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await expect(page.locator("main#app")).toBeVisible();
  await waitForDockviewApp(page);
  await page.waitForFunction(
    () =>
      typeof (window as any).appStores?.sendAndAwait === "function" &&
      Boolean((window as any).appStores?.controls?.get) &&
      Boolean((window as any).appStores?.cues?.get) &&
      Boolean((window as any).appStores?.sequences?.get) &&
      Boolean((window as any).appStores?.clips?.get) &&
      Boolean((window as any).appStores?.fx?.get),
  );
  await expect
    .poll(() =>
      page.evaluate(() => {
        const stores = (window as any).appStores;
        return {
          cues: Object.keys(stores.cues.get()).length,
          clips: Object.keys(stores.clips.get()).length,
          fx: Object.keys(stores.fx.get()).length,
          sequences: Object.keys(stores.sequences.get()).length,
        };
      }),
    )
    .toEqual({ cues: 0, clips: 0, fx: 0, sequences: 0 });
}

/**
 * Opens a panel used by clip playback tests.
 */
async function openPanel(page: Page, panelName: string): Promise<void> {
  await page.getByRole("button", { name: "Open command palette" }).click();

  const commandInput = page.getByPlaceholder(COMMAND_INPUT_PLACEHOLDER);
  await expect(commandInput).toBeVisible();
  await commandInput.fill(`Open ${panelName}`);
  await page.keyboard.press("Enter");
}

/**
 * Seeds live controls with known active and inactive sequence/fx assignments.
 */
async function seedClipControlScenario(
  page: Page,
): Promise<ClipControlScenario> {
  return page.evaluate(async () => {
    type AppStoresWindow = Window & {
      __workerMessages?: unknown[];
      appStores?: {
        clips?: {
          get: () => Record<string, [{ identifiers: { id: number } }, boolean]>;
        };
        controls?: { get: () => ControlSnapshot[] };
        send?: (data: object) => Promise<void>;
        sendAndAwait?: (data: object) => Promise<{
          outcome: { type: string };
        }>;
      };
    };
    const stores = (window as AppStoresWindow).appStores;
    if (
      !stores?.send ||
      !stores.sendAndAwait ||
      !stores.clips ||
      !stores.controls
    ) {
      throw new Error("clip stores did not initialize");
    }
    const baseId = Math.floor(900_000 + Math.random() * 30_000);
    const inactiveSequenceId = baseId;
    const activeSequenceId = baseId + 1;
    const inactiveFxId = baseId + 2;
    const activeFxId = baseId + 3;
    const cueUid = crypto.randomUUID().replaceAll("-", "");
    const sequenceUid = crypto.randomUUID().replaceAll("-", "");
    const setupCueUid = crypto.randomUUID().replaceAll("-", "");
    const releaseCueUid = crypto.randomUUID().replaceAll("-", "");
    const fxUid = crypto.randomUUID().replaceAll("-", "");
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
      const result = await stores.sendAndAwait?.(message);
      if (result?.outcome.type !== "Succeeded") {
        throw new Error(
          `failed to store control data: ${JSON.stringify(result)}`,
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
            id: baseId + 10,
            label: "Clip Control Cue",
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
            id: baseId + 10,
            label: "Clip Control Sequence",
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
            id: baseId + 11,
            label: "Clip Control FX",
          },
          selection: {
            source: { type: "Resolved", data: [] },
            clauses: [],
          },
          attributes: {},
        },
      },
    });

    const clipDefinitions = [
      {
        id: inactiveSequenceId,
        label: "Inactive Sequence Control",
        source: { type: "Sequence", data: sequenceUid },
      },
      {
        id: activeSequenceId,
        label: "Active Sequence Control",
        source: { type: "Sequence", data: sequenceUid },
      },
      {
        id: inactiveFxId,
        label: "Inactive FX Control",
        source: { type: "Fx", data: fxUid },
      },
      {
        id: activeFxId,
        label: "Active FX Control",
        source: { type: "Fx", data: fxUid },
      },
    ];

    for (const clip of clipDefinitions) {
      await store({
        module: "ClipCommand",
        command: {
          type: "StoreClip",
          data: {
            identifiers: {
              uid: crypto.randomUUID().replaceAll("-", ""),
              id: clip.id,
              label: clip.label,
            },
            source: clip.source,
            priority: 0,
            options: {
              auto_release: false,
              deactivate_on_sequence_end: false,
            },
          },
        },
      });
    }

    /** Sends a clip command through the same websocket path used by the UI. */
    const sendClipCommand = (type: string, id: number) =>
      stores.send?.({
        module: "ClipCommand",
        command: { type, data: { type: "Single", data: id } },
      });

    /** Sends a control command through the same websocket path used by the UI. */
    const sendControlCommand = (command: object) =>
      stores.send?.({ module: "ControlCommand", command });

    /** Waits until an arbitrary browser-side condition becomes true. */
    const waitForCondition = (description: string, predicate: () => boolean) =>
      new Promise<void>((resolve, reject) => {
        const started = Date.now();

        /** Polls the supplied condition until it passes or times out. */
        const tick = () => {
          if (predicate()) {
            resolve();
            return;
          }

          if (Date.now() - started > 10_000) {
            reject(new Error(description));
            return;
          }

          window.setTimeout(tick, 100);
        };

        tick();
      });

    await sendClipCommand("StartClip", activeSequenceId);
    await sendClipCommand("StartClip", activeFxId);

    await waitForCondition("owned active clips did not start", () => {
      const states = Object.values(stores.clips?.get?.() ?? {});
      const stateForId = (id: number) =>
        states.find(([candidate]) => candidate.identifiers.id === id)?.[1];
      return (
        stateForId(inactiveSequenceId) === false &&
        stateForId(activeSequenceId) === true &&
        stateForId(inactiveFxId) === false &&
        stateForId(activeFxId) === true
      );
    });

    await sendControlCommand({
      type: "AssignClip",
      data: {
        control_index: 1,
        clip_id: inactiveSequenceId,
      },
    });
    await sendControlCommand({
      type: "AssignClip",
      data: {
        control_index: 2,
        clip_id: activeSequenceId,
      },
    });
    await sendControlCommand({
      type: "AssignClip",
      data: {
        control_index: 3,
        clip_id: inactiveFxId,
      },
    });
    await sendControlCommand({
      type: "AssignClip",
      data: {
        control_index: 4,
        clip_id: activeFxId,
      },
    });
    await sendControlCommand({
      type: "ClearClip",
      data: { control_index: 5 },
    });

    await waitForCondition("control assignments did not apply", () => {
      const controls = stores.controls?.get?.() ?? [];
      const assignedId = (index: number) =>
        controls.find((control) => control.index === index)?.assigned_clip_id ??
        null;

      return (
        assignedId(1) === inactiveSequenceId &&
        assignedId(2) === activeSequenceId &&
        assignedId(3) === inactiveFxId &&
        assignedId(4) === activeFxId &&
        assignedId(5) === null
      );
    });

    (window as AppStoresWindow).__workerMessages = [];

    return {
      inactiveSequenceId,
      activeSequenceId,
      inactiveFxId,
      activeFxId,
    };
  });
}

/** Verifies control Go buttons issue Start, Go, or no command from owned state. */
test("each control has a go button with per-target start and go behavior", async ({
  backendSlot,
  page,
}) => {
  await openOwnedClipControlApp(page, backendSlot.backendPort);
  const scenario = await seedClipControlScenario(page);

  await openPanel(page, "Clips");

  const firstDropzone = page.locator('[data-clip-dropzone-index="1"]');
  const firstGoButton = page.locator('[data-control-go-index="1"]');
  const secondGoButton = page.locator('[data-control-go-index="2"]');
  const thirdGoButton = page.locator('[data-control-go-index="3"]');
  const fourthGoButton = page.locator('[data-control-go-index="4"]');
  const fifthGoButton = page.locator('[data-control-go-index="5"]');
  const secondSliderHandle = page
    .locator('[data-control-index="2"]')
    .locator(".vertical-range-slider .noUi-handle");

  await expect(firstGoButton).toBeVisible();
  await expect(firstGoButton).toBeEnabled();
  await expect(secondGoButton).toBeVisible();
  await expect(secondGoButton).toBeEnabled();
  await expect(thirdGoButton).toBeVisible();
  await expect(thirdGoButton).toBeEnabled();
  await expect(fourthGoButton).toBeVisible();
  await expect(fourthGoButton).toBeEnabled();
  await expect(fifthGoButton).toBeDisabled();
  await expect(secondSliderHandle).toBeVisible();

  const dropzoneBox = await firstDropzone.boundingBox();
  const goButtonBox = await firstGoButton.boundingBox();
  const secondHandleBox = await secondSliderHandle.boundingBox();
  const secondGoButtonBox = await secondGoButton.boundingBox();
  expect(dropzoneBox).not.toBeNull();
  expect(goButtonBox).not.toBeNull();
  expect(secondHandleBox).not.toBeNull();
  expect(secondGoButtonBox).not.toBeNull();
  expect(goButtonBox!.y).toBeGreaterThan(dropzoneBox!.y + dropzoneBox!.height);
  expect(secondHandleBox!.y + secondHandleBox!.height).toBeLessThan(
    secondGoButtonBox!.y,
  );

  await firstGoButton.click();
  await secondGoButton.click();
  await thirdGoButton.click();
  await fourthGoButton.click();

  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          type WindowWithWorkerMessages = Window & {
            __workerMessages?: unknown[];
          };
          type IdExpr = { type: "Single"; data: number };

          const messages = (window as WindowWithWorkerMessages)
            .__workerMessages;

          return (
            messages
              ?.flatMap((message) => {
                if (!message || typeof message !== "object") {
                  return [];
                }

                const candidate = message as {
                  type?: string;
                  data?: {
                    module?: string;
                    command?: { type?: string; data?: IdExpr };
                  };
                };

                if (
                  candidate.type !== "submit" ||
                  candidate.data?.module !== "ClipCommand" ||
                  !candidate.data.command?.type ||
                  candidate.data.command.data?.type !== "Single"
                ) {
                  return [];
                }

                return [
                  {
                    type: candidate.data.command.type,
                    id: candidate.data.command.data.data,
                  },
                ];
              })
              .filter(Boolean) ?? []
          );
        }),
      { timeout: 10_000 },
    )
    .toEqual([
      { type: "StartClip", id: scenario.inactiveSequenceId },
      { type: "GoClip", id: scenario.activeSequenceId },
      { type: "StartClip", id: scenario.inactiveFxId },
    ]);
});
