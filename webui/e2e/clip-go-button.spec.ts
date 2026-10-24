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

type FaderSnapshot = {
  index: number;
  assigned_clip_id: number | null;
};

type ClipFaderScenario = {
  inactiveSequenceId: number;
  activeSequenceId: number;
  inactiveFxId: number;
  activeFxId: number;
};

/** Opens the fader scenario against a blank backend and instruments worker commands. */
async function openOwnedClipFaderApp(
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
      Boolean((window as any).appStores?.faders?.get) &&
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
 * Seeds live faders with known active and inactive sequence/fx assignments.
 */
async function seedClipFaderScenario(page: Page): Promise<ClipFaderScenario> {
  return page.evaluate(async () => {
    type AppStoresWindow = Window & {
      __workerMessages?: unknown[];
      appStores?: {
        clips?: {
          get: () => Record<string, [{ identifiers: { id: number } }, boolean]>;
        };
        faders?: { get: () => FaderSnapshot[] };
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
      !stores.faders
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
          `failed to store fader data: ${JSON.stringify(result)}`,
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
            label: "Clip Fader Cue",
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
            label: "Clip Fader Sequence",
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
            label: "Clip Fader FX",
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
        label: "Inactive Sequence Fader",
        source: { type: "Sequence", data: sequenceUid },
      },
      {
        id: activeSequenceId,
        label: "Active Sequence Fader",
        source: { type: "Sequence", data: sequenceUid },
      },
      {
        id: inactiveFxId,
        label: "Inactive FX Fader",
        source: { type: "Fx", data: fxUid },
      },
      {
        id: activeFxId,
        label: "Active FX Fader",
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

    /** Sends a fader command through the same websocket path used by the UI. */
    const sendFaderCommand = (command: object) =>
      stores.send?.({ module: "FaderCommand", command });

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

    await sendFaderCommand({
      type: "AssignClip",
      data: {
        fader_index: 1,
        clip_id: inactiveSequenceId,
      },
    });
    await sendFaderCommand({
      type: "AssignClip",
      data: {
        fader_index: 2,
        clip_id: activeSequenceId,
      },
    });
    await sendFaderCommand({
      type: "AssignClip",
      data: {
        fader_index: 3,
        clip_id: inactiveFxId,
      },
    });
    await sendFaderCommand({
      type: "AssignClip",
      data: {
        fader_index: 4,
        clip_id: activeFxId,
      },
    });
    await sendFaderCommand({
      type: "ClearClip",
      data: { fader_index: 5 },
    });

    await waitForCondition("fader assignments did not apply", () => {
      const faders = stores.faders?.get?.() ?? [];
      const assignedId = (index: number) =>
        faders.find((fader) => fader.index === index)?.assigned_clip_id ?? null;

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

/** Verifies fader buttons in the default Go mode issue Start, Go, or no command from owned state. */
test("each fader has a go button with per-target start and go behavior", async ({
  backendSlot,
  page,
}) => {
  await openOwnedClipFaderApp(page, backendSlot.backendPort);
  const scenario = await seedClipFaderScenario(page);

  await openPanel(page, "Clips");

  const firstDropzone = page.locator('[data-clip-dropzone-index="1"]');
  const firstGoButton = page.locator('[data-fader-button-index="1"]');
  const secondGoButton = page.locator('[data-fader-button-index="2"]');
  const thirdGoButton = page.locator('[data-fader-button-index="3"]');
  const fourthGoButton = page.locator('[data-fader-button-index="4"]');
  const fifthGoButton = page.locator('[data-fader-button-index="5"]');
  const secondSliderHandle = page
    .locator('[data-fader-index="2"]')
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
          const messages = (window as WindowWithWorkerMessages)
            .__workerMessages;

          return (
            messages?.flatMap((message) => {
              const candidate = message as {
                data?: {
                  module?: string;
                  command?: {
                    type?: string;
                    data?: { fader_index?: number };
                  };
                };
              } | null;
              if (
                candidate?.data?.module !== "FaderCommand" ||
                candidate.data.command?.type !== "PressButton"
              ) {
                return [];
              }
              return [candidate.data.command.data?.fader_index];
            }) ?? []
          );
        }),
      { timeout: 10_000 },
    )
    .toEqual([1, 2, 3, 4]);

  // The backend decides what Go does: inactive clips start and running clips keep running.
  await expect
    .poll(
      async () =>
        page.evaluate(
          (ids) => {
            const states = (window as any).appStores.clips.get() as Record<
              string,
              [{ identifiers: { id: number } }, boolean]
            >;
            const active = new Set(
              Object.values(states)
                .filter(([, isActive]) => isActive)
                .map(([clip]) => clip.identifiers.id),
            );
            return ids.map((id) => active.has(id));
          },
          [
            scenario.inactiveSequenceId,
            scenario.activeSequenceId,
            scenario.inactiveFxId,
            scenario.activeFxId,
          ],
        ),
      { timeout: 10_000 },
    )
    .toEqual([true, true, true, true]);
});

/** Returns whether the clip with `id` is running according to the clip store. */
async function isClipRunning(page: Page, id: number): Promise<boolean> {
  return page.evaluate((id) => {
    const states = (window as any).appStores.clips.get() as Record<
      string,
      [{ identifiers: { id: number } }, boolean]
    >;
    return Object.values(states).some(
      ([clip, isActive]) => clip.identifiers.id === id && isActive,
    );
  }, id);
}

/** Picks a button mode for a fader from its mode menu. */
async function pickButtonMode(
  page: Page,
  faderIndex: number,
  mode: string,
): Promise<void> {
  await page
    .getByRole("button", { name: `Button mode of fader ${faderIndex}` })
    .click();
  await page.locator(`[data-fader-button-mode-option="${mode}"]`).click();
  await expect(
    page.locator(`[data-fader-button-index="${faderIndex}"]`),
  ).toHaveAttribute("data-fader-button-mode", mode);
}

/**
 * Verifies the mode menu changes what the fader's button does: Toggle starts and then stops
 * an effect clip, Release stops a running one, and the backend's fader snapshot reports
 * each fader's chosen mode.
 */
test("a fader's button mode decides what its button does", async ({
  backendSlot,
  page,
}) => {
  await openOwnedClipFaderApp(page, backendSlot.backendPort);
  const scenario = await seedClipFaderScenario(page);
  await openPanel(page, "Clips");

  const thirdButton = page.locator('[data-fader-button-index="3"]');
  const fourthButton = page.locator('[data-fader-button-index="4"]');
  await expect(thirdButton).toHaveText("Go");

  await page.getByRole("button", { name: "Button mode of fader 3" }).click();
  await expect(
    page.locator('[data-menu-kind="fader-button-mode"]'),
  ).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("fader-button-mode-menu.png"),
  });
  await page.locator('[data-fader-button-mode-option="Toggle"]').click();
  await expect(thirdButton).toHaveText("Toggle");

  await thirdButton.click();
  await expect
    .poll(() => isClipRunning(page, scenario.inactiveFxId))
    .toBe(true);
  await thirdButton.click();
  await expect
    .poll(() => isClipRunning(page, scenario.inactiveFxId))
    .toBe(false);

  await pickButtonMode(page, 4, "Release");
  await expect(fourthButton).toHaveText("Release");
  await fourthButton.click();
  await expect.poll(() => isClipRunning(page, scenario.activeFxId)).toBe(false);

  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).appStores.faders
          .get()
          .slice(0, 4)
          .map((fader: { button_mode: string }) => fader.button_mode),
      ),
    )
    .toEqual(["Go", "Go", "Toggle", "Release"]);
  await page.locator(".faders").screenshot({
    path: test.info().outputPath("fader-button-modes.png"),
  });
});

/** Reads the level shown by a fader's slider handle. */
async function faderLevel(page: Page, faderIndex: number): Promise<number> {
  const value = await page
    .locator(`[data-fader-index="${faderIndex}"]`)
    .locator(".vertical-range-slider .noUi-handle")
    .getAttribute("aria-valuenow");
  return Number(value);
}

/**
 * Verifies two faders assigned to the same idle clip keep showing the same level: raising one
 * starts the clip and raises the other, pulling either to zero releases it for both, and
 * raising one again brings the other back up with it.
 */
test("faders sharing a clip move together", async ({ backendSlot, page }) => {
  await openOwnedClipFaderApp(page, backendSlot.backendPort);
  const scenario = await seedClipFaderScenario(page);
  const clipId = scenario.inactiveFxId;
  await page.evaluate(
    (clipId) =>
      (window as any).appStores.sendAndAwait({
        module: "FaderCommand",
        command: {
          type: "AssignClip",
          data: { fader_index: 5, clip_id: clipId },
        },
      }),
    clipId,
  );
  await openPanel(page, "Clips");

  const handle = (faderIndex: number) =>
    page
      .locator(`[data-fader-index="${faderIndex}"]`)
      .locator(".vertical-range-slider .noUi-handle");
  /** Raises a fader from zero so its clip starts at a level above one percent. */
  const raise = async (faderIndex: number) => {
    await handle(faderIndex).press("ArrowUp");
    await expect.poll(() => isClipRunning(page, clipId)).toBe(true);
    await handle(faderIndex).press("PageUp");
    await expect.poll(() => faderLevel(page, faderIndex)).toBeGreaterThan(1);
  };
  /** Waits until both faders show the same level and returns it. */
  const sharedLevel = async () => {
    await expect
      .poll(
        async () => (await faderLevel(page, 3)) === (await faderLevel(page, 5)),
      )
      .toBe(true);
    return faderLevel(page, 3);
  };
  await expect(handle(5)).toBeVisible();

  await raise(3);
  expect(await sharedLevel()).toBeGreaterThan(1);

  await handle(5).press("Home");
  await expect.poll(() => isClipRunning(page, clipId)).toBe(false);
  expect(await sharedLevel()).toBe(0);

  await raise(3);
  expect(await sharedLevel()).toBeGreaterThan(1);
  // Neither fader has a physical fader, so neither shows a hardware position marker.
  for (const faderIndex of [3, 5]) {
    await expect(
      page
        .locator(`[data-fader-index="${faderIndex}"]`)
        .locator(".vertical-slider-value-marker"),
    ).toHaveCount(0);
  }
  await page.locator(".faders").screenshot({
    path: test.info().outputPath("fader-shared-clip-sync.png"),
  });
});

/**
 * Verifies a Flash button runs an idle clip only while held: pressing starts the clip and
 * lights the button, and letting go stops the clip it started and unlights the button.
 */
test("a Flash button plays its clip only while held", async ({
  backendSlot,
  page,
}) => {
  await openOwnedClipFaderApp(page, backendSlot.backendPort);
  const scenario = await seedClipFaderScenario(page);
  await openPanel(page, "Clips");

  const button = page.locator('[data-fader-button-index="3"]');
  await pickButtonMode(page, 3, "Flash");
  await expect(button).toHaveText("Flash");
  await expect(button).toHaveAttribute("data-fader-button-flashing", "false");
  await page.locator(".faders").screenshot({
    path: test.info().outputPath("fader-flash-idle.png"),
  });

  const box = await button.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await expect(button).toHaveAttribute("data-fader-button-flashing", "true");
  await expect
    .poll(() => isClipRunning(page, scenario.inactiveFxId))
    .toBe(true);
  await page.locator(".faders").screenshot({
    path: test.info().outputPath("fader-flash-held.png"),
  });

  await page.mouse.up();
  await expect(button).toHaveAttribute("data-fader-button-flashing", "false");
  await expect
    .poll(() => isClipRunning(page, scenario.inactiveFxId))
    .toBe(false);
});
