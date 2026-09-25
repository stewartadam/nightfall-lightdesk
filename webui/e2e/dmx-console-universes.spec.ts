// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import {
  frontendOnlyTest as demoTest,
  expect,
  type Locator,
  type Page,
  test,
} from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

test.setTimeout(90_000);

const PANEL_ID = "panel-DmxConsoleUniverses-e2e";

/** Output universe summary read from the live DMX universe store. */
interface OutputUniverseSummary {
  transport: string | undefined;
  universeId: number;
  channels: number[];
}

/** Submits one operator command through the header command line and waits for its result. */
async function runCommandLine(page: Page, command: string): Promise<void> {
  const result = await page.evaluate(async (commandText) => {
    const stores = (window as any).appStores;
    const input = document.querySelector<HTMLInputElement>("#header-cmdline");
    if (!input?.form) throw new Error("header command line was unavailable");
    input.value = commandText;
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    const initialLength = stores.consoleScrollback.get().length;

    return new Promise<{ status: string; entry: unknown }>(
      (resolve, reject) => {
        const timeout = window.setTimeout(() => {
          unsubscribe();
          reject(new Error(`command timed out: ${commandText}`));
        }, 10_000);
        const unsubscribe = stores.consoleScrollback.subscribe(
          (entries: Array<{ status: string }>) => {
            if (entries.length <= initialLength) return;
            const latest = entries.at(-1);
            if (!latest || latest.status === "pending") return;
            window.clearTimeout(timeout);
            unsubscribe();
            resolve({ status: latest.status, entry: latest });
          },
        );
        input.form?.requestSubmit();
      },
    );
  }, command);
  expect(result.status, JSON.stringify(result.entry)).toBe("success");
}

/** Creates RGB pixel tape fixtures through the fixture library command. */
async function createPixelTapeFixtures(page: Page, ids: number[]) {
  await page.evaluate(async (fixtureIds) => {
    const stores = (window as any).appStores;
    for (const id of fixtureIds) {
      const result = await stores.sendAndAwait({
        module: "FixtureLibraryCommand",
        command: {
          type: "CreateFixtureFromLibrary",
          data: {
            id,
            make: "Generic",
            model: "RGBPixelTape 120ch RGB",
            mode: "RGB",
            label: `Console Tape ${id}`,
            update_existing_ids: [],
            update_existing_only: false,
          },
        },
      });
      if (result.outcome.type !== "Succeeded") {
        throw new Error(`fixture setup failed: ${JSON.stringify(result)}`);
      }
    }
  }, ids);
  await expect
    .poll(() =>
      page.evaluate(
        () => Object.keys((window as any).appStores.fixtures.get()).length,
      ),
    )
    .toBe(ids.length);
}

/** Opens an isolated DMX universe panel in the main dock grid. */
async function openDmxUniversePanel(page: Page): Promise<Locator> {
  await page.evaluate((panelId) => {
    const api = (window as any).appStores.dockApi.get();
    api.getPanel(panelId)?.api.close();
    const referencePanel = api.panels.find(
      (candidate: any) => candidate.api.location.type === "grid",
    );
    const panel = api.addPanel({
      id: panelId,
      component: "DmxUniverse",
      title: "Console DMX",
      params: {},
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
  }, PANEL_ID);
  const panel = page.locator(
    `[data-component="DmxUniverse"][data-panel-id="${PANEL_ID}"]:visible`,
  );
  await expect(panel).toBeVisible();
  return panel;
}

/** Reads output universe views reported by the engine. */
async function outputUniverses(page: Page): Promise<OutputUniverseSummary[]> {
  return page.evaluate(() =>
    ((window as any).appStores.dmxUniverseData.get() as any[])
      .filter((universe) => universe.io_mode === "output")
      .map((universe) => ({
        transport: universe.transport,
        universeId: universe.universe_id,
        channels: universe.channels,
      })),
  );
}

/** Returns the channel values of one reported output universe view. */
async function outputChannels(
  page: Page,
  transport: string,
  universeId: number,
): Promise<number[] | undefined> {
  return (await outputUniverses(page)).find(
    (universe) =>
      universe.transport === transport && universe.universeId === universeId,
  )?.channels;
}

/** Locates the universe tab list within the panel. */
function universeTabs(panel: Locator): Locator {
  return panel.getByRole("tablist", { name: "DMX universes" });
}

/** Locates one rendered channel tile within the panel. */
function channelTile(panel: Locator, address: number): Locator {
  return panel.locator(`[data-dmx-channel-address="${address}"]`).first();
}

/** Locates one rendered channel value within the panel. */
function channelValue(panel: Locator, address: number): Locator {
  return panel.locator(`[data-dmx-channel-value="${address}"]`).first();
}

/** Returns the option labels offered by the Transport select. */
async function transportOptions(panel: Locator): Promise<string[]> {
  return panel
    .getByLabel("Transport")
    .locator("option")
    .evaluateAll((options) =>
      options.map((option) => (option as HTMLOptionElement).value),
    );
}

/**
 * Fixtures bound only to console addresses show under Console with console numbering;
 * adding a console→sACN route adds an sACN view with wire numbering and identical values.
 */
test("console DMX panel reports console-space and remapped wire universes", async ({
  page,
  backendSlot,
}, testInfo) => {
  await prepareFreshBackendShowfile(backendSlot.backendPort);
  await page.addInitScript(() => {
    window.localStorage.removeItem("nightfall.currentShowfileName");
    window.localStorage.removeItem("nightfall.e2eAutoOpenStartupShowfile");
  });
  await page.goto("/?e2e=1&startup:draftRecovery=false");
  await waitForDockviewApp(page, { timeoutMs: 60_000 });
  await createPixelTapeFixtures(page, [310, 311]);

  await runCommandLine(page, "patch fix 310>311 @ console:2");
  await runCommandLine(page, "fix 310>311 red @ 100 green @ 0 blue @ 0");

  const panel = await openDmxUniversePanel(page);
  await expect(panel.getByLabel("Transport")).toHaveValue("Console");
  expect(await transportOptions(panel)).toEqual(["Console"]);
  await expect(
    universeTabs(panel).getByRole("tab", { name: "Univ. 2", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(channelValue(panel, 1)).toHaveText("255");
  await expect(channelValue(panel, 2)).toHaveText("0");
  await expect(channelValue(panel, 121)).toHaveText("255");
  await expect(channelTile(panel, 1)).toContainText("#310.1");
  await expect(channelTile(panel, 121)).toContainText("#311.1");
  await panel.screenshot({ path: testInfo.outputPath("console-only.png") });

  await runCommandLine(page, "patch console:2 @ sacn:10");
  await expect
    .poll(async () => transportOptions(panel))
    .toEqual(["Console", "sACN"]);
  await expect(panel.getByLabel("Transport")).toHaveValue("Console");
  await expect(universeTabs(panel).getByRole("tab")).toHaveText(["Univ. 2"]);
  await expect(channelTile(panel, 121)).toContainText("#311.1");
  await panel.screenshot({ path: testInfo.outputPath("console-routed.png") });

  await panel.getByLabel("Transport").selectOption("sACN");
  await expect(universeTabs(panel).getByRole("tab")).toHaveText(["Univ. 10"]);
  await expect(channelValue(panel, 1)).toHaveText("255");
  await expect(channelValue(panel, 121)).toHaveText("255");
  await expect(channelTile(panel, 1)).toContainText("#310.1");
  await expect(channelTile(panel, 121)).toContainText("#311.1");
  await panel.screenshot({ path: testInfo.outputPath("sacn-wire.png") });

  const consoleChannels = await outputChannels(page, "Console", 2);
  expect(consoleChannels?.slice(0, 240)).toEqual(
    (await outputChannels(page, "sACN", 10))?.slice(0, 240),
  );
});

/** The embedded browser demo engine reports console-space universes the same way. */
demoTest(
  "embedded demo reports console-space and remapped wire universes",
  async ({ page }, testInfo) => {
    await page.goto("/?engine=embedded-demo&startup:draftRecovery=false&e2e=1");
    await waitForDockviewApp(page);

    await runCommandLine(page, "patch fix 1>2 @ console:2");
    await runCommandLine(page, "fix 1>2 @ 100");

    const panel = await openDmxUniversePanel(page);
    await expect(panel.getByLabel("Transport")).toHaveValue("Console");
    await expect(universeTabs(panel).getByRole("tab")).toHaveText(["Univ. 2"]);
    await expect(channelTile(panel, 1)).toContainText("#1");
    await panel.screenshot({ path: testInfo.outputPath("demo-console.png") });

    await runCommandLine(page, "patch console:2 @ sacn:10");
    await expect
      .poll(async () => transportOptions(panel))
      .toEqual(["Console", "sACN"]);
    await panel.getByLabel("Transport").selectOption("sACN");
    await expect(universeTabs(panel).getByRole("tab")).toHaveText(["Univ. 10"]);
    await expect(channelTile(panel, 1)).toContainText("#1");
    await panel.screenshot({ path: testInfo.outputPath("demo-sacn.png") });

    await expect
      .poll(async () => {
        const consoleChannels = await outputChannels(page, "Console", 2);
        const wireChannels = await outputChannels(page, "sACN", 10);
        return (
          consoleChannels?.some((value) => value > 0) === true &&
          JSON.stringify(consoleChannels) === JSON.stringify(wireChannels)
        );
      })
      .toBe(true);
  },
);
