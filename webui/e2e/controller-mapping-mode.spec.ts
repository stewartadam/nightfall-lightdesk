// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createSocket } from "node:dgram";
import { prepareFreshBackendShowfile } from "./backend-showfile";
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

  await page.getByRole("button", { name: "Controller mapping mode" }).click();
  const banner = page.locator("[data-mapping-mode-banner]");
  await expect(banner).toContainText("move a MIDI or OSC control");

  // Touch an OSC fader, then click the master's level slider.
  await sendOsc(port, "/e2e/map/level", [0.9]);
  await expect(banner).toContainText("OSC /e2e/map/level");
  const levelOverlay = page.getByRole("button", {
    name: "Map Global Master level",
  });
  await levelOverlay.click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).appStores.oscMappings
          .get()
          .map((mapping: any) => mapping.action.id),
      ),
    )
    .toEqual(["master.level"]);
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
  await page.evaluate(() => {
    (window as any).appStores.midiLastEvent.set({
      device: "E2E Pad",
      channel: 0xb0,
      note: 20,
      velocity: 127,
      source: { type: "ControlChange", data: { channel: 0, controller: 20 } },
    });
  });
  await expect(banner).toContainText("MIDI CC 20 · Ch 1 (E2E Pad)");
  await page
    .getByRole("navigation", { name: "Global" })
    .getByRole("button", { name: "Map clear programmer" })
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
  await page.keyboard.press("Escape");
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

  await page.getByRole("button", { name: "Controller mapping mode" }).click();
  await sendOsc(port, "/e2e/map/fader", [0.5]);
  await expect(page.locator("[data-mapping-mode-banner]")).toContainText(
    "OSC /e2e/map/fader",
  );
  await page.getByRole("button", { name: "Map control 1 fader" }).click();
  const menu = page.getByRole("menu", { name: "Map control 1 fader to" });
  await expect(menu.getByRole("menuitem")).toHaveText([
    "Fader slot 1",
    "Assigned master: Global Master",
  ]);
  await menu.getByRole("menuitem", { name: "Fader slot 1" }).click();

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

  await page.getByRole("button", { name: "Controller mapping mode" }).click();
  await sendOsc(port, "/e2e/map/play", [1]);
  await expect(page.locator("[data-mapping-mode-banner]")).toContainText(
    "OSC /e2e/map/play",
  );
  await page.getByRole("button", { name: "Map timeline play/pause" }).click();
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
  await page.keyboard.press("Escape");

  // A level-reporting button toggles once per press: 1 plays, 0 releases, 1 pauses.
  await sendOsc(port, "/e2e/map/play", [0]);
  await sendOsc(port, "/e2e/map/play", [1]);
  await expect.poll(isRunning).toBe(true);
  await sendOsc(port, "/e2e/map/play", [0]);
  await sendOsc(port, "/e2e/map/play", [1]);
  await expect.poll(isRunning).toBe(false);
});
