// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, type Page, test } from "./playwright-fixtures";

import { waitForDockviewApp } from "./showfile-startup";

const FIXTURE_UID = "44444444444444444444444444444444";
const JUMP_FIXTURE_UID = "55555555555555555555555555555555";
const ATTRIBUTE_FIXTURE_UID = "66666666666666666666666666666666";

/** Waits until app stores and Dockview are available for isolated panel tests. */
async function waitForAppStores(page: Page) {
  await waitForDockviewApp(page);
}

/** Disconnects the backend websocket so seeded store values remain deterministic. */
async function disconnectBackend(page: Page) {
  await page.evaluate(async () => {
    const websocketModule = await import("/lib/engine-runtime.ts");
    websocketModule.engineRuntime.stop();
  });
}

/** Seeds a DMX universe with default, manual, asserted, transitioning, and input-driven channels. */
async function seedDmxUniverseColorState(page: Page) {
  await page.evaluate((fixtureUid) => {
    const stores = (window as any).appStores;

    /** Builds coarse parameter metadata for one DMX channel. */
    const parameter = (attribute: string) => ({
      resolution: "Coarse",
      attribute: { type: attribute },
      min: 0,
      max: 255,
      offset: { type: "Absolute", data: { value: 0 } },
      is_inverted: false,
      is_snap: false,
      merge_type: "LTP",
      use_grandmaster: true,
    });

    stores.fixtures.set({
      [fixtureUid]: {
        identifiers: { id: 701, uid: fixtureUid, label: "Fixture 701" },
        make: "E2E",
        model: "DMX Color Fixture",
        mode: "Color",
        elements: [
          {
            label: "Body",
            parameters: [
              parameter("Intensity"),
              parameter("Red"),
              parameter("Green"),
              parameter("Blue"),
            ],
          },
        ],
      },
    });

    stores.bindings.set({
      input: [],
      output: [
        {
          source: { type: "Fixture", data: { uids: [fixtureUid] } },
          target: {
            type: "Transport",
            data: {
              target: "sacn",
              universe: { start: 1, end: 1 },
              address: 1,
            },
          },
          priority: 0,
          clone: false,
        },
      ],
      disabled: [],
    });

    stores.layerStack.set([
      {
        creator: "Manual Channel Assertions",
        object_ref: {
          type: "ById",
          data: { object_type: "Parameter", id: 1 },
        },
        priority: -127,
        asserted_absolute_values: [
          {
            fixture_uid: fixtureUid,
            parameters: [
              {
                Intensity: { type: "Absolute", data: { value: 64 } },
              },
            ],
          },
        ],
        asserted_relative_values: [],
        computed_values: [
          { fixture_uid: fixtureUid, parameters: [{ Intensity: 64 }] },
        ],
        computed_transitioning: [],
      },
      {
        creator: "Transport Input",
        object_ref: {
          type: "ById",
          data: { object_type: "Parameter", id: 0 },
        },
        priority: -128,
        asserted_absolute_values: [
          {
            fixture_uid: fixtureUid,
            parameters: [
              {
                Blue: { type: "Absolute", data: { value: 42 } },
              },
            ],
          },
        ],
        asserted_relative_values: [],
        computed_values: [
          { fixture_uid: fixtureUid, parameters: [{ Blue: 42 }] },
        ],
        computed_transitioning: [],
      },
      {
        creator: "Cue 1",
        priority: 10,
        asserted_absolute_values: [
          {
            fixture_uid: fixtureUid,
            parameters: [
              {
                Red: { type: "Absolute", data: { value: 96 } },
                Green: { type: "Absolute", data: { value: 128 } },
              },
            ],
          },
        ],
        asserted_relative_values: [],
        computed_values: [
          {
            fixture_uid: fixtureUid,
            parameters: [{ Red: 96, Green: 128 }],
          },
        ],
        computed_transitioning: [
          {
            fixture_uid: fixtureUid,
            parameters: [{ Green: true }],
          },
        ],
      },
    ]);

    const channels = Array.from({ length: 512 }, () => 0);
    channels[0] = 64;
    channels[1] = 96;
    channels[2] = 128;
    channels[3] = 42;
    stores.dmxUniverseData.set([
      {
        universe_id: 1,
        channels,
        transports: ["sACN"],
        io_mode: "output",
      },
    ]);
  }, FIXTURE_UID);
}

/** Seeds output universes with a fixture patched far enough down to require jump scrolling. */
async function seedDmxUniverseJumpState(page: Page) {
  await page.evaluate(
    ({ attributeFixtureUid, fixtureUid, jumpFixtureUid }) => {
      const stores = (window as any).appStores;

      /** Builds one coarse parameter for jump target fixtures. */
      const parameter = (attribute: unknown) => ({
        resolution: "Coarse",
        attribute,
        min: 0,
        max: 255,
        offset: { type: "Absolute", data: { value: 0 } },
        is_inverted: false,
        is_snap: false,
        merge_type: "LTP",
        use_grandmaster: true,
      });

      stores.fixtures.set({
        [fixtureUid]: {
          identifiers: { id: 701, uid: fixtureUid, label: "Fixture 701" },
          make: "E2E",
          model: "DMX Jump Fixture",
          mode: "Dimmer",
          elements: [
            {
              label: "Body",
              parameters: [parameter({ type: "Intensity" })],
            },
          ],
        },
        [jumpFixtureUid]: {
          identifiers: {
            id: 601,
            uid: jumpFixtureUid,
            label: "Fixture 601",
          },
          make: "E2E",
          model: "DMX Multi Element Fixture",
          mode: "Cells",
          elements: Array.from({ length: 5 }, (_, index) => ({
            label: `Cell ${index + 1}`,
            parameters: [
              parameter({ type: "Intensity" }),
              parameter({ type: "Tilt" }),
              parameter({
                type: "Custom",
                data: { label: "Color Wheel" },
              }),
            ],
          })),
        },
        [attributeFixtureUid]: {
          identifiers: {
            id: 14,
            uid: attributeFixtureUid,
            label: "Fixture 14",
          },
          make: "E2E",
          model: "DMX Tilt Fixture",
          mode: "Tilt",
          elements: [
            {
              label: "Head",
              parameters: [
                parameter({ type: "Intensity" }),
                parameter({ type: "Tilt" }),
              ],
            },
          ],
        },
      });

      stores.bindings.set({
        input: [],
        output: [
          {
            source: { type: "Fixture", data: { uids: [fixtureUid] } },
            target: {
              type: "Transport",
              data: {
                target: "sacn",
                universe: { start: 1, end: 1 },
                address: 1,
              },
            },
            priority: 0,
            clone: false,
          },
          {
            source: {
              type: "Fixture",
              data: { uids: [attributeFixtureUid] },
            },
            target: {
              type: "Transport",
              data: {
                target: "sacn",
                universe: { start: 1, end: 1 },
                address: 20,
              },
            },
            priority: 0,
            clone: false,
          },
          {
            source: { type: "Fixture", data: { uids: [jumpFixtureUid] } },
            target: {
              type: "Transport",
              data: {
                target: "sacn",
                universe: { start: 2, end: 2 },
                address: 500,
              },
            },
            priority: 0,
            clone: false,
          },
        ],
        disabled: [],
      });

      const universeOneChannels = Array.from({ length: 512 }, () => 0);
      const universeTwoChannels = Array.from({ length: 512 }, () => 0);
      universeOneChannels[0] = 7;
      universeOneChannels[20] = 21;
      universeTwoChannels[499] = 60;
      universeTwoChannels[510] = 64;
      universeTwoChannels[511] = 65;
      stores.dmxUniverseData.set([
        {
          universe_id: 1,
          channels: universeOneChannels,
          transports: ["sACN"],
          io_mode: "output",
        },
        {
          universe_id: 2,
          channels: universeTwoChannels,
          transports: ["sACN"],
          io_mode: "output",
        },
      ]);
    },
    {
      attributeFixtureUid: ATTRIBUTE_FIXTURE_UID,
      fixtureUid: FIXTURE_UID,
      jumpFixtureUid: JUMP_FIXTURE_UID,
    },
  );
}

/** Opens an isolated Console DMX panel for channel color assertions. */
async function openDmxUniversePanel(page: Page) {
  await page.evaluate(() => {
    const stores = (window as any).appStores;
    const api = stores.dockApi.get();
    api.getPanel("panel-DmxUniverseColors-e2e")?.api.close();
    const referencePanel =
      (api.activePanel?.api.location.type === "grid"
        ? api.activePanel
        : undefined) ??
      api.panels.find(
        (candidate: any) => candidate.api.location.type === "grid",
      ) ??
      api.getPanel("panel-FixtureGrid");
    const panel = api.addPanel({
      id: "panel-DmxUniverseColors-e2e",
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
    panel.focus();
  });
  await expect(dmxUniversePanel(page)).toBeVisible();
}

/** Locates the visible isolated DMX universe panel. */
function dmxUniversePanel(page: Page) {
  return page.locator(
    '[data-component="DmxUniverse"][data-panel-id="panel-DmxUniverseColors-e2e"]:visible',
  );
}

/** Locates the rendered channel value in the DMX universe panel. */
function channelValue(page: Page, address: number) {
  return dmxUniversePanel(page)
    .locator(`[data-dmx-channel-value="${address}"]`)
    .first();
}

/** Locates the rendered channel tile in the DMX universe panel. */
function channelTile(page: Page, address: number) {
  return dmxUniversePanel(page)
    .locator(`[data-dmx-channel-address="${address}"]`)
    .first();
}

/** Locates the Dockview tab hosting the isolated Console DMX panel. */
function consoleDmxTab(page: Page) {
  return page.getByRole("tab", { name: /Console DMX/ }).first();
}

/** Keeps universe labels inside their buttons when the panel must scroll horizontally. */
test("dmx universe buttons keep single-line labels in narrow panels", async ({
  page,
}, testInfo) => {
  await page.goto("/?e2e=1");
  await waitForAppStores(page);
  await disconnectBackend(page);
  await seedDmxUniverseColorState(page);
  await page.evaluate(() => {
    const stores = (window as any).appStores;
    const universe = stores.dmxUniverseData.get()[0];
    stores.dmxUniverseData.set(
      Array.from({ length: 16 }, (_, id) => ({ ...universe, universe_id: id })),
    );
  });
  await openDmxUniversePanel(page);
  const panel = dmxUniversePanel(page);
  await panel.evaluate((element) => {
    element.style.width = "450px";
  });
  const universes = panel.getByRole("tablist", { name: "DMX universes" });
  await expect(universes.getByRole("tab")).toHaveCount(16);
  const geometry = await universes.getByRole("tab").evaluateAll((buttons) =>
    buttons.map((button) => {
      const label = button.querySelector("span")!;
      const bounds = button.getBoundingClientRect();
      const text = label.getBoundingClientRect();
      return {
        height: bounds.height,
        textHeight: text.height,
        contained: text.top >= bounds.top && text.bottom <= bounds.bottom,
      };
    }),
  );
  for (const button of geometry) {
    expect(button.height).toBeLessThanOrEqual(30);
    expect(button.textHeight).toBeLessThan(30);
    expect(button.contained).toBe(true);
  }
  expect(
    await universes.evaluate(
      (element) => element.scrollWidth > element.clientWidth,
    ),
  ).toBe(true);
  await panel.screenshot({
    path: testInfo.outputPath("dmx-universe-buttons.png"),
  });
  await universes.getByRole("tab", { name: "Univ. 15", exact: true }).click();
  await expect(
    universes.getByRole("tab", { name: "Univ. 15", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
});

test("dmx universe panel uses fixture value-state color convention", async ({
  page,
}) => {
  await page.goto("/?e2e=1");
  await expect(page.locator("main#app")).toBeVisible();
  await waitForAppStores(page);
  await disconnectBackend(page);
  await seedDmxUniverseColorState(page);
  await openDmxUniversePanel(page);

  await expect(channelValue(page, 1)).toHaveText("64");
  await expect(channelValue(page, 1)).toHaveCSS("color", "rgb(183, 28, 28)");
  await expect(channelValue(page, 2)).toHaveText("96");
  await expect(channelValue(page, 2)).toHaveCSS("color", "rgb(255, 255, 255)");
  await expect(channelValue(page, 3)).toHaveText("128");
  await expect(channelValue(page, 3)).toHaveCSS("color", "rgb(255, 255, 255)");
  await expect(channelValue(page, 4)).toHaveText("42");
  await expect(channelValue(page, 4)).toHaveCSS("color", "rgb(156, 163, 175)");
  await expect(channelValue(page, 5)).toHaveText("0");
  await expect(channelValue(page, 5)).toHaveCSS("color", "rgb(107, 114, 128)");
});

/** Verifies right-click exposes channel navigation actions previously hidden behind modifier clicks. */
test("dmx universe panel context menu exposes channel follow actions", async ({
  page,
}) => {
  await page.goto("/?e2e=1");
  await expect(page.locator("main#app")).toBeVisible();
  await waitForAppStores(page);
  await disconnectBackend(page);
  await seedDmxUniverseColorState(page);
  await openDmxUniversePanel(page);

  await channelTile(page, 1).click({ button: "right" });
  const menu = page.locator('[data-menu-kind="context"]');
  await expect(menu).toBeVisible();
  const menuBox = await menu.boundingBox();
  expect(menuBox?.width ?? 0).toBeGreaterThan(250);
  await expect(
    menu.getByRole("menuitem", { name: "Follow binding in Patch" }),
  ).toBeVisible();
  await expect(
    menu.getByRole("menuitem", { name: "Show asserting layer" }),
  ).toBeVisible();
});

test("dmx universe panel supports Mod+G fixture, element, and attribute jumps", async ({
  page,
}) => {
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await page.goto("/?e2e=1");
  await expect(page.locator("main#app")).toBeVisible();
  await waitForAppStores(page);
  await disconnectBackend(page);
  await seedDmxUniverseJumpState(page);
  await openDmxUniversePanel(page);

  await channelValue(page, 1).click();
  await page.keyboard.press(`${modifier}+G`);
  let jumpInput = page.getByLabel("Fixture ID jump");
  await expect(jumpInput).toBeFocused();

  await jumpInput.fill("601");
  await expect(channelTile(page, 500)).toHaveAttribute(
    "data-dmx-jump-match",
    "true",
  );
  await expect(channelTile(page, 500)).toBeInViewport();
  await expect(channelValue(page, 500)).toHaveText("60");

  await jumpInput.press("Enter");
  await expect(channelTile(page, 500)).not.toHaveAttribute(
    "data-dmx-jump-match",
    "true",
  );
  await channelValue(page, 500).click();
  await page.keyboard.press(`${modifier}+G`);
  jumpInput = page.getByLabel("Fixture ID jump");
  await jumpInput.fill("601.5");
  await expect(channelTile(page, 512)).toHaveAttribute(
    "data-dmx-jump-match",
    "true",
  );
  await expect(channelTile(page, 512)).toBeInViewport();
  await expect(channelValue(page, 512)).toHaveText("65");

  await jumpInput.press("Enter");
  await expect(channelTile(page, 512)).not.toHaveAttribute(
    "data-dmx-jump-match",
    "true",
  );
  await channelValue(page, 512).click();
  await page.keyboard.press(`${modifier}+G`);
  jumpInput = page.getByLabel("Fixture ID jump");
  await jumpInput.fill('601.4 "Color Wheel"');
  await expect(channelTile(page, 511)).toHaveAttribute(
    "data-dmx-jump-match",
    "true",
  );
  await expect(channelTile(page, 511)).toBeInViewport();
  await expect(channelValue(page, 511)).toHaveText("64");

  await jumpInput.press("Enter");
  await expect(channelTile(page, 511)).not.toHaveAttribute(
    "data-dmx-jump-match",
    "true",
  );
  await channelValue(page, 511).click();
  await page.keyboard.press(`${modifier}+G`);
  jumpInput = page.getByLabel("Fixture ID jump");
  await jumpInput.fill("14 Tilt");
  await expect(channelTile(page, 21)).toHaveAttribute(
    "data-dmx-jump-match",
    "true",
  );
  await expect(channelTile(page, 21)).toBeInViewport();
  await expect(channelValue(page, 21)).toHaveText("21");
  await expect(consoleDmxTab(page)).toBeInViewport();
});

/** Verifies Enter accepts the current previewed viewport even after the final text stops matching. */
test("dmx universe panel accepts stale fixture jump previews on Enter", async ({
  page,
}) => {
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await page.goto("/?e2e=1");
  await expect(page.locator("main#app")).toBeVisible();
  await waitForAppStores(page);
  await disconnectBackend(page);
  await seedDmxUniverseJumpState(page);
  await openDmxUniversePanel(page);

  await channelValue(page, 1).click();
  await page.keyboard.press(`${modifier}+G`);
  const jumpInput = page.getByLabel("Fixture ID jump");
  await jumpInput.fill("6");
  await expect(channelTile(page, 500)).toHaveAttribute(
    "data-dmx-jump-match",
    "true",
  );
  await expect(channelTile(page, 500)).toBeInViewport();

  await jumpInput.fill("699");
  await expect(channelTile(page, 500)).not.toHaveAttribute(
    "data-dmx-jump-match",
    "true",
  );
  await jumpInput.press("Enter");

  await expect(jumpInput).toBeHidden();
  await expect(channelTile(page, 500)).toBeInViewport();
  await expect(channelTile(page, 500)).not.toHaveAttribute(
    "data-dmx-jump-match",
    "true",
  );
});

/** Verifies blur accepts the current previewed viewport even after the final text stops matching. */
test("dmx universe panel accepts stale fixture jump previews on blur", async ({
  page,
}) => {
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await page.goto("/?e2e=1");
  await expect(page.locator("main#app")).toBeVisible();
  await waitForAppStores(page);
  await disconnectBackend(page);
  await seedDmxUniverseJumpState(page);
  await openDmxUniversePanel(page);

  await channelValue(page, 1).click();
  await page.keyboard.press(`${modifier}+G`);
  const jumpInput = page.getByLabel("Fixture ID jump");
  await jumpInput.fill("6");
  await expect(channelTile(page, 500)).toHaveAttribute(
    "data-dmx-jump-match",
    "true",
  );
  await expect(channelTile(page, 500)).toBeInViewport();

  await jumpInput.fill("699");
  await expect(channelTile(page, 500)).not.toHaveAttribute(
    "data-dmx-jump-match",
    "true",
  );
  await consoleDmxTab(page).click();

  await expect(jumpInput).toBeHidden();
  await expect(channelTile(page, 500)).toBeInViewport();
  await expect(channelTile(page, 500)).not.toHaveAttribute(
    "data-dmx-jump-match",
    "true",
  );
});

/** Verifies Escape cancels a stale fixture jump preview and restores the original viewport. */
test("dmx universe panel cancels stale fixture jump previews on Escape", async ({
  page,
}) => {
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await page.goto("/?e2e=1");
  await expect(page.locator("main#app")).toBeVisible();
  await waitForAppStores(page);
  await disconnectBackend(page);
  await seedDmxUniverseJumpState(page);
  await openDmxUniversePanel(page);

  await channelValue(page, 1).click();
  await expect(channelTile(page, 1)).toBeInViewport();
  await page.keyboard.press(`${modifier}+G`);
  const jumpInput = page.getByLabel("Fixture ID jump");
  await jumpInput.fill("6");
  await expect(channelTile(page, 500)).toBeInViewport();

  await jumpInput.fill("699");
  await expect(channelTile(page, 500)).not.toHaveAttribute(
    "data-dmx-jump-match",
    "true",
  );
  await jumpInput.press("Escape");

  await expect(jumpInput).toBeHidden();
  await expect(channelTile(page, 1)).toBeInViewport();
  await expect(channelTile(page, 500)).not.toBeInViewport();
});

/** Verifies shared direction, transport, and visibility controls preserve DMX selection and settings commands. */
test("dmx shared controls switch direction and request external traffic visibility", async ({
  page,
}, testInfo) => {
  await page.goto("/?e2e=1");
  await expect(page.locator("main#app")).toBeVisible();
  await waitForAppStores(page);
  await disconnectBackend(page);
  await seedDmxUniverseColorState(page);
  await openDmxUniversePanel(page);
  const panel = dmxUniversePanel(page);
  await expect(
    panel.getByRole("tab", { name: "Output", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(panel.getByLabel("Transport")).toHaveValue("Console");
  await panel.screenshot({
    path: testInfo.outputPath("shared-dmx-output.png"),
  });

  await page.evaluate(async () => {
    const { engineRuntime } = await import("/lib/engine-runtime.ts");
    (window as any).__dmxSettingsCommands = [];
    engineRuntime.sendCommand = (command: unknown) => {
      (window as any).__dmxSettingsCommands.push(command);
      return null;
    };
  });
  await panel.getByRole("tab", { name: "Input", exact: true }).click();
  await expect(
    panel.getByRole("tab", { name: "Input", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  const externalOnly = panel.getByRole("switch", { name: "External only" });
  await expect(externalOnly).toBeChecked();
  await externalOnly.focus();
  await page.keyboard.press("Space");
  await expect
    .poll(() => page.evaluate(() => (window as any).__dmxSettingsCommands))
    .toContainEqual({
      module: "SettingsCommand",
      command: { type: "SetInputUniverseVisibilityMode", data: "AllDetected" },
    });
  await panel.screenshot({ path: testInfo.outputPath("shared-dmx-input.png") });
  await panel.getByRole("tab", { name: "Output", exact: true }).click();
  await expect(channelValue(page, 1)).toHaveText("64");
});
