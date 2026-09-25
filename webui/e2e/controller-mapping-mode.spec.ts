// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createSocket } from "node:dgram";
import { prepareFreshBackendShowfile } from "./backend-showfile";
import { gridCellByKey } from "./data-grid-selectors";
import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

const COMMAND_INPUT_PLACEHOLDER = "Type a command or search...";

/** Opens a blank showfile on the test's isolated backend. */
async function openMappingApp(page: Page, backendPort: number): Promise<void> {
  await prepareFreshBackendShowfile(backendPort);
  await page.setViewportSize({ width: 1800, height: 1100 });
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("nightfall.currentShowfileName", "default");
  });
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await expect(page.locator("main#app")).toBeVisible();
  await waitForDockviewApp(page);
  await expect
    .poll(() =>
      page.evaluate(
        () => ((window as any).appStores.actionCatalog.get() as []).length,
      ),
    )
    .toBeGreaterThan(0);
}

/** Opens a panel through the command palette. */
async function openPanel(page: Page, panelName: string): Promise<void> {
  await page.getByRole("button", { name: "Open command palette" }).click();
  const commandInput = page.getByPlaceholder(COMMAND_INPUT_PLACEHOLDER);
  await expect(commandInput).toBeVisible();
  await commandInput.fill(`Open ${panelName}`);
  await page.keyboard.press("Enter");
}

/** Encodes a string as a null-terminated, four-byte-aligned OSC string. */
function oscString(value: string): Buffer {
  const length = Math.ceil((value.length + 1) / 4) * 4;
  const buffer = Buffer.alloc(length);
  buffer.write(value, "ascii");
  return buffer;
}

/** Encodes one OSC message with optional float arguments. */
function oscMessage(address: string, floats: number[] = []): Buffer {
  const values = floats.map((value) => {
    const buffer = Buffer.alloc(4);
    buffer.writeFloatBE(value);
    return buffer;
  });
  return Buffer.concat([
    oscString(address),
    oscString(`,${"f".repeat(floats.length)}`),
    ...values,
  ]);
}

/** Sends one OSC message to the backend's listener over UDP. */
async function sendOsc(
  port: number,
  address: string,
  floats: number[] = [],
): Promise<void> {
  const socket = createSocket("udp4");
  await new Promise<void>((resolve, reject) =>
    socket.send(oscMessage(address, floats), port, "127.0.0.1", (error) =>
      error ? reject(error) : resolve(),
    ),
  );
  socket.close();
}

/** Returns the port the backend's OSC listener is bound to. */
async function oscPort(page: Page): Promise<number> {
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).appStores.oscListenerStatus.get()?.is_listening,
      ),
    )
    .toBe(true);
  return page.evaluate(
    () => (window as any).appStores.oscListenerStatus.get().port as number,
  );
}

/** Enters mapping mode and waits until the backend confirms controller actions are paused. */
async function enterMapping(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Controller mapping mode" }).click();
  await expect(
    page.locator("[data-mapping-mode-banner] [data-mapping-pause]"),
  ).toHaveText("MIDI and OSC actions are paused.");
}

/** Leaves mapping mode and waits until the backend resumes controller actions. */
async function leaveMapping(page: Page): Promise<void> {
  const banner = page.locator("[data-mapping-mode-banner]");
  await expect(async () => {
    if (await banner.isVisible()) await page.keyboard.press("Escape");
    await expect(banner).toBeHidden({ timeout: 500 });
  }).toPass();
  await expect.poll(() => mappingClients(page)).toBe(0);
}

/** Returns how many clients the backend reports as mapping controllers. */
function mappingClients(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      (window as any).appStores.controllerMappingMode.get()
        .mapping_clients as number,
  );
}

/** Returns the only master in the showfile. */
async function onlyMaster(page: Page): Promise<{
  uid: string;
  level_percent: number;
  mode: { type: string; data?: { active: boolean } };
}> {
  return page.evaluate(
    () => Object.values((window as any).appStores.masters.get())[0] as never,
  );
}

test("touching a control then clicking a target binds it and the binding drives the target", async ({
  backendSlot,
  page,
}) => {
  await openMappingApp(page, backendSlot.backendPort);
  const port = await oscPort(page);

  await openPanel(page, "Masters");
  await page.getByRole("button", { name: "New intensity global" }).click();
  await expect
    .poll(async () => (await onlyMaster(page))?.level_percent)
    .toBe(100);
  await page
    .locator("[data-master-id] select")
    .first()
    .selectOption("toggle-off");
  await expect
    .poll(async () => (await onlyMaster(page)).mode.type)
    .toBe("Toggle");

  await enterMapping(page);
  const banner = page.locator("[data-mapping-mode-banner]");
  await expect(banner).toContainText("move a MIDI or OSC control");

  // Touch an OSC fader, then click the master's level slider.
  await sendOsc(port, "/e2e/map/level", [0.9]);
  await expect(banner).toContainText("OSC /e2e/map/level");
  const levelOverlay = page.getByRole("button", {
    name: "Map Global Master level",
  });
  await levelOverlay.click();
  const levelMenu = page.getByRole("menu", {
    name: "Map Global Master level to",
  });
  await expect(levelMenu).toContainText(
    "Moving OSC /e2e/map/level sets Master level",
  );
  await levelMenu.getByRole("menuitem", { name: "Follow fader" }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).appStores.oscMappings
          .get()
          .map((mapping: any) => mapping.action.id),
      ),
    )
    .toEqual(["master.level"]);
  // Binding disarms the control and a toast confirms what was created.
  await expect(banner).toContainText("move a MIDI or OSC control");
  await expect(
    page.getByText("Bound OSC /e2e/map/level → Master level"),
  ).toBeVisible();
  await expect(levelOverlay.locator("[data-mapping-count]")).toHaveText("1");
  // The click bound the slider instead of moving it.
  expect((await onlyMaster(page)).level_percent).toBe(100);

  // Touch an OSC button without arguments, then click the master's Toggle button.
  await sendOsc(port, "/e2e/map/toggle");
  await expect(banner).toContainText("OSC /e2e/map/toggle");
  await page.getByRole("button", { name: "Map toggle Global Master" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).appStores.oscMappings.get().length as number,
      ),
    )
    .toBe(2);

  // Touch a MIDI controller, then click the programmer clear button in the header.
  // Without MIDI hardware, inject the reliable touch batch the backend would publish.
  await page.evaluate(() => {
    (window as any).appStores.midiControlTouches.set([
      {
        device: "E2E Pad",
        channel: 0xb0,
        note: 20,
        velocity: 127,
        source: {
          type: "ControlChange",
          data: { channel: 0, controller: 20 },
        },
      },
    ]);
  });
  await expect(banner).toContainText("MIDI CC 20 · Ch 1 (E2E Pad)");
  await page
    .getByRole("navigation", { name: "Global" })
    .getByRole("button", { name: "Map clear programmer" })
    .click();
  await page
    .getByRole("menu", { name: "Map clear programmer to" })
    .getByRole("menuitem", { name: "On press" })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).appStores.midiMappings.get().map((mapping: any) => ({
          action: mapping.action.id,
          source: mapping.source,
        })),
      ),
    )
    .toEqual([
      {
        action: "programmer.clear",
        source: {
          type: "ControlChange",
          data: { channel: 0, controller: 20 },
        },
      },
    ]);

  await page.screenshot({
    path: test.info().outputPath("controller-mapping-mode.png"),
  });

  // Leaving mapping mode restores normal controls, and the bindings drive the master.
  await leaveMapping(page);
  await expect(banner).toBeHidden();
  await expect(levelOverlay).toBeHidden();

  await sendOsc(port, "/e2e/map/level", [0.25]);
  await expect
    .poll(async () => (await onlyMaster(page)).level_percent)
    .toBe(25);
  await sendOsc(port, "/e2e/map/toggle");
  await expect
    .poll(async () => (await onlyMaster(page)).mode.data?.active)
    .toBe(true);
});

/**
 * Arms an OSC button by sending one press and one release while mapping mode is active.
 *
 * Waits for the release to reach the client so the armed gesture records both values.
 */
async function touchOscButton(
  page: Page,
  port: number,
  address: string,
): Promise<void> {
  const banner = page.locator("[data-mapping-mode-banner]");
  await sendOsc(port, address, [1]);
  await expect(banner).toContainText(`OSC ${address}`);
  await sendOsc(port, address, [0]);
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).appStores.oscLastEvent.get()?.args[0]?.data,
      ),
    )
    .toBe(0);
}

test("a Hold binding keeps a toggle master on only while the button is held", async ({
  backendSlot,
  page,
}) => {
  await openMappingApp(page, backendSlot.backendPort);
  const port = await oscPort(page);

  await openPanel(page, "Masters");
  await page.getByRole("button", { name: "New intensity global" }).click();
  await page
    .locator("[data-master-id] select")
    .first()
    .selectOption("toggle-off");
  await expect
    .poll(async () => (await onlyMaster(page))?.mode.type)
    .toBe("Toggle");

  await enterMapping(page);
  await touchOscButton(page, port, "/e2e/map/button");
  const toggleOverlay = page.getByRole("button", {
    name: "Map toggle Global Master",
  });
  await toggleOverlay.click();
  const menu = page.getByRole("menu", { name: "Map toggle Global Master to" });
  await expect(
    menu
      .getByRole("menuitem")
      .evaluateAll((items) =>
        items.map((item) => item.getAttribute("aria-label")),
      ),
  ).resolves.toEqual([
    "Toggle · On press",
    "Toggle · On release",
    "On while held",
  ]);
  await expect(menu).toContainText(
    "Holding OSC /e2e/map/button runs Master on: 1: Global Master; letting go runs Master off: 1: Global Master.",
  );
  await page.screenshot({
    path: test.info().outputPath("controller-mapping-behaviors.png"),
  });
  await menu.getByRole("menuitem", { name: "On while held" }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).appStores.oscMappings.get().map((mapping: any) => ({
          action: mapping.action.id,
          arg_value: mapping.arg_value,
          release_value: mapping.release_value,
          behavior: mapping.behavior,
        })),
      ),
    )
    .toEqual([
      {
        action: "master.on",
        arg_value: "1",
        release_value: "0",
        behavior: "Hold",
      },
    ]);

  // With nothing armed, clicking the target lists its binding instead of rebinding it.
  await toggleOverlay.click();
  await expect(menu.locator("[data-existing-binding]")).toContainText(
    "OSC /e2e/map/button 1 · Hold",
  );
  await expect(menu.getByRole("menuitem")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await leaveMapping(page);

  // Pressing turns the master on and releasing turns it back off.
  await sendOsc(port, "/e2e/map/button", [1]);
  await expect
    .poll(async () => (await onlyMaster(page)).mode.data?.active)
    .toBe(true);
  await sendOsc(port, "/e2e/map/button", [0]);
  await expect
    .poll(async () => (await onlyMaster(page)).mode.data?.active)
    .toBe(false);
});

test("a Flash binding pushes a master to full while held and restores it", async ({
  backendSlot,
  page,
}) => {
  await openMappingApp(page, backendSlot.backendPort);
  const port = await oscPort(page);

  await openPanel(page, "Masters");
  await page.getByRole("button", { name: "New intensity global" }).click();
  await expect
    .poll(async () => (await onlyMaster(page))?.level_percent)
    .toBe(100);
  const masterId = await page.evaluate(
    () =>
      (Object.values((window as any).appStores.masters.get())[0] as any)
        .identifiers.id as number,
  );
  await page.evaluate(
    (id) =>
      (window as any).appStores.sendAndAwait({
        module: "MasterCommand",
        command: {
          type: "SetMasterLevel",
          data: { id, level_percent: 30 },
        },
      }),
    masterId,
  );
  await expect
    .poll(async () => (await onlyMaster(page)).level_percent)
    .toBeCloseTo(30, 3);

  await enterMapping(page);
  await touchOscButton(page, port, "/e2e/map/flash");
  await page.getByRole("button", { name: "Map Global Master level" }).click();
  await page
    .getByRole("menu", { name: "Map Global Master level to" })
    .getByRole("menuitem", { name: "Flash to full" })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).appStores.oscMappings.get()[0]?.behavior,
      ),
    )
    .toBe("Flash");
  await leaveMapping(page);

  await sendOsc(port, "/e2e/map/flash", [1]);
  await expect
    .poll(async () => (await onlyMaster(page)).level_percent)
    .toBe(100);
  await sendOsc(port, "/e2e/map/flash", [0]);
  await expect
    .poll(async () => (await onlyMaster(page)).level_percent)
    .toBeCloseTo(30, 3);
});

test("fader slots with an assigned master offer both mapping targets", async ({
  backendSlot,
  page,
}) => {
  await openMappingApp(page, backendSlot.backendPort);
  const port = await oscPort(page);

  await openPanel(page, "Masters");
  await page.getByRole("button", { name: "New intensity global" }).click();
  await expect
    .poll(async () => (await onlyMaster(page))?.level_percent)
    .toBe(100);
  const masterId = await page.evaluate(
    () =>
      (Object.values((window as any).appStores.masters.get())[0] as any)
        .identifiers.id as number,
  );
  await page.evaluate(
    (masterId) =>
      (window as any).appStores.sendAndAwait({
        module: "ControlCommand",
        command: {
          type: "AssignMaster",
          data: { control_index: 1, master_id: masterId },
        },
      }),
    masterId,
  );
  await openPanel(page, "Clips");

  await enterMapping(page);
  await sendOsc(port, "/e2e/map/fader", [0.5]);
  await expect(page.locator("[data-mapping-mode-banner]")).toContainText(
    "OSC /e2e/map/fader",
  );
  await page.getByRole("button", { name: "Map control 1 fader" }).click();
  const menu = page.getByRole("menu", { name: "Map control 1 fader to" });
  await expect(
    menu
      .getByRole("menuitem")
      .evaluateAll((items) =>
        items.map((item) => item.getAttribute("aria-label")),
      ),
  ).resolves.toEqual([
    "Fader slot 1 · Follow fader",
    "Assigned master: Global Master · Follow fader",
    "Assigned master: Global Master · Flash to full",
  ]);
  await menu
    .getByRole("menuitem", { name: "Fader slot 1 · Follow fader" })
    .click();

  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).appStores.oscMappings
          .get()
          .map((mapping: any) => mapping.action),
      ),
    )
    .toEqual([{ id: "control.level", arguments: { control_index: 1 } }]);
});

test("a mapped OSC button toggles timeline playback", async ({
  backendSlot,
  page,
}) => {
  await openMappingApp(page, backendSlot.backendPort);
  const port = await oscPort(page);
  const ids = await page.evaluate(async () => {
    const stores = (window as any).appStores;
    const timelineUid = crypto.randomUUID().replace(/-/g, "");
    const timecodeUid = crypto.randomUUID().replace(/-/g, "");
    await stores.sendAndAwait({
      module: "TimecodeCommand",
      command: {
        type: "StoreTimecode",
        data: {
          identifiers: { id: 71, uid: timecodeUid, label: "Mapped Timecode" },
          rate: "Fps30",
          source: "Internal",
        },
      },
    });
    await stores.sendAndAwait({
      module: "TimelineCommand",
      command: {
        type: "StoreTimeline",
        data: {
          identifiers: { id: 72, uid: timelineUid, label: "Mapped Timeline" },
          timecode_uid: timecodeUid,
          timecode_start: { secs: 0, nanos: 0 },
          audio_path: "",
          tracks: [],
          markers: [],
          regions: [],
          bpm: 120,
          beats_per_bar: 4,
          use_beat_grid: false,
          scroll_mode: "free",
        },
      },
    });
    const api = stores.dockApi.get();
    api.addPanel({
      id: `panel-Timeline-mapping-${timelineUid}`,
      component: "Timeline",
      title: "Mapped Timeline",
      params: { initialTimelineUid: timelineUid },
      position: {
        referencePanel: api.panels.find(
          (panel: { title?: string }) => panel.title === "3D Visualizer",
        )?.id,
        direction: "within",
      },
    });
    return { timelineUid, timecodeUid };
  });
  /** Returns whether the timeline's linked timecode is running. */
  const isRunning = () =>
    page.evaluate(
      (timecodeUid) =>
        (window as any).appStores.timecodes.get()[timecodeUid]?.[1]
          ?.is_active ?? false,
      ids.timecodeUid,
    );

  await enterMapping(page);
  await sendOsc(port, "/e2e/map/play", [1]);
  await expect(page.locator("[data-mapping-mode-banner]")).toContainText(
    "OSC /e2e/map/play",
  );
  await page.getByRole("button", { name: "Map timeline play/pause" }).click();
  await page
    .getByRole("menu", { name: "Map timeline play/pause to" })
    .getByRole("menuitem", { name: "On press" })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).appStores.oscMappings
          .get()
          .map((mapping: any) => mapping.action.id),
      ),
    )
    .toEqual(["timeline.toggle-playback"]);
  expect(await isRunning()).toBe(false);
  await leaveMapping(page);

  // A level-reporting button toggles once per press: 1 plays, 0 releases, 1 pauses.
  await sendOsc(port, "/e2e/map/play", [0]);
  await sendOsc(port, "/e2e/map/play", [1]);
  await expect.poll(isRunning).toBe(true);
  await sendOsc(port, "/e2e/map/play", [0]);
  await sendOsc(port, "/e2e/map/play", [1]);
  await expect.poll(isRunning).toBe(false);
});

test("touching a mapped control in mapping mode arms it without firing its action", async ({
  backendSlot,
  page,
}) => {
  await openMappingApp(page, backendSlot.backendPort);
  const port = await oscPort(page);

  await openPanel(page, "Masters");
  await page.getByRole("button", { name: "New intensity global" }).click();
  await expect
    .poll(async () => (await onlyMaster(page))?.level_percent)
    .toBe(100);
  const masterUid = await page.evaluate(
    () =>
      (Object.values((window as any).appStores.masters.get())[0] as any)
        .identifiers.uid as string,
  );
  await page.evaluate(
    (master) =>
      (window as any).appStores.sendAndAwait({
        module: "OscCommand",
        command: {
          type: "UpsertMapping",
          data: {
            id: crypto.randomUUID().replace(/-/g, ""),
            source: null,
            address: "/e2e/live/level",
            arg_index: 0,
            arg_value: null,
            release_value: null,
            behavior: "Press",
            action: { id: "master.level", arguments: { master } },
          },
        },
      }),
    masterUid,
  );
  await sendOsc(port, "/e2e/live/level", [0.5]);
  await expect
    .poll(async () => (await onlyMaster(page)).level_percent)
    .toBeCloseTo(50, 3);

  // A second client sees that controller actions are paused while this one maps.
  const observer = await page.context().newPage();
  await observer.goto("/?startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(observer);

  await enterMapping(page);
  await expect.poll(() => mappingClients(page)).toBe(1);
  const banner = page.locator("[data-mapping-mode-banner]");
  await expect(observer.locator("[data-mapping-pause-banner]")).toHaveText(
    "Controller actions paused while 1 client is mapping MIDI and OSC controls.",
  );

  // Moving the mapped fader arms it but leaves the master where it was.
  await sendOsc(port, "/e2e/live/level", [0.2]);
  await expect(banner).toContainText("OSC /e2e/live/level");
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).appStores.oscLastEvent.get()?.args[0]?.data,
      ),
    )
    .toBeCloseTo(0.2, 3);
  await page.waitForTimeout(250);
  expect((await onlyMaster(page)).level_percent).toBeCloseTo(50, 3);
  await page.screenshot({
    path: test.info().outputPath("controller-mapping-paused.png"),
  });
  await observer.screenshot({
    path: test.info().outputPath("controller-mapping-paused-observer.png"),
  });

  // Leaving mapping mode resumes the binding.
  await leaveMapping(page);
  await expect(observer.locator("[data-mapping-pause-banner]")).toBeHidden();
  await sendOsc(port, "/e2e/live/level", [0.25]);
  await expect
    .poll(async () => (await onlyMaster(page)).level_percent)
    .toBeCloseTo(25, 3);

  // Closing a client that is mapping releases its pause on the backend.
  await observer
    .getByRole("button", { name: "Controller mapping mode" })
    .click();
  await expect.poll(() => mappingClients(page)).toBe(1);
  await sendOsc(port, "/e2e/live/level", [0.75]);
  await expect(page.locator("[data-mapping-pause-banner]")).toBeVisible();
  await observer.close();
  await expect.poll(() => mappingClients(page)).toBe(0);
  await expect(page.locator("[data-mapping-pause-banner]")).toBeHidden();
  expect((await onlyMaster(page)).level_percent).toBeCloseTo(25, 3);
  await sendOsc(port, "/e2e/live/level", [0.6]);
  await expect
    .poll(async () => (await onlyMaster(page)).level_percent)
    .toBeCloseTo(60, 3);
});

/** Returns the action IDs of the stored OSC mappings, in list order. */
function oscMappingActions(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    (window as any).appStores.oscMappings
      .get()
      .map((mapping: any) => mapping.action.id as string),
  );
}

/**
 * Verifies rebinding a bound OSC button names the binding it replaced, and that undo brings
 * the replaced binding back while redo reapplies the rebinding.
 */
test("rebinding a control names the replaced binding and undo restores it", async ({
  backendSlot,
  page,
}) => {
  await openMappingApp(page, backendSlot.backendPort);
  const port = await oscPort(page);

  await openPanel(page, "Masters");
  await page.getByRole("button", { name: "New intensity global" }).click();
  await page
    .locator("[data-master-id] select")
    .first()
    .selectOption("toggle-off");
  await expect
    .poll(async () => (await onlyMaster(page))?.mode.type)
    .toBe("Toggle");

  // Bind an OSC button to the master's toggle.
  await enterMapping(page);
  const banner = page.locator("[data-mapping-mode-banner]");
  await sendOsc(port, "/e2e/map/rebind");
  await expect(banner).toContainText("OSC /e2e/map/rebind");
  await page.getByRole("button", { name: "Map toggle Global Master" }).click();
  await expect.poll(() => oscMappingActions(page)).toHaveLength(1);
  const [toggleAction] = await oscMappingActions(page);
  expect(toggleAction).not.toBe("programmer.clear");

  // Rebinding the same button to clear the programmer replaces the toggle binding. The
  // just-bound control ignores messages briefly, so touch it until it arms again.
  await expect(async () => {
    await sendOsc(port, "/e2e/map/rebind");
    await expect(banner).toContainText("OSC /e2e/map/rebind", {
      timeout: 500,
    });
  }).toPass();
  await page
    .getByRole("navigation", { name: "Global" })
    .getByRole("button", { name: "Map clear programmer" })
    .click();
  const clearMenu = page.getByRole("menu", { name: "Map clear programmer to" });
  if (await clearMenu.isVisible()) {
    await clearMenu.getByRole("menuitem", { name: "On press" }).click();
  }
  await expect
    .poll(() => oscMappingActions(page))
    .toEqual(["programmer.clear"]);
  const replacedToast = page.getByText(
    /^Bound OSC \/e2e\/map\/rebind → Clear programmer · On press \(replaced: .*Global Master\)$/,
  );
  await expect(replacedToast).toBeInViewport({ ratio: 1 });
  await replacedToast.screenshot({
    path: test.info().outputPath("controller-mapping-replaced.png"),
  });
  await leaveMapping(page);

  // Undo restores the toggle binding, visible again in the OSC panel. A taller window leaves
  // room for the mapping grid below the listener details.
  await page.setViewportSize({ width: 1800, height: 2200 });
  await openPanel(page, "OSC Input");
  await page.getByRole("button", { name: "Undo: Map OSC control" }).click();
  await expect.poll(() => oscMappingActions(page)).toEqual([toggleAction]);
  const grid = page.locator('[data-grid-kind="tanstack"]').filter({
    has: page.locator('[data-grid-header-id="tanstack-header-address"]'),
  });
  const restoredKey = await page.evaluate(
    () => (window as any).appStores.oscMappings.get()[0].id as string,
  );
  const restoredAction = gridCellByKey(grid, {
    columnKey: "action",
    rowKey: restoredKey,
  });
  await restoredAction.scrollIntoViewIfNeeded();
  await expect(restoredAction).toContainText("Global Master");
  await expect(
    gridCellByKey(grid, { columnKey: "address", rowKey: restoredKey }),
  ).toContainText("/e2e/map/rebind");
  await grid.screenshot({
    path: test.info().outputPath("controller-mapping-undo-restored.png"),
  });

  // Redo reapplies the rebinding.
  await page.getByRole("button", { name: "Redo: Map OSC control" }).click();
  await expect
    .poll(() => oscMappingActions(page))
    .toEqual(["programmer.clear"]);
});
