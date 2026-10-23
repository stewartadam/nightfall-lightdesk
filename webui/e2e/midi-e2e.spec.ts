// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  enterMapping,
  globalMaster,
  leaveMapping,
  makeGlobalMasterToggle,
  openGlobalMaster,
  openMappingApp,
  openPanel,
  setGlobalMasterLevel,
} from "./controller-mapping";
import { expect, type Page } from "./playwright-fixtures";
import { test, type VirtualMidi, waitForMidiDevice } from "./virtual-midi";

/** Stored MIDI mapping fields the specs compare. */
interface StoredMidiMapping {
  id: string;
  device_name: string;
  source: { type: string; data: Record<string, number> };
  behavior: string;
  action: { id: string; arguments: Record<string, unknown> };
}

/** Opens a blank showfile and waits for the backend to connect to the virtual controller. */
async function openMidiApp(
  page: Page,
  backendPort: number,
  midi: VirtualMidi,
): Promise<void> {
  await openMappingApp(page, backendPort);
  await waitForMidiDevice(page, midi);
}

/** Returns the MIDI mappings the backend has stored, in list order. */
function midiMappings(page: Page): Promise<StoredMidiMapping[]> {
  return page.evaluate(
    () => (window as any).appStores.midiMappings.get() as never,
  );
}

/** Returns whether the global intensity master, switched to a toggle master, is on. */
async function masterActive(page: Page): Promise<boolean | undefined> {
  return (await globalMaster(page)).mode.data?.active;
}

/**
 * Touches a note in mapping mode with a press and release, waiting until the press arms it.
 *
 * Waits for the release to reach the client too, so a later message is not mistaken for it.
 */
async function touchNote(
  page: Page,
  midi: VirtualMidi,
  note: number,
): Promise<void> {
  await midi.note(note, true);
  await expect(page.locator("[data-mapping-mode-banner]")).toContainText(
    `MIDI Note ${note} · Ch 1 (${midi.name})`,
  );
  await midi.note(note, false);
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).appStores.midiLastEvent.get()?.velocity,
      ),
    )
    .toBe(0);
}

/** Binds the armed control to a mappable target, choosing a behavior when a menu offers one. */
async function bindArmedTo(
  page: Page,
  label: string,
  option: string,
): Promise<void> {
  await page.getByRole("button", { name: `Map ${label}` }).click();
  const menu = page.getByRole("menu", { name: `Map ${label} to` });
  await menu.getByRole("menuitem", { name: option }).click();
}

/** Stores a mapping from a note on the virtual controller to the global intensity master's toggle. */
async function storeNoteToggleMapping(
  page: Page,
  midi: VirtualMidi,
  note: number,
): Promise<void> {
  const masterUid = (await globalMaster(page)).identifiers.uid;
  await page.evaluate(
    ({ deviceName, masterUid, note }) =>
      (window as any).appStores.sendAndAwait({
        module: "MidiCommand",
        command: {
          type: "UpsertMapping",
          data: {
            id: crypto.randomUUID().replace(/-/g, ""),
            device_name: deviceName,
            source: { type: "Note", data: { channel: 0, note } },
            behavior: "Press",
            action: { id: "master.toggle", arguments: { master: masterUid } },
          },
        },
      }),
    { deviceName: midi.name, masterUid, note },
  );
  await expect.poll(async () => (await midiMappings(page)).length).toBe(1);
}

/** Closes every dock panel with one of the given titles. */
async function closePanels(page: Page, titles: string[]): Promise<void> {
  await page.evaluate((titles) => {
    const api = (window as any).appStores.dockApi.get();
    for (const panel of [...api.panels]) {
      if (titles.includes(panel.title)) api.removePanel(panel);
    }
  }, titles);
}

/**
 * Verifies a note learned in mapping mode keeps driving its master after both the MIDI panel
 * and the master's panel close, so dispatch lives in the backend rather than any panel.
 */
test("a learned MIDI note keeps toggling its master after its panels close", async ({
  backendSlot,
  page,
  virtualMidi,
}) => {
  await openMidiApp(page, backendSlot.backendPort, virtualMidi);
  await openPanel(page, "MIDI Input");
  await expect(page.getByText(virtualMidi.name).first()).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("midi-device-connected.png"),
  });
  await makeGlobalMasterToggle(page);

  await enterMapping(page);
  await touchNote(page, virtualMidi, 60);
  await bindArmedTo(
    page,
    "toggle Global Intensity Master",
    "Toggle · On press",
  );
  await expect
    .poll(async () =>
      (await midiMappings(page)).map((mapping) => ({
        device: mapping.device_name,
        source: mapping.source,
        action: mapping.action.id,
      })),
    )
    .toEqual([
      {
        device: virtualMidi.name,
        source: { type: "Note", data: { channel: 0, note: 60 } },
        action: "master.toggle",
      },
    ]);
  expect(await masterActive(page)).toBe(false);
  await leaveMapping(page);

  await closePanels(page, ["Masters", "MIDI Input"]);
  await expect(page.locator("[data-master-id]")).toHaveCount(0);
  await expect(page.getByText("Connected MIDI Devices")).toHaveCount(0);

  await virtualMidi.note(60, true);
  await expect.poll(() => masterActive(page)).toBe(true);
  await virtualMidi.note(60, false);
  await virtualMidi.note(60, true);
  await expect.poll(() => masterActive(page)).toBe(false);
  await virtualMidi.note(60, false);
  await page.screenshot({
    path: test.info().outputPath("midi-panels-closed.png"),
  });
});

/**
 * Verifies pressing an already mapped note in mapping mode arms it without running its
 * action, and that the first press after leaving mapping mode runs it.
 */
test("pressing a mapped note in mapping mode arms it without firing, then fires after", async ({
  backendSlot,
  page,
  virtualMidi,
}) => {
  await openMidiApp(page, backendSlot.backendPort, virtualMidi);
  await makeGlobalMasterToggle(page);
  await storeNoteToggleMapping(page, virtualMidi, 61);
  await virtualMidi.note(61, true);
  await expect.poll(() => masterActive(page)).toBe(true);
  await virtualMidi.note(61, false);

  await enterMapping(page);
  await touchNote(page, virtualMidi, 61);
  await page.waitForTimeout(250);
  expect(await masterActive(page)).toBe(true);
  await page.screenshot({
    path: test.info().outputPath("midi-mapping-armed.png"),
  });
  await leaveMapping(page);

  await virtualMidi.note(61, true);
  await expect.poll(() => masterActive(page)).toBe(false);
  await virtualMidi.note(61, false);
});

/**
 * Verifies cancelling mapping mode with Escape, after arming a mapped note and opening a
 * target's binding menu, leaves the stored mapping untouched and still working.
 */
test("cancelling mapping mode with Escape leaves existing MIDI mappings unchanged", async ({
  backendSlot,
  page,
  virtualMidi,
}) => {
  await openMidiApp(page, backendSlot.backendPort, virtualMidi);
  await makeGlobalMasterToggle(page);
  await storeNoteToggleMapping(page, virtualMidi, 62);
  const before = await midiMappings(page);

  await enterMapping(page);
  await touchNote(page, virtualMidi, 62);
  await page
    .getByRole("button", { name: "Map toggle Global Intensity Master" })
    .click();
  const menu = page.getByRole("menu", {
    name: "Map toggle Global Intensity Master to",
  });
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await leaveMapping(page);

  expect(await midiMappings(page)).toEqual(before);
  await virtualMidi.note(62, true);
  await expect.poll(() => masterActive(page)).toBe(true);
  await virtualMidi.note(62, false);
});

/** Verifies a Hold binding turns a toggle master on at note on and off at note off. */
test("a Hold MIDI binding keeps a master on only while the note is held", async ({
  backendSlot,
  page,
  virtualMidi,
}) => {
  await openMidiApp(page, backendSlot.backendPort, virtualMidi);
  await makeGlobalMasterToggle(page);

  await enterMapping(page);
  await touchNote(page, virtualMidi, 64);
  await bindArmedTo(page, "toggle Global Intensity Master", "On while held");
  await expect
    .poll(async () =>
      (await midiMappings(page)).map((mapping) => mapping.behavior),
    )
    .toEqual(["Hold"]);
  await leaveMapping(page);

  await virtualMidi.note(64, true);
  await expect.poll(() => masterActive(page)).toBe(true);
  await page.waitForTimeout(250);
  expect(await masterActive(page)).toBe(true);
  await virtualMidi.note(64, false);
  await expect.poll(() => masterActive(page)).toBe(false);
});

/** Verifies a Flash binding pushes a master to full at note on and restores it at note off. */
test("a Flash MIDI binding pushes a master to full while the note is held", async ({
  backendSlot,
  page,
  virtualMidi,
}) => {
  await openMidiApp(page, backendSlot.backendPort, virtualMidi);
  await openGlobalMaster(page);
  await setGlobalMasterLevel(page, 30);

  await enterMapping(page);
  await touchNote(page, virtualMidi, 65);
  await page
    .getByRole("button", { name: "Map Global Intensity Master level" })
    .click();
  const menu = page.getByRole("menu", {
    name: "Map Global Intensity Master level to",
  });
  const flash = menu.getByRole("menuitem", { name: "Flash to full" });
  // A note offers only Flash on a level, which binds without a menu.
  if (await flash.isVisible()) await flash.click();
  await expect
    .poll(async () =>
      (await midiMappings(page)).map((mapping) => mapping.behavior),
    )
    .toEqual(["Flash"]);
  await leaveMapping(page);

  await virtualMidi.note(65, true);
  await expect
    .poll(async () => (await globalMaster(page)).level_percent)
    .toBe(100);
  await virtualMidi.note(65, false);
  await expect
    .poll(async () => (await globalMaster(page)).level_percent)
    .toBeCloseTo(30, 3);
});

/** Verifies a learned CC fader follows its value onto a master's level. */
test("a MIDI CC fader bound to a master level drives the level", async ({
  backendSlot,
  page,
  virtualMidi,
}) => {
  await openMidiApp(page, backendSlot.backendPort, virtualMidi);
  await openGlobalMaster(page);

  await enterMapping(page);
  await virtualMidi.cc(7, 90);
  await expect(page.locator("[data-mapping-mode-banner]")).toContainText(
    `MIDI CC 7 · Ch 1 (${virtualMidi.name})`,
  );
  await bindArmedTo(page, "Global Intensity Master level", "Follow fader");
  await expect
    .poll(async () =>
      (await midiMappings(page)).map((mapping) => ({
        source: mapping.source,
        action: mapping.action.id,
      })),
    )
    .toEqual([
      {
        source: { type: "ControlChange", data: { channel: 0, controller: 7 } },
        action: "master.level",
      },
    ]);
  // The learning move did not move the master.
  expect((await globalMaster(page)).level_percent).toBe(100);
  await leaveMapping(page);

  await virtualMidi.cc(7, 0);
  await expect
    .poll(async () => (await globalMaster(page)).level_percent)
    .toBe(0);
  await virtualMidi.cc(7, 127);
  await expect
    .poll(async () => (await globalMaster(page)).level_percent)
    .toBe(100);
  await virtualMidi.cc(7, 64);
  await expect
    .poll(async () => (await globalMaster(page)).level_percent)
    .toBeCloseTo((64 / 127) * 100, 3);
  await openPanel(page, "Masters");
  await page.screenshot({
    path: test.info().outputPath("midi-cc-master-level.png"),
  });
});

/**
 * Verifies touching a MIDI control that cannot be mapped, such as a program change, says
 * why nothing armed, until a mappable control is touched.
 */
test("an unmappable MIDI message explains why nothing armed", async ({
  backendSlot,
  page,
  virtualMidi,
}) => {
  await openMidiApp(page, backendSlot.backendPort, virtualMidi);
  await enterMapping(page);

  await virtualMidi.send([0xc0, 5]);
  const banner = page.locator("[data-mapping-mode-banner]");
  await expect(banner.locator("[data-mapping-unmappable]")).toContainText(
    `${virtualMidi.name} sent a MIDI program change on channel 1, which can't be mapped.`,
  );
  await banner.screenshot({
    path: test.info().outputPath("midi-unmappable-banner.png"),
  });

  await touchNote(page, virtualMidi, 65);
  await expect(banner.locator("[data-mapping-unmappable]")).toHaveCount(0);
  await leaveMapping(page);
});

/** Returns whether the backend reports LED feedback on for the virtual controller. */
async function feedbackEnabled(
  page: Page,
  midi: VirtualMidi,
): Promise<boolean | undefined> {
  return page.evaluate(
    (name) =>
      (
        (window as any).appStores.midiDevices.get() as {
          name: string;
          feedback: boolean;
        }[]
      ).find((device) => device.name === name)?.feedback,
    midi.name,
  );
}

/**
 * Verifies turning on LED feedback for a device lights a mapped pad while its toggle master
 * is on, with the mapping's own LED values, and darkens it when feedback is turned off.
 */
test("LED feedback lights a mapped pad while its master is on", async ({
  backendSlot,
  page,
  virtualMidi,
}) => {
  await openMidiApp(page, backendSlot.backendPort, virtualMidi);
  await makeGlobalMasterToggle(page);
  await storeNoteToggleMapping(page, virtualMidi, 66);
  await openPanel(page, "MIDI Input");
  const device = page
    .getByTestId("midi-device")
    .filter({ hasText: virtualMidi.name });
  const toggle = device.getByRole("switch", {
    name: `LED feedback for ${virtualMidi.name}`,
  });
  await expect(toggle).not.toBeChecked();
  expect(virtualMidi.received()).toEqual([]);

  await toggle.check();
  await expect.poll(() => feedbackEnabled(page, virtualMidi)).toBe(true);
  await expect(toggle).toBeChecked();
  await expect.poll(() => virtualMidi.received()).toEqual([[0x90, 66, 0]]);

  await virtualMidi.note(66, true);
  await expect.poll(() => masterActive(page)).toBe(true);
  await virtualMidi.note(66, false);
  await expect
    .poll(() => virtualMidi.received().at(-1))
    .toEqual([0x90, 66, 127]);
  await page.screenshot({
    path: test.info().outputPath("midi-led-feedback-on.png"),
  });

  const [mapping] = await midiMappings(page);
  await page.evaluate(
    (mapping) =>
      (window as any).appStores.sendAndAwait({
        module: "MidiCommand",
        command: {
          type: "UpsertMapping",
          data: { ...mapping, led: { on: 21, off: 3 } },
        },
      }),
    mapping,
  );
  await expect
    .poll(() => virtualMidi.received().at(-1))
    .toEqual([0x90, 66, 21]);

  await toggle.uncheck();
  await expect.poll(() => feedbackEnabled(page, virtualMidi)).toBe(false);
  await expect.poll(() => virtualMidi.received().at(-1)).toEqual([0x90, 66, 0]);
});
