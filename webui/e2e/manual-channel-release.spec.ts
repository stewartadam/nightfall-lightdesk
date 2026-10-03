// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

const inputSelector = "#header-cmdline";

test.setTimeout(60_000);

type AppStoresWindow = Window & {
  appStores?: {
    bindings?: { get: () => BindingsSnapshot };
    layerStack?: { get: () => LayerState[] };
    dmxUniverseData?: { get: () => DmxUniverseState[] };
  };
};

type DmxUniverseState = {
  universe_id: number;
  io_mode: string;
  transport?: string | null;
  channels: number[];
};

type BindingsSnapshot = {
  output: OutputBinding[];
};

type OutputBinding = {
  source: { type: string };
  target: {
    type: string;
    data?: {
      universe?: { start: number; end: number };
      address?: number;
    };
  };
};

type LayerState = {
  creator: string;
  asserted_absolute_values?: unknown[];
  asserted_relative_values?: unknown[];
};

/** Opens a fresh backend showfile with no fixtures. */
async function openBlankApp(page: Page, backendPort: number): Promise<void> {
  await prepareFreshBackendShowfile(backendPort);
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("nightfall.currentShowfileName", "default");
  });
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await expect(page.locator(inputSelector)).toBeVisible();
  await waitForDockviewApp(page);
  await expect
    .poll(() =>
      page.evaluate(
        () => Object.keys((window as any).appStores.fixtures.get()).length,
      ),
    )
    .toBe(0);
}

/** Opens a blank backend containing one explicitly patched fixture. */
async function openOwnedManualChannelApp(
  page: Page,
  backendPort: number,
): Promise<void> {
  await openBlankApp(page, backendPort);
  await page.evaluate(async () => {
    const stores = (window as any).appStores;
    const fixtureId = Math.floor(600_000 + Math.random() * 100_000);
    const createResult = await stores.sendAndAwait({
      module: "FixtureLibraryCommand",
      command: {
        type: "CreateFixtureFromLibrary",
        data: {
          id: fixtureId,
          make: "Generic",
          model: "Moving Head RGBW",
          mode: "Spot",
          label: `Manual Channel Fixture ${fixtureId}`,
          update_existing_ids: [],
          update_existing_only: false,
        },
      },
    });
    if (createResult.outcome.type !== "Succeeded") {
      throw new Error(
        `failed to create manual channel fixture: ${JSON.stringify(createResult)}`,
      );
    }

    const patchResult = await stores.sendAndAwait({
      module: "FixtureCommand",
      command: {
        type: "UpdateFixturePatch",
        data: {
          id: fixtureId,
          universe: 42,
          address: 101,
          transport: {
            type: "ArtNet",
            data: { mode: { type: "Broadcast" } },
          },
        },
      },
    });
    if (patchResult.outcome.type !== "Succeeded") {
      throw new Error(
        `failed to patch manual channel fixture: ${JSON.stringify(patchResult)}`,
      );
    }
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => Object.keys((window as any).appStores.fixtures.get()).length,
      ),
    )
    .toBe(1);
}

/** Creates one RGB pixel tape fixture whose first channel is red. */
async function createPixelTapeFixture(page: Page, id: number) {
  await page.evaluate(async (fixtureId) => {
    const result = await (window as any).appStores.sendAndAwait({
      module: "FixtureLibraryCommand",
      command: {
        type: "CreateFixtureFromLibrary",
        data: {
          id: fixtureId,
          make: "Generic",
          model: "RGBPixelTape 120ch RGB",
          mode: "RGB",
          label: `Release Tape ${fixtureId}`,
          update_existing_ids: [],
          update_existing_only: false,
        },
      },
    });
    if (result.outcome.type !== "Succeeded") {
      throw new Error(`fixture setup failed: ${JSON.stringify(result)}`);
    }
  }, id);
}

/**
 * Submits a command-line command through the UI and waits for completion.
 */
async function submitCommand(page: Page, command: string) {
  const input = page.locator(inputSelector);
  await input.fill(command);
  await input.press("Enter");
  await expect(input).toHaveValue("");
}

/**
 * Waits until the manual layer contains the expected number of assertions.
 */
async function waitForManualLayerAssertionCount(page: Page, count: number) {
  await expect
    .poll(async () => {
      return page.evaluate(() => {
        const stores = (window as AppStoresWindow).appStores;
        const layer = stores?.layerStack
          ?.get()
          .find((entry) => entry.creator === "Manual Channel Assertions");

        if (!layer) {
          return -1;
        }

        const absoluteCount = layer.asserted_absolute_values?.length ?? 0;
        const relativeCount = layer.asserted_relative_values?.length ?? 0;
        return absoluteCount + relativeCount;
      });
    })
    .toBe(count);
}

/**
 * Reads the first fixture output channel from app stores for release assertions.
 */
async function firstFixtureOutputChannel(page: Page) {
  return page.evaluate(() => {
    const bindings = (window as AppStoresWindow).appStores?.bindings?.get();
    const binding = bindings?.output.find((entry) => {
      const target = entry.target.data;
      return (
        entry.source.type === "Fixture" &&
        target !== undefined &&
        target.address !== undefined
      );
    });

    if (!binding?.target.data || binding.target.data.address === undefined) {
      throw new Error(
        "expected a fixture output binding with universe/address",
      );
    }

    return {
      universe: binding.target.data.universe?.start ?? 1,
      address: binding.target.data.address,
    };
  });
}

/** Labels the engine reports for console space and for routed sACN wire output. */
type OutputSpace = "Console" | "sACN";

/**
 * Reads one output universe from app stores, or `null` while the engine is not outputting it.
 */
async function outputUniverse(
  page: Page,
  space: OutputSpace,
  universe: number,
) {
  return page.evaluate(
    ([label, universeId]) => {
      const data =
        (window as AppStoresWindow).appStores?.dmxUniverseData?.get() ?? [];
      const entry = data.find(
        (candidate) =>
          candidate.io_mode === "output" &&
          candidate.transport === label &&
          candidate.universe_id === universeId,
      );
      return entry ? entry.channels : null;
    },
    [space, universe] as const,
  );
}

/** Polls one output slot until it reports the expected value. */
async function expectSlotValue(
  page: Page,
  space: OutputSpace,
  universe: number,
  address: number,
  value: number,
) {
  await expect
    .poll(
      async () => (await outputUniverse(page, space, universe))?.[address - 1],
    )
    .toBe(value);
}

test("global release clears manual channel assertion layer", async ({
  backendSlot,
  page,
}) => {
  await openOwnedManualChannelApp(page, backendSlot.backendPort);

  await page.waitForFunction(() => {
    const stores = (window as AppStoresWindow).appStores;
    return (
      typeof stores?.bindings?.get === "function" &&
      typeof stores.layerStack?.get === "function"
    );
  });
  await expect
    .poll(async () => {
      return page.evaluate(() => {
        return (window as AppStoresWindow).appStores?.bindings?.get().output
          .length;
      });
    })
    .toBeGreaterThan(0);

  const channel = await firstFixtureOutputChannel(page);

  await submitCommand(page, `ch ${channel.universe}.${channel.address} @ 10`);
  await waitForManualLayerAssertionCount(page, 1);

  await submitCommand(page, "release");
  await waitForManualLayerAssertionCount(page, 0);
});

/**
 * `fix 310 red @ 100; ch 2.1 @ 50; release ch 2.1` returns the routed console slot to the
 * fixture's full output, and undo re-applies the manual value on console and wire.
 */
test("release channel resumes fixture output and undo restores the manual value", async ({
  backendSlot,
  page,
}) => {
  await openBlankApp(page, backendSlot.backendPort);
  await createPixelTapeFixture(page, 310);
  await submitCommand(page, "patch fix 310 @ console:2");
  await submitCommand(page, "patch console:2 @ sacn:10");
  await submitCommand(page, "fix 310 red @ 100");

  /** Expects console slot 2.1 and its routed wire slot sACN 10.1 to read `value`. */
  const expectRed = async (value: number) => {
    await expectSlotValue(page, "Console", 2, 1, value);
    await expectSlotValue(page, "sACN", 10, 1, value);
  };
  await expectRed(255);

  await submitCommand(page, "ch 2.1 @ 50");
  await expectRed(50);

  await submitCommand(page, "release ch 2.1");
  await expectRed(255);
  await waitForManualLayerAssertionCount(page, 0);

  await submitCommand(page, "undo");
  await expectRed(50);
});

/**
 * Releasing the only manual write on a routed console universe frees it, so the route stops
 * transmitting, and undo brings the value back on the wire.
 */
test("release channel stops a routed console universe nothing feeds and undo restores it", async ({
  backendSlot,
  page,
}) => {
  await openBlankApp(page, backendSlot.backendPort);
  await submitCommand(page, "patch console:7 @ sacn:17");

  await submitCommand(page, "ch 7.1 @ 50");
  await expectSlotValue(page, "Console", 7, 1, 50);
  await expectSlotValue(page, "sACN", 17, 1, 50);

  await submitCommand(page, "release ch 7.1");
  await expect.poll(() => outputUniverse(page, "Console", 7)).toBeNull();
  await expect.poll(() => outputUniverse(page, "sACN", 17)).toBeNull();

  await submitCommand(page, "undo");
  await expectSlotValue(page, "Console", 7, 1, 50);
  await expectSlotValue(page, "sACN", 17, 1, 50);
});
