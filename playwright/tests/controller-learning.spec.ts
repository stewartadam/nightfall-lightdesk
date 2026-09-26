// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createSocket } from "node:dgram";
import { expect, type Page, test } from "../../webui/e2e/playwright-fixtures";
import { waitForDockviewApp } from "../../webui/e2e/showfile-startup";
import { startMidiController } from "../helpers/midi-controller";

test.use({ sampleDataOnly: true });

// Native MIDI sources are visible to every backend on the host. Keep learning
// sessions sequential so another test's input cannot become the captured source.
test.describe.configure({ mode: "default" });

/** A native CC mapping follows a control slot when its assigned group master changes. */
test("native MIDI fader follows group master reassignment", async ({
  page,
}, testInfo) => {
  test.skip(process.platform === "win32", "Virtual MIDI sources require Unix");
  test.setTimeout(90_000);
  const controller = await startMidiController();
  try {
    await openMappingShow(page);
    await expect
      .poll(() =>
        page.evaluate(
          (name) =>
            (window as any).appStores.midiDevices
              .get()
              .some((device: any) => device.name.includes(name)),
          controller.name,
        ),
      )
      .toBe(true);
    const targets = await page.evaluate(async () => {
      const stores = (window as any).appStores;
      const groups = Object.values(stores.groups.get()) as any[];
      const firstId =
        Math.max(
          0,
          ...(Object.values(stores.masters.get()) as any[]).map(
            (master) => master.identifiers.id,
          ),
        ) + 1;
      const masters = [];
      for (let index = 0; index < 2; index++) {
        const master = {
          identifiers: {
            id: firstId + index,
            uid: crypto.randomUUID().replaceAll("-", ""),
            label: `Mapped group ${index + 1}`,
          },
          kind: "InhibitiveIntensity",
          target: {
            type: "Fixtures",
            data: { type: "Group", data: groups[index].identifiers.uid },
          },
          mode: { type: "AlwaysOn" },
          level_percent: 100,
        };
        const result = await stores.sendAndAwait({
          module: "MasterCommand",
          command: { type: "StoreMaster", data: master },
        });
        if (result.outcome.type !== "Succeeded")
          throw new Error(JSON.stringify(result.outcome));
        masters.push(master.identifiers);
      }
      const result = await stores.sendAndAwait({
        module: "ControlCommand",
        command: {
          type: "AssignMaster",
          data: { control_index: 1, master_id: masters[0].id },
        },
      });
      if (result.outcome.type !== "Succeeded")
        throw new Error(JSON.stringify(result.outcome));
      const api = stores.dockApi.get();
      const panel = api.addPanel({
        id: "midi-master-controls",
        component: "ClipList",
        title: "MIDI group masters",
        params: {},
      });
      for (const other of [...api.panels])
        if (other.id !== panel.id) other.api.close();
      panel.api.setActive();
      return masters;
    });
    const fader = page.getByRole("slider", {
      name: "Control 1 level",
      exact: true,
    });
    await expect(fader).toBeVisible();
    await runMappingCommand(page, "Map MIDI controller");
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as any).appStores.controllerLearning.get()?.surface,
        ),
      )
      .toBe("midi");
    controller.send(0xe0, 0, 64);
    const unsupported = page.getByText(/This MIDI message cannot be learned/);
    await expect(unsupported).toBeVisible();
    controller.send(0xb0, 7, 40);
    await expect(unsupported).not.toBeVisible();
    await expect(
      page
        .locator('[data-control-index="1"] [data-mapping-state]')
        .filter({ has: fader }),
    ).toHaveAttribute("data-mapping-state", "compatible");
    controller.send(0xb0, 7, 60);
    await page.screenshot({
      path: testInfo.outputPath("midi-group-master-ready.png"),
      fullPage: true,
    });
    const track = page.locator(
      '[data-control-index="1"] .vertical-range-slider',
    );
    const bounds = await track.boundingBox();
    expect(bounds).not.toBeNull();
    await track.click({
      position: { x: bounds!.width / 2, y: bounds!.height - 2 },
    });
    await expect
      .poll(() =>
        page.evaluate(() => (window as any).appStores.controllerLearning.get()),
      )
      .toBeNull();
    expect(
      await page.evaluate(
        (uid) => (window as any).appStores.masters.get()[uid].level_percent,
        targets[0].uid,
      ),
    ).toBe(100);
    await page.evaluate(() =>
      (window as any).appStores.dockApi
        .get()
        .getPanel("midi-master-controls")
        .api.close(),
    );
    for (const value of [64, 0]) {
      controller.send(0xb0, 7, value);
      await expect
        .poll(() =>
          page.evaluate(
            (uid) => (window as any).appStores.masters.get()[uid].level_percent,
            targets[0].uid,
          ),
        )
        .toBeCloseTo((value / 127) * 100, 3);
    }
    const result = await page.evaluate(
      (id) =>
        (window as any).appStores.sendAndAwait({
          module: "ControlCommand",
          command: {
            type: "AssignMaster",
            data: { control_index: 1, master_id: id },
          },
        }),
      targets[1].id,
    );
    expect(result.outcome.type).toBe("Succeeded");
    controller.send(0xb0, 7, 32);
    await expect
      .poll(() =>
        page.evaluate(
          (uid) => (window as any).appStores.masters.get()[uid].level_percent,
          targets[1].uid,
        ),
      )
      .toBeCloseTo((32 / 127) * 100, 3);
    expect(
      await page.evaluate(
        (uid) => (window as any).appStores.masters.get()[uid].level_percent,
        targets[0].uid,
      ),
    ).toBe(0);
  } finally {
    await controller.close();
  }
});

/** Native note-on/off learning retains press intent and toggles a timeline without its panel. */
test("native MIDI button maps timeline Start Pause", async ({
  page,
}, testInfo) => {
  test.skip(process.platform === "win32", "Virtual MIDI sources require Unix");
  test.setTimeout(90_000);
  const controller = await startMidiController();
  let timelineUid: string | undefined;
  try {
    await openMappingShow(page);
    await expect
      .poll(() =>
        page.evaluate(
          (name) =>
            (window as any).appStores.midiDevices
              .get()
              .some((device: any) => device.name.includes(name)),
          controller.name,
        ),
      )
      .toBe(true);
    const target = await page.evaluate(() => {
      const stores = (window as any).appStores;
      const timeline = Object.values(stores.timelines.get())[0] as any;
      const api = stores.dockApi.get();
      const panel = api.addPanel({
        id: "midi-timeline",
        component: "Timeline",
        title: "MIDI timeline",
        params: { initialTimelineUid: timeline.identifiers.uid },
      });
      for (const other of [...api.panels])
        if (other.id !== panel.id) other.api.close();
      panel.api.setActive();
      return { uid: timeline.identifiers.uid, clock: timeline.timecode_uid };
    });
    timelineUid = target.uid;
    const play = page
      .locator(
        `[data-timeline-surface="true"][data-timeline-uid="${target.uid}"]:visible`,
      )
      .getByRole("button", { name: "Play timeline", exact: true });
    await expect(play).toBeVisible();
    await runMappingCommand(page, "Map MIDI controller");
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as any).appStores.controllerLearning.get()?.surface,
        ),
      )
      .toBe("midi");
    controller.send(0x90, 43, 127);
    await expect(play).toHaveAttribute("data-mapping-state", "compatible");
    controller.send(0x80, 43, 64);
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as any).appStores.midiLastEvent.get()?.channel,
        ),
      )
      .toBe(0x80);
    await page.screenshot({
      path: testInfo.outputPath("midi-timeline-ready.png"),
      fullPage: true,
    });
    await play.click();
    await expect
      .poll(() =>
        page.evaluate(() => (window as any).appStores.controllerLearning.get()),
      )
      .toBeNull();
    expect(
      await page.evaluate(
        (uid) => (window as any).appStores.timecodes.get()[uid]?.[1]?.is_active,
        target.clock,
      ),
    ).toBe(false);
    await page.evaluate(() =>
      (window as any).appStores.dockApi
        .get()
        .getPanel("midi-timeline")
        .api.close(),
    );
    for (const active of [true, false]) {
      controller.send(0x90, 43, 127);
      await expect
        .poll(() =>
          page.evaluate(
            (uid) =>
              (window as any).appStores.timecodes.get()[uid]?.[1]?.is_active,
            target.clock,
          ),
        )
        .toBe(active);
      controller.send(0x80, 43, 64);
      await expect
        .poll(() =>
          page.evaluate(
            () => (window as any).appStores.midiLastEvent.get()?.channel,
          ),
        )
        .toBe(0x80);
    }
  } finally {
    try {
      if (timelineUid !== undefined)
        await page.evaluate(
          (uid) =>
            (window as any).appStores.sendAndAwait({
              module: "TimelineTransportCommand",
              command: {
                type: "SetPlaying",
                data: { timeline_uid: uid, playing: false },
              },
            }),
          timelineUid,
        );
    } finally {
      await controller.close();
    }
  }
});

/** A native MIDI source learns a control Go action and executes it after the panel closes. */
test("native MIDI button maps control Go", async ({ page }, testInfo) => {
  test.skip(process.platform === "win32", "Virtual MIDI sources require Unix");
  test.setTimeout(90_000);
  const controller = await startMidiController();
  let clipId: number | undefined;
  try {
    await openMappingShow(page);
    await expect
      .poll(() =>
        page.evaluate(
          (name) =>
            (window as any).appStores.midiDevices
              .get()
              .some((device: any) => device.name.includes(name)),
          controller.name,
        ),
      )
      .toBe(true);
    const clip = await page.evaluate(async () => {
      const stores = (window as any).appStores;
      const clip = (Object.values(stores.clips.get()) as any[])
        .map(([clip]) => clip)
        .find((clip) => clip.source?.type === "Sequence");
      const result = await stores.sendAndAwait({
        module: "ControlCommand",
        command: {
          type: "AssignClip",
          data: { control_index: 1, clip_id: clip.identifiers.id },
        },
      });
      const api = stores.dockApi.get();
      const panel = api.addPanel({
        id: "midi-controls",
        component: "ClipList",
        title: "MIDI controls",
        params: {},
      });
      for (const other of [...api.panels])
        if (other.id !== panel.id) other.api.close();
      panel.api.setActive();
      return {
        id: clip.identifiers.id,
        uid: clip.identifiers.uid,
        outcome: result.outcome.type,
      };
    });
    clipId = clip.id;
    expect(clip.outcome).toBe("Succeeded");
    await runMappingCommand(page, "Map MIDI controller");
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as any).appStores.controllerLearning.get()?.surface,
        ),
      )
      .toBe("midi");
    controller.send(0x90, 42, 127);
    const go = page.getByRole("button", { name: "Go control 1", exact: true });
    await expect(go).toHaveAttribute("data-mapping-state", "compatible");
    controller.send(0x90, 42, 0);
    await go.click();
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as any).appStores.midiMappings
            .get()
            .some(
              (mapping: any) =>
                mapping.action.id === "control.go" && mapping.note === 42,
            ),
        ),
      )
      .toBe(true);
    expect(
      await page.evaluate(
        (uid) => (window as any).appStores.clips.get()[uid]?.[1],
        clip.uid,
      ),
    ).toBe(false);
    await page.screenshot({
      path: testInfo.outputPath("midi-control-go.png"),
      fullPage: true,
    });
    await page.evaluate(() =>
      (window as any).appStores.dockApi
        .get()
        .getPanel("midi-controls")
        .api.close(),
    );
    controller.send(0x90, 42, 127);
    await expect
      .poll(() =>
        page.evaluate(
          (uid) => (window as any).appStores.clips.get()[uid]?.[1],
          clip.uid,
        ),
      )
      .toBe(true);
  } finally {
    try {
      if (clipId !== undefined)
        await page.evaluate(
          (id) =>
            (window as any).appStores.sendAndAwait({
              module: "ClipCommand",
              command: { type: "StopClip", data: { type: "Single", data: id } },
            }),
          clipId,
        );
    } finally {
      await controller.close();
    }
  }
});

/** Panels retain diagnostic explanations alongside editable mappings received from the backend. */
test("mapping panels display retained binding diagnostics", async ({
  page,
}, testInfo) => {
  await openMappingShow(page);
  for (const transport of ["Midi", "Osc"] as const) {
    await page.evaluate((transport) => {
      const stores = (window as any).appStores;
      const api = stores.dockApi.get();
      const panelId = `diagnostic-${transport}`;
      const panel = api.addPanel({
        id: panelId,
        component: `${transport}Input`,
        title: `${transport} diagnostics`,
        params: {},
      });
      for (const other of [...api.panels])
        if (other.id !== panelId) other.api.close();
      panel.api.setActive();
      const prefix = transport.toLowerCase();
      stores[`${prefix}Mappings`].set([
        {
          id: "11111111111141118111111111111111",
          action: { id: "unavailable.action", arguments: {} },
          input: { type: "Press" },
          ...(transport === "Midi"
            ? {
                device_name: "Controller",
                channel: 144,
                note: 42,
                velocity: null,
              }
            : {
                address: "/button",
                source: null,
                arg_index: 0,
                arg_value: null,
              }),
        },
      ]);
      stores[`${prefix}MappingDiagnostics`].set([
        {
          code: "action.not_registered",
          message: "The saved action is unavailable",
          details: null,
        },
      ]);
    }, transport);
    await expect(
      page.getByRole("heading", {
        name: `${transport.toUpperCase()} Mappings`,
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("alert").filter({
        hasText: "Mapping 1 disabled: The saved action is unavailable",
      }),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(
        `${transport.toLowerCase()}-mapping-diagnostics.png`,
      ),
      fullPage: true,
    });
  }
});

/** Hardware action failures reach the client even when no panel owns the binding. */
test("OSC unavailable target reports its action failure", async ({
  page,
}, testInfo) => {
  await openMappingShow(page);
  const result = await page.evaluate(async () => {
    const stores = (window as any).appStores;
    const masterUid = crypto.randomUUID().replaceAll("-", "");
    const masterId =
      Math.max(
        0,
        ...(Object.values(stores.masters.get()) as any[]).map(
          (master) => master.identifiers.id,
        ),
      ) + 1;
    const creation = await stores.sendAndAwait({
      module: "MasterCommand",
      command: {
        type: "StoreMaster",
        data: {
          identifiers: {
            id: masterId,
            uid: masterUid,
            label: "Deleted target",
          },
          kind: "InhibitiveIntensity",
          target: { type: "Fixtures", data: { type: "All" } },
          mode: { type: "AlwaysOn" },
          level_percent: 100,
        },
      },
    });
    if (creation.outcome.type !== "Succeeded")
      throw new Error(JSON.stringify(creation.outcome));
    const result = await stores.sendAndAwait({
      module: "OscCommand",
      command: {
        type: "StoreMapping",
        data: {
          expected: null,
          mapping: {
            id: crypto.randomUUID().replaceAll("-", ""),
            source: null,
            address: "/learn/rate",
            arg_index: 0,
            arg_value: null,
            input: { type: "Continuous", data: { minimum: 0, maximum: 1 } },
            action: {
              id: "master.set-level",
              arguments: {
                master_uid: masterUid,
              },
            },
          },
        },
      },
    });
    const deletion = await stores.sendAndAwait({
      module: "MasterCommand",
      command: { type: "DeleteMaster", data: masterId },
    });
    if (deletion.outcome.type !== "Succeeded")
      throw new Error(JSON.stringify(deletion.outcome));
    return {
      outcome: result.outcome,
      port: stores.oscListenerStatus.get().port,
    };
  });
  expect(result.outcome.type).toBe("Succeeded");
  await sendOscFader(result.port, 0.5);
  const failure = page.getByText(
    "Set master level: The mapped master no longer exists",
    { exact: true },
  );
  await expect(failure).toBeVisible();
  await expect
    .poll(async () => (await failure.boundingBox())?.y ?? -1)
    .toBeGreaterThanOrEqual(20);
  await page.screenshot({
    path: testInfo.outputPath("osc-action-failure.png"),
    fullPage: true,
    animations: "disabled",
  });
});

/** Explicit argument and range settings drive the domain's full scale after the editor closes. */
test("OSC editor configures a second argument and custom fader range", async ({
  page,
}, testInfo) => {
  await openMappingShow(page);
  await page.evaluate(() =>
    (window as any).appStores.dockApi.get().addPanel({
      id: "range-master",
      component: "MastersPanel",
      title: "Range master",
      params: {},
    }),
  );
  await page
    .getByRole("button", { name: "New rate global", exact: true })
    .click();
  await expect(
    page.getByRole("slider", {
      name: "Playback Rate Master level",
      exact: true,
    }),
  ).toBeVisible();
  const target = await page.evaluate(() => {
    const stores = (window as any).appStores;
    const master = (Object.values(stores.masters.get()) as any[]).find(
      (master) => master.identifiers.label === "Playback Rate Master",
    );
    const api = stores.dockApi.get();
    api.addPanel({
      id: "range-editor",
      component: "OscInput",
      title: "OSC range editor",
      params: {},
    });
    for (const panel of [...api.panels])
      if (panel.id !== "range-editor") panel.api.close();
    return {
      uid: master.identifiers.uid,
      port: stores.oscListenerStatus.get().port,
    };
  });
  await sendOscPair(target.port, -100, 50);
  await expect(
    page.getByRole("button", { name: "Add Mapping", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Add Mapping", exact: true }).click();
  const editor = page.getByRole("region", {
    name: "OSC mapping action editor",
  });
  await editor
    .getByRole("combobox", { name: "Mapping action" })
    .selectOption("master.set-level");
  await editor
    .getByRole("spinbutton", { name: "OSC value argument" })
    .fill("1");
  await editor
    .getByRole("spinbutton", { name: "OSC source minimum" })
    .fill("-100");
  await editor
    .getByRole("spinbutton", { name: "OSC source maximum" })
    .fill("-100");
  await editor
    .getByRole("combobox", { name: "Mapping target" })
    .selectOption("0");
  await expect(
    editor.getByRole("button", { name: "Save mapping" }),
  ).toBeDisabled();
  await expect(editor.getByRole("alert")).toContainText(
    "maximum greater than its minimum",
  );
  await editor
    .getByRole("spinbutton", { name: "OSC source maximum" })
    .fill("100");
  await expect(
    editor.getByRole("spinbutton", { name: "OSC source minimum" }),
  ).toHaveValue("-100");
  await page.screenshot({
    path: testInfo.outputPath("osc-custom-range.png"),
    fullPage: true,
  });
  await editor.getByRole("button", { name: "Save mapping" }).click();
  await expect(editor).not.toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).appStores.oscMappings
            .get()
            .find((mapping: any) => mapping.address === "/learn/rate")?.input,
      ),
    )
    .toEqual({ type: "Continuous", data: { minimum: -100, maximum: 100 } });
  await page.evaluate(() =>
    (window as any).appStores.dockApi
      .get()
      .getPanel("range-editor")
      .api.close(),
  );
  for (const [value, expected] of [
    [50, 150],
    [-200, 0],
    [200, 200],
  ]) {
    await sendOscPair(target.port, -100, value);
    await expect
      .poll(() =>
        page.evaluate(
          (uid) => (window as any).appStores.masters.get()[uid].level_percent,
          target.uid,
        ),
      )
      .toBe(expected);
  }
});

/** Editing a migrated fader keeps its historical conversion and persistent identity. */
test("OSC editor preserves migrated automatic ranges", async ({
  page,
}, testInfo) => {
  await openMappingShow(page);
  const setup = await page.evaluate(async () => {
    const stores = (window as any).appStores;
    const mapping = {
      id: crypto.randomUUID().replaceAll("-", ""),
      source: null,
      address: "/legacy/fader",
      arg_index: 0,
      arg_value: null,
      input: { type: "LegacyContinuous" },
      action: { id: "control.set-external", arguments: { control_index: 1 } },
    };
    const result = await stores.sendAndAwait({
      module: "OscCommand",
      command: { type: "StoreMapping", data: { expected: null, mapping } },
    });
    const api = stores.dockApi.get();
    api.addPanel({
      id: "legacy-editor",
      component: "OscInput",
      title: "OSC legacy editor",
      params: {},
    });
    for (const panel of [...api.panels])
      if (panel.id !== "legacy-editor") panel.api.close();
    return { id: mapping.id, result };
  });
  expect(setup.result.outcome.type).toBe("Succeeded");
  await page
    .getByRole("gridcell", { name: "/legacy/fader", exact: true })
    .click();
  await page.getByRole("button", { name: "Edit action", exact: true }).click();
  const editor = page.getByRole("region", {
    name: "OSC mapping action editor",
  });
  await expect(
    editor.getByText("Automatic range:", { exact: false }),
  ).toBeVisible();
  await expect(
    editor.getByRole("combobox", { name: "OSC activation" }),
  ).toHaveCount(0);
  await editor
    .getByRole("spinbutton", { name: "OSC value argument" })
    .fill("1");
  await page.screenshot({
    path: testInfo.outputPath("osc-legacy-range.png"),
    fullPage: true,
  });
  await editor.getByRole("button", { name: "Save mapping" }).click();
  await expect(editor).not.toBeVisible();
  await expect
    .poll(() =>
      page.evaluate((id) => {
        const mapping = (window as any).appStores.oscMappings
          .get()
          .find((item: any) => item.id === id);
        return { input: mapping?.input, index: mapping?.arg_index };
      }, setup.id),
    )
    .toEqual({ input: { type: "LegacyContinuous" }, index: 1 });
});

/** Sends two distinguishable float arguments so tests prove which argument drives the action. */
async function sendOscPair(port: number, first: number, second: number) {
  const packet = Buffer.alloc(24);
  packet.write("/learn/rate");
  packet.write(",ff", 12);
  packet.writeFloatBE(first, 16);
  packet.writeFloatBE(second, 20);
  const socket = createSocket("udp4");
  try {
    await new Promise<void>((resolve, reject) =>
      socket.send(packet, port, "127.0.0.1", (error) =>
        error ? reject(error) : resolve(),
      ),
    );
  } finally {
    socket.close();
  }
}

/** The manual editor selects domain targets from the catalog and freezes the chosen source. */
test("OSC editor chooses catalog actions without typed action names", async ({
  page,
}, testInfo) => {
  await openMappingShow(page);
  const port = await page.evaluate(() => {
    const stores = (window as any).appStores;
    const api = stores.dockApi.get();
    api.addPanel({
      id: "osc-editor",
      component: "OscInput",
      title: "OSC input",
      params: {},
    });
    for (const panel of [...api.panels])
      if (panel.id !== "osc-editor") panel.api.close();
    return stores.oscListenerStatus.get().port;
  });
  await sendOscButton(port, 1);
  await expect(page.getByText("Last Input:")).toBeVisible();
  await page.getByRole("button", { name: "Add Mapping", exact: true }).click();
  const editor = page.getByRole("region", {
    name: "OSC mapping action editor",
  });
  await expect(
    editor.getByRole("button", { name: "Save mapping" }),
  ).toBeDisabled();
  const action = editor.getByRole("combobox", { name: "Mapping action" });
  await action.selectOption("control.go");
  await expect(
    editor
      .getByRole("combobox", { name: "Mapping target" })
      .getByRole("option", { name: "Control 1", exact: true }),
  ).toHaveCount(1);
  await action.selectOption("timeline.toggle-playback");
  await expect(
    editor.getByRole("combobox", { name: "Mapping target" }).locator("option"),
  ).not.toHaveCount(1);
  await action.selectOption("clip.go");
  await expect(
    editor.getByRole("button", { name: "Save mapping" }),
  ).toBeDisabled();
  await editor
    .getByRole("combobox", { name: "Mapping target" })
    .selectOption("0");
  await sendOscFader(port, 0.5);
  await editor
    .getByRole("spinbutton", { name: "OSC value argument" })
    .fill("-1");
  await expect(
    editor.getByRole("button", { name: "Save mapping" }),
  ).toBeDisabled();
  await editor
    .getByRole("combobox", { name: "OSC activation" })
    .selectOption("Pulse");
  await expect(
    editor.getByRole("button", { name: "Save mapping" }),
  ).toBeEnabled();
  await editor
    .getByRole("combobox", { name: "OSC activation" })
    .selectOption("Release");
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).appStores.oscLastEvent.get()?.address,
      ),
    )
    .toBe("/learn/rate");
  await page.screenshot({
    path: testInfo.outputPath("osc-catalog-editor.png"),
    fullPage: true,
  });
  await editor.getByRole("button", { name: "Save mapping" }).click();
  await expect(editor).not.toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).appStores.oscMappings
          .get()
          .some(
            (mapping: any) =>
              mapping.address === "/learn/clear" &&
              mapping.action.id === "clip.go",
          ),
      ),
    )
    .toBe(true);
  const saved = await page.evaluate(() => {
    const stores = (window as any).appStores;
    const mapping = stores.oscMappings
      .get()
      .find((mapping: any) => mapping.address === "/learn/clear");
    return {
      mapping,
      firstClip: Object.values(stores.clips.get())
        .map((entry: any) => entry[0])
        .sort((a: any, b: any) => a.identifiers.id - b.identifiers.id)[0],
    };
  });
  expect(saved.mapping.action.arguments.target).toEqual({
    type: "Uid",
    data: saved.firstClip.identifiers.uid.replaceAll("-", ""),
  });
  expect(saved.mapping.arg_value).toBeFalsy();
  expect(saved.mapping.input).toEqual({ type: "Release" });
});

/** A second tab cannot use the visible token, and closing the owner releases learning immediately. */
test("learning belongs to its connection and ends on disconnect", async ({
  page,
}) => {
  await openMappingShow(page);
  const other = await page.context().newPage();
  await other.goto(page.url());
  await waitForDockviewApp(other);
  await runMappingCommand(page, "Map OSC controller");
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).appStores.controllerLearning.get()?.session_id,
      ),
    )
    .toBeTruthy();
  const port = await page.evaluate(
    () => (window as any).appStores.oscListenerStatus.get().port,
  );
  await sendOscButton(port, 1);
  await expect
    .poll(() =>
      other.evaluate(
        () => (window as any).appStores.controllerLearning.get()?.captured,
      ),
    )
    .toBeTruthy();
  const denied = await other.evaluate(async () => {
    const stores = (window as any).appStores;
    const session_id = stores.controllerLearning.get().session_id;
    const cancel = await stores.sendAndAwait({
      module: "ControllerLearningCommand",
      command: { type: "Cancel", data: { session_id } },
    });
    const bind = await stores.sendAndAwait({
      module: "OscCommand",
      command: {
        type: "BindLearned",
        data: {
          session_id,
          action: { id: "programmer.clear", arguments: {} },
          replace: null,
          arg_index: null,
          input: null,
        },
      },
    });
    return [cancel, bind];
  });
  for (const result of denied) {
    expect(result.outcome.type).toBe("Failed");
    expect(result.outcome.data.code).toBe("mapping.learning_busy");
  }
  await page.close();
  await expect
    .poll(
      () =>
        other.evaluate(() =>
          (window as any).appStores.controllerLearning.get(),
        ),
      { timeout: 5000 },
    )
    .toBeNull();
  await runMappingCommand(other, "Map OSC controller");
  await expect(
    other.getByRole("button", { name: "Cancel mapping", exact: true }),
  ).toBeVisible();
  await other.screenshot({
    path: test.info().outputPath("learning-new-owner.png"),
    fullPage: true,
  });
  await other
    .getByRole("button", { name: "Cancel mapping", exact: true })
    .click();
  await other.close();
});

/** Backend termination clears local interception without waiting for the next heartbeat. */
test("backend learning termination disarms UI controls", async ({ page }) => {
  await openMappingShow(page);
  await runMappingCommand(page, "Map OSC controller");
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).appStores.controllerLearning.get()?.session_id,
      ),
    )
    .toBeTruthy();
  const clear = page
    .getByRole("button", { name: "Clear programmer", exact: true })
    .first();
  await expect(clear).toHaveAttribute("data-mapping-state", "waiting");
  const result = await page.evaluate(() => {
    const stores = (window as any).appStores;
    return stores.sendAndAwait({
      module: "ControllerLearningCommand",
      command: {
        type: "Cancel",
        data: { session_id: stores.controllerLearning.get().session_id },
      },
    });
  });
  expect(result.outcome.type).toBe("Succeeded");
  await expect(clear).toHaveAttribute("data-mapping-state", "inactive");
  await expect(
    page.getByRole("button", { name: "Cancel mapping", exact: true }),
  ).not.toBeVisible();
  await expect(
    page.getByRole("region", { name: "Controller mapping", exact: true }),
  ).not.toBeVisible();
});

/** Relearning an occupied source requires explicit replacement and remains undoable. */
test("OSC relearning requires explicit replacement and preserves undo", async ({
  page,
}, testInfo) => {
  await openMappingShow(page);
  const setup = await page.evaluate(async () => {
    const stores = (window as any).appStores;
    const mapping = {
      id: crypto.randomUUID().replaceAll("-", ""),
      source: null,
      address: "/learn/clear",
      arg_index: 0,
      arg_value: null,
      input: { type: "Press" },
      action: {
        id: "desk.eval",
        arguments: { command: "clear", metadata: null, nested: [null, []] },
      },
    };
    const result = await stores.sendAndAwait({
      module: "OscCommand",
      command: { type: "StoreMapping", data: { expected: null, mapping } },
    });
    const api = stores.dockApi.get();
    api.addPanel({
      id: "replace-controls",
      component: "ClipList",
      title: "Replace mapping",
      params: {},
    });
    for (const panel of [...api.panels])
      if (panel.id !== "replace-controls") panel.api.close();
    return { mapping, result, port: stores.oscListenerStatus.get().port };
  });
  expect(setup.result.outcome.type).toBe("Succeeded");
  const go = page.getByRole("button", { name: "Go control 1", exact: true });
  for (const replace of [false, true]) {
    await runMappingCommand(page, "Map OSC controller");
    await expect(go).toHaveAttribute("data-mapping-state", "waiting");
    await sendOscButton(setup.port, 1);
    await expect(go).toHaveAttribute("data-mapping-state", "compatible");
    await sendOscButton(setup.port, 0);
    await go.click();
    const replacement = page.getByRole("button", {
      name: "Replace existing mapping",
      exact: true,
    });
    await expect(replacement).toBeVisible();
    expect(
      await page.evaluate(
        (id) =>
          (window as any).appStores.oscMappings
            .get()
            .find((mapping: any) => mapping.id === id),
        setup.mapping.id,
      ),
    ).toEqual(setup.mapping);
    if (replace) {
      await page.screenshot({
        path: testInfo.outputPath("osc-replacement-confirmation.png"),
        fullPage: true,
      });
      await replacement.click();
    } else {
      await page
        .getByRole("button", { name: "Cancel mapping", exact: true })
        .click();
    }
    await expect(
      page.getByRole("region", { name: "Controller mapping", exact: true }),
    ).not.toBeVisible();
    await expect(replacement).not.toBeVisible();
  }
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          (window as any).appStores.oscMappings
            .get()
            .find((mapping: any) => mapping.id === id)?.action,
        setup.mapping.id,
      ),
    )
    .toEqual({ id: "control.go", arguments: { control_index: 1 } });
  await page
    .getByRole("button", { name: "Undo: Map OSC controller", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          (window as any).appStores.oscMappings
            .get()
            .find((mapping: any) => mapping.id === id),
        setup.mapping.id,
      ),
    )
    .toEqual(setup.mapping);
  const edited = await page.evaluate(async (id) => {
    const stores = (window as any).appStores;
    const expected = stores.oscMappings
      .get()
      .find((mapping: any) => mapping.id === id);
    return stores.sendAndAwait({
      module: "OscCommand",
      command: {
        type: "StoreMapping",
        data: { expected, mapping: { ...expected, address: "/learn/edited" } },
      },
    });
  }, setup.mapping.id);
  expect(edited.outcome.type).toBe("Succeeded");
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          (window as any).appStores.oscMappings
            .get()
            .find((mapping: any) => mapping.id === id)?.address,
        setup.mapping.id,
      ),
    )
    .toBe("/learn/edited");
  const removed = await page.evaluate(async (id) => {
    const stores = (window as any).appStores;
    const expected = stores.oscMappings
      .get()
      .find((mapping: any) => mapping.id === id);
    return stores.sendAndAwait({
      module: "OscCommand",
      command: { type: "RemoveMapping", data: { expected } },
    });
  }, setup.mapping.id);
  expect(removed.outcome.type).toBe("Succeeded");
});

/** An empty control can be mapped before a clip is assigned, and its binding follows the slot. */
test("empty control Go can be learned before assignment", async ({ page }) => {
  await openMappingShow(page);
  const target = await page.evaluate(async () => {
    const stores = (window as any).appStores;
    const result = await stores.sendAndAwait({
      module: "ControlCommand",
      command: { type: "ClearClip", data: { control_index: 1 } },
    });
    const api = stores.dockApi.get();
    api.addPanel({
      id: "mapped-controls",
      component: "ClipList",
      title: "Mapped controls",
      params: {},
    });
    for (const panel of [...api.panels])
      if (panel.id !== "mapped-controls") panel.api.close();
    const clip = (Object.values(stores.clips.get()) as any[])
      .map(([clip]) => clip)
      .find((clip) => clip.source?.type === "Sequence");
    return {
      result,
      id: clip.identifiers.id,
      uid: clip.identifiers.uid,
      port: stores.oscListenerStatus.get().port,
    };
  });
  expect(target.result.outcome.type).toBe("Succeeded");
  const go = page.getByRole("button", { name: "Go control 1", exact: true });
  await expect(go).toBeDisabled();
  await runMappingCommand(page, "Map OSC controller");
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).appStores.controllerLearning.get()?.surface,
      ),
    )
    .toBe("osc");
  await sendOscButton(target.port, 1);
  await expect(go).toHaveAttribute("data-mapping-state", "compatible");
  await expect(go).toBeEnabled();
  await page.screenshot({
    path: test.info().outputPath("empty-control-mapping.png"),
    fullPage: true,
  });
  await go.click();
  await expect(go).toBeDisabled();
  await sendOscButton(target.port, 0);
  const assigned = await page.evaluate(
    (id) =>
      (window as any).appStores.sendAndAwait({
        module: "ControlCommand",
        command: {
          type: "AssignClip",
          data: { control_index: 1, clip_id: id },
        },
      }),
    target.id,
  );
  expect(assigned.outcome.type).toBe("Succeeded");
  try {
    await sendOscButton(target.port, 1);
    await expect
      .poll(() =>
        page.evaluate(
          (uid) => (window as any).appStores.clips.get()[uid]?.[1],
          target.uid,
        ),
      )
      .toBe(true);
  } finally {
    await page.evaluate(
      (id) =>
        (window as any).appStores.sendAndAwait({
          module: "ClipCommand",
          command: { type: "StopClip", data: { type: "Single", data: id } },
        }),
      target.id,
    );
  }
});

/** A learned OSC fader controls a rate master's persistent UID after its panel closes. */
test("OSC fader maps a rate master and survives panel closure", async ({
  page,
}, testInfo) => {
  await openMappingShow(page);
  await page.evaluate(() => {
    (window as any).appStores.dockApi.get().addPanel({
      id: "mapped-masters",
      component: "MastersPanel",
      title: "Mapped masters",
      params: {},
    });
  });
  await page
    .getByRole("button", { name: "New rate global", exact: true })
    .click();
  const fader = page.getByRole("slider", {
    name: "Playback Rate Master level",
    exact: true,
  });
  await expect(fader).toBeVisible();
  const target = await page.evaluate(() => {
    const stores = (window as any).appStores;
    const master = (Object.values(stores.masters.get()) as any[]).find(
      (master) => master.identifiers.label === "Playback Rate Master",
    );
    return {
      uid: master.identifiers.uid,
      initial: master.level_percent,
      port: stores.oscListenerStatus.get().port,
    };
  });
  await runMappingCommand(page, "Map OSC controller");
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).appStores.controllerLearning.get()?.surface,
      ),
    )
    .toBe("osc");
  await sendOscPulse(target.port);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).appStores.controllerLearning.get()?.captured?.gesture,
      ),
    )
    .toBe("Pulse");
  await expect(fader).toHaveAttribute("data-mapping-state", "waiting");
  await expect(
    page.locator("button[data-command-programmer-clear]").first(),
  ).toHaveAttribute("data-mapping-state", "compatible");
  const rejected = await page.evaluate(async (uid) => {
    const stores = (window as any).appStores;
    return stores.sendAndAwait({
      module: "OscCommand",
      command: {
        type: "BindLearned",
        data: {
          session_id: stores.controllerLearning.get().session_id,
          action: { id: "master.set-level", arguments: { master_uid: uid } },
        },
      },
    });
  }, target.uid);
  expect(rejected.outcome.data.code).toBe("osc.incompatible_input");
  await expect(
    page.getByRole("button", { name: "Cancel mapping", exact: true }),
  ).toBeVisible();
  await page.locator("button[data-command-programmer-clear]").first().click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).appStores.oscMappings
            .get()
            .find((mapping: any) => mapping.address === "/pulse")?.action.id,
      ),
    )
    .toBe("programmer.clear");
  await runMappingCommand(page, "Map OSC controller");
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).appStores.controllerLearning.get()?.surface,
      ),
    )
    .toBe("osc");
  await sendOscFader(target.port, Number.NaN);
  const unsupported = page.getByText(/This OSC message cannot be learned/);
  await expect(unsupported).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("unsupported-osc-input.png"),
  });
  await sendOscFader(target.port, 0.25);
  await expect(unsupported).not.toBeVisible();
  await expect(fader).toHaveAttribute("data-mapping-state", "compatible");
  await sendOscFader(target.port, 0.75);
  await fader.click({ position: { x: 5, y: 5 } });
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).appStores.controllerLearning.get()),
    )
    .toBeNull();
  await expect
    .poll(() =>
      page.evaluate(
        (uid) => (window as any).appStores.masters.get()[uid].level_percent,
        target.uid,
      ),
    )
    .toBe(target.initial);
  await sendOscFader(target.port, 0.75);
  await expect(fader).toHaveValue("150");
  await page.screenshot({
    path: testInfo.outputPath("osc-rate-master.png"),
    fullPage: true,
  });
  await page.evaluate(() =>
    (window as any).appStores.dockApi
      .get()
      .getPanel("mapped-masters")
      .api.close(),
  );
  await sendOscFader(target.port, 0.25);
  await expect
    .poll(() =>
      page.evaluate(
        (uid) => (window as any).appStores.masters.get()[uid].level_percent,
        target.uid,
      ),
    )
    .toBe(50);
});

/** Sends an absolute OSC float without depending on a stable UDP sender port. */
async function sendOscFader(port: number, value: number) {
  const packet = Buffer.alloc(20);
  packet.write("/learn/rate");
  packet.write(",f", 12);
  packet.writeFloatBE(value, 16);
  const socket = createSocket("udp4");
  try {
    await new Promise<void>((resolve, reject) =>
      socket.send(packet, port, "127.0.0.1", (error) =>
        error ? reject(error) : resolve(),
      ),
    );
  } finally {
    socket.close();
  }
}

/** Inserts a domain-owned deterministic action using its catalog entry and persistent clip UID. */
test("timeline picker saves catalog clip bindings", async ({
  page,
}, testInfo) => {
  await openMappingShow(page);
  const target = await page.evaluate(() => {
    const stores = (window as any).appStores;
    const timeline = Object.values(stores.timelines.get())[0] as any;
    const clip = (Object.values(stores.clips.get())[0] as any)[0];
    const api = stores.dockApi.get();
    api.addPanel({
      id: "catalog-timeline",
      component: "Timeline",
      title: "Catalog timeline",
      params: { initialTimelineUid: timeline.identifiers.uid },
    });
    for (const panel of [...api.panels]) {
      if (panel.id !== "catalog-timeline") panel.api.close();
    }
    return {
      uid: timeline.identifiers.uid,
      clipUid: clip.identifiers.uid,
      label: `${clip.identifiers.id}: ${clip.identifiers.label}`,
    };
  });
  const surface = page.locator(
    `[data-timeline-surface="true"][data-timeline-uid="${target.uid}"]`,
  );
  const lane = surface.locator('[data-timeline-track-lane="true"]').first();
  await expect(lane).toBeVisible();
  // The lane spans the entire timeline, including the horizontally clipped area.
  // Click inside the visible viewport beyond its sticky track labels.
  const labels = surface.locator('[data-timeline-track-label-column="true"]');
  await expect(labels).toBeVisible();
  const labelBounds = await labels.boundingBox();
  const laneBounds = await lane.boundingBox();
  if (!labelBounds || !laneBounds)
    throw new Error("Timeline track is not visible");
  await page.mouse.click(
    labelBounds.x + labelBounds.width + 80,
    laneBounds.y + 18,
  );
  await page.keyboard.press("i");
  const picker = page.locator('[data-component="InsertActionPicker"]');
  await picker.getByPlaceholder("Insert action...").fill("Go clip");
  await picker.getByRole("button", { name: /Go clip/ }).click();
  await expect(
    picker.getByPlaceholder(/Select target for Go clip/),
  ).toBeFocused();
  await picker.screenshot({
    path: testInfo.outputPath("catalog-clip-targets.png"),
  });
  await picker.getByRole("button", { name: target.label, exact: true }).click();
  await expect(picker).not.toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(({ uid, clipUid }) => {
        const timeline = (window as any).appStores.timelines.get()[uid];
        return timeline.tracks
          .flatMap((track: any) => track.actions)
          .some(
            (action: any) =>
              action.action.type === "RegisteredAction" &&
              action.action.data.id === "clip.go" &&
              action.action.data.arguments.target.type === "Uid" &&
              action.action.data.arguments.target.data === clipUid,
          );
      }, target),
    )
    .toBe(true);
  const edit = await page.evaluate(({ uid, clipUid }) => {
    const stores = (window as any).appStores;
    const action = stores.timelines
      .get()
      [uid].tracks.flatMap((track: any) => track.actions)
      .find(
        (action: any) =>
          action.action.type === "RegisteredAction" &&
          action.action.data.id === "clip.go",
      );
    const otherClip = (Object.values(stores.clips.get()) as any[])
      .map(([clip]) => clip)
      .find((clip) => clip.identifiers.uid !== clipUid);
    stores.dockApi.get().addPanel({
      id: "panel-PropertiesInspector",
      component: "PropertiesInspector",
      title: "Properties",
      params: {},
      position: { referencePanel: "catalog-timeline", direction: "right" },
    });
    return {
      actionId: action.id,
      nextUid: otherClip.identifiers.uid,
      nextId: otherClip.identifiers.id,
      nextLabel: `${otherClip.identifiers.id}: ${otherClip.identifiers.label}`,
    };
  }, target);
  const marker = surface.locator(
    `[data-timeline-action="true"][data-action-id="${edit.actionId}"]`,
  );
  await marker.click({ button: "right" });
  await expect(
    page.getByText(/Edit Clip .* Properties/, { exact: false }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await marker.click();
  const targetSelect = page.getByLabel("Action target", { exact: true });
  await expect(targetSelect).toBeVisible();
  await expect(targetSelect.locator("option:checked")).toHaveText(target.label);
  await targetSelect.selectOption({ label: edit.nextLabel });
  await expect
    .poll(() =>
      page.evaluate(
        ({ uid, actionId }) => {
          const action = (window as any).appStores.timelines
            .get()
            [uid].tracks.flatMap((track: any) => track.actions)
            .find((action: any) => action.id === actionId);
          return action.action.data.arguments.target.data;
        },
        { uid: target.uid, actionId: edit.actionId },
      ),
    )
    .toBe(edit.nextUid);
  await page.screenshot({
    path: testInfo.outputPath("registered-action-properties.png"),
    fullPage: true,
  });
  const deletion = await page.evaluate(
    (id) =>
      (window as any).appStores.sendAndAwait({
        module: "ClipCommand",
        command: { type: "DeleteClip", data: id },
      }),
    edit.nextId,
  );
  expect(deletion.outcome.type).toBe("Succeeded");
  const diagnostic = page
    .getByRole("status")
    .filter({ hasText: "Action unavailable" });
  await expect(diagnostic).toBeVisible();
  await expect(diagnostic).toContainText("does not exist");
  await page.screenshot({
    path: testInfo.outputPath("timeline-action-unavailable.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: /^Undo: Delete Clip/ }).click();
  await expect(diagnostic).not.toBeVisible();
});

/** Sends an argument-less OSC message through the native listener. */
async function sendOscPulse(port: number) {
  const packet = Buffer.alloc(12);
  packet.write("/pulse");
  packet.write(",", 8);
  const socket = createSocket("udp4");
  try {
    await new Promise<void>((resolve, reject) =>
      socket.send(packet, port, "127.0.0.1", (error) =>
        error ? reject(error) : resolve(),
      ),
    );
  } finally {
    socket.close();
  }
}

/** Sends a real OSC integer button packet to the isolated backend listener. */
async function sendOscButton(port: number, value: number) {
  const address = Buffer.alloc(16);
  address.write("/learn/clear");
  const packet = Buffer.alloc(address.length + 8);
  address.copy(packet);
  packet.write(",i", address.length);
  packet.writeInt32BE(value, address.length + 4);
  const socket = createSocket("udp4");
  try {
    await new Promise<void>((resolve, reject) =>
      socket.send(packet, port, "127.0.0.1", (error) =>
        error ? reject(error) : resolve(),
      ),
    );
  } finally {
    socket.close();
  }
}

/** Creates an isolated sample show and waits for its replacement backend world to resync. */
async function openMappingShow(page: Page) {
  await page.addInitScript(() =>
    window.localStorage.setItem(
      "nightfall.e2eAutoOpenStartupShowfile",
      "false",
    ),
  );
  await page.goto("/?e2e=1&startup:draftRecovery=false");
  await waitForDockviewApp(page);
  const initialGeneration = await page.evaluate(async () =>
    (await import("/lib/engine-runtime.ts")).resyncGeneration(),
  );
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await page.getByRole("button", { name: /New Showfile/ }).click();
  const dialog = page.getByRole("dialog", { name: "New Showfile" });
  await dialog.getByLabel("Show name").fill("OSC mapping test");
  await dialog.getByRole("checkbox", { name: "Include sample data" }).check();
  await dialog.getByRole("button", { name: "Create Show" }).click();
  await expect(dialog).not.toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(async () =>
        (await import("/lib/engine-runtime.ts")).resyncGeneration(),
      ),
    )
    .toBeGreaterThan(initialGeneration);
  await waitForDockviewApp(page);
  await expect
    .poll(() =>
      page.evaluate(
        () => Object.keys((window as any).appStores.fixtures.get()).length,
      ),
    )
    .toBeGreaterThan(0);
}

/** Learns a real OSC press without clearing during selection, then invokes the saved action. */
test("OSC press maps Clear Programmer and executes only on subsequent presses", async ({
  page,
}, testInfo) => {
  await openMappingShow(page);
  const selectionResult = await page.evaluate(async () => {
    const fixture = Object.values(
      (window as any).appStores.fixtures.get(),
    )[0] as any;
    return (window as any).appStores.sendAndAwait({
      module: "ProgrammerCommand",
      command: {
        type: "SetProgrammerSpatialSelection",
        data: {
          source: {
            type: "Resolved",
            data: [{ fixture_uid: fixture.identifiers.uid }],
          },
          clauses: [],
        },
      },
    });
  });
  expect(selectionResult.outcome).toEqual(
    expect.objectContaining({ type: "Succeeded" }),
  );
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).appStores.programmerSelection.get().length,
      ),
    )
    .toBeGreaterThan(0);
  const selection = await page.evaluate(() =>
    (window as any).appStores.programmerSelection.get(),
  );
  const port = await page.evaluate(
    () => (window as any).appStores.oscListenerStatus.get().port as number,
  );
  await runMappingCommand(page, "Map OSC controller");
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).appStores.controllerLearning.get()?.surface,
      ),
    )
    .toBe("osc");
  await sendOscButton(port, 1);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).appStores.controllerLearning.get()?.captured?.selector
            .address,
      ),
    )
    .toBe("/learn/clear");
  await sendOscButton(port, 0);
  const clear = page.locator("button[data-command-programmer-clear]").first();
  await expect(clear).toHaveAttribute("data-mapping-state", "compatible");
  await page.screenshot({
    path: testInfo.outputPath("osc-clear-ready.png"),
    fullPage: true,
  });
  await clear.click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).appStores.oscMappings
            .get()
            .find((mapping: any) => mapping.address === "/learn/clear")?.action
            .id,
      ),
    )
    .toBe("programmer.clear");
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).appStores.controllerLearning.get()),
    )
    .toBeNull();
  expect(
    await page.evaluate(() =>
      (window as any).appStores.programmerSelection.get(),
    ),
  ).toEqual(selection);
  const savedMapping = await page.evaluate(() =>
    (window as any).appStores.oscMappings
      .get()
      .find((mapping: any) => mapping.address === "/learn/clear"),
  );
  await page
    .getByRole("button", { name: "Undo: Map OSC controller", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).appStores.oscMappings
          .get()
          .some((mapping: any) => mapping.address === "/learn/clear"),
      ),
    )
    .toBe(false);
  await sendOscButton(port, 1);
  await sendOscButton(port, 0);
  expect(
    await page.evaluate(() =>
      (window as any).appStores.programmerSelection.get(),
    ),
  ).toEqual(selection);
  await page
    .getByRole("button", { name: "Redo: Map OSC controller", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).appStores.oscMappings
          .get()
          .find((mapping: any) => mapping.address === "/learn/clear"),
      ),
    )
    .toEqual(savedMapping);
  await page.screenshot({
    path: testInfo.outputPath("osc-clear-restored.png"),
    fullPage: true,
  });
  await sendOscButton(port, 1);
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).appStores.programmerSelection.get()),
    )
    .toEqual([]);
  await sendOscButton(port, 0);
});

/** The saved timeline target continues toggling the linked clock after its panel closes. */
test("learned timeline playback survives closing its panel", async ({
  page,
}, testInfo) => {
  await openMappingShow(page);
  const target = await page.evaluate(() => {
    const stores = (window as any).appStores;
    const timeline = Object.values(stores.timelines.get())[0] as any;
    stores.dockApi.get().addPanel({
      id: "mapped-timeline",
      component: "Timeline",
      title: "Mapped timeline",
      params: { initialTimelineUid: timeline.identifiers.uid },
    });
    return {
      uid: timeline.identifiers.uid,
      clock: timeline.timecode_uid,
      port: stores.oscListenerStatus.get().port,
    };
  });
  const play = page
    .locator(
      `[data-timeline-surface="true"][data-timeline-uid="${target.uid}"]:visible`,
    )
    .getByRole("button", { name: "Play timeline", exact: true });
  await expect(play).toBeVisible();
  await runMappingCommand(page, "Map OSC controller");
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).appStores.controllerLearning.get()?.surface,
      ),
    )
    .toBe("osc");
  await sendOscButton(target.port, 1);
  await expect(play).toHaveAttribute("data-mapping-state", "compatible");
  await sendOscButton(target.port, 0);
  await page.screenshot({
    path: testInfo.outputPath("timeline-mapping-ready.png"),
    fullPage: true,
  });
  await play.click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).appStores.controllerLearning.get()),
    )
    .toBeNull();
  await page.evaluate(() =>
    (window as any).appStores.dockApi
      .get()
      .getPanel("mapped-timeline")
      .api.close(),
  );
  try {
    await sendOscButton(target.port, 1);
    await expect
      .poll(() =>
        page.evaluate(
          (uid) =>
            (window as any).appStores.timecodes.get()[uid]?.[1]?.is_active,
          target.clock,
        ),
      )
      .toBe(true);
    await sendOscButton(target.port, 0);
    await sendOscButton(target.port, 1);
    await expect
      .poll(() =>
        page.evaluate(
          (uid) =>
            (window as any).appStores.timecodes.get()[uid]?.[1]?.is_active,
          target.clock,
        ),
      )
      .toBe(false);
  } finally {
    await page.evaluate(
      async (uid) =>
        (window as any).appStores.sendAndAwait({
          module: "TimelineTransportCommand",
          command: {
            type: "SetPlaying",
            data: { timeline_uid: uid, playing: false },
          },
        }),
      target.uid,
    );
    await sendOscButton(target.port, 0);
  }
});

for (const transport of ["MIDI", "OSC"]) {
  /** Learning starts and cancels through the backend without requiring physical hardware. */
  test(`${transport} learning arms and cancels without changing saved mappings`, async ({
    page,
  }, testInfo) => {
    await page.addInitScript(() => {
      window.localStorage.setItem(
        "nightfall.e2eAutoOpenStartupShowfile",
        "false",
      );
    });
    await page.goto("/?e2e=1&startup:draftRecovery=false");
    await waitForDockviewApp(page);
    await expect(page.locator("main#app")).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const stores = (window as any).appStores;
          return stores?.actionCatalog?.get();
        }),
      )
      .toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "control.go" })]),
      );
    const before = await page.evaluate(() =>
      JSON.stringify([
        (window as any).appStores.midiMappings.get(),
        (window as any).appStores.oscMappings.get(),
      ]),
    );
    await page
      .getByRole("button", { name: `Map ${transport}`, exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Cancel mapping", exact: true }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as any).appStores.controllerLearning.get()?.surface,
        ),
      )
      .toBe(transport.toLowerCase());
    await page.screenshot({
      path: testInfo.outputPath("controller-learning-armed.png"),
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "Cancel mapping", exact: true })
      .click();
    await expect
      .poll(() =>
        page.evaluate(() => (window as any).appStores.controllerLearning.get()),
      )
      .toBeNull();
    await expect(
      page.getByRole("button", { name: `Map ${transport}`, exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(() =>
        JSON.stringify([
          (window as any).appStores.midiMappings.get(),
          (window as any).appStores.oscMappings.get(),
        ]),
      ),
    ).toBe(before);
  });
}

/** Executes learning commands through the same palette entry points available to operators. */
async function runMappingCommand(page: Page, name: string) {
  await page
    .getByRole("button", { name: "Open command palette", exact: true })
    .click();
  const input = page.getByPlaceholder("Type a command or search...");
  await input.fill(name);
  await page.getByText(name, { exact: true }).click();
  await expect(input).not.toBeVisible();
}

for (const transport of ["OSC", "MIDI"] as const) {
  /** Learning updates a mounted mapping table and remains visible when that panel is reopened. */
  test(`${transport} learned mappings appear in the mapping panel`, async ({
    page,
  }, testInfo) => {
    const controller =
      transport === "MIDI" ? await startMidiController() : undefined;
    try {
      await openMappingShow(page);
      await page.evaluate((transport) => {
        const api = (window as any).appStores.dockApi.get();
        api.addPanel({
          id: "learned-mappings",
          component: transport === "OSC" ? "OscInput" : "MidiInput",
          title: "Learned mappings",
          params: {},
          position: { direction: "right" },
        });
        for (const panel of [...api.panels])
          if (panel.id !== "learned-mappings") panel.api.close();
      }, transport);
      await expect(
        page.getByRole("button", { name: `Map ${transport}`, exact: true }),
      ).toHaveCount(0);
      await runMappingCommand(page, `Map ${transport} controller`);
      const status = page.getByRole("region", {
        name: "Controller mapping",
        exact: true,
      });
      await expect(status).toContainText(`${transport} learning active`);
      if (transport === "OSC") {
        // Verify activity survives the ordinary four-second notification expiry.
        await page.waitForTimeout(4500);
        await expect(status).toBeVisible();
      }
      await expect
        .poll(async () => (await status.boundingBox())?.y ?? -1)
        .toBeGreaterThanOrEqual(14);
      if (controller) {
        await expect
          .poll(() =>
            page.evaluate(
              (name) =>
                (window as any).appStores.midiDevices
                  .get()
                  .some((device: any) => device.name.includes(name)),
              controller.name,
            ),
          )
          .toBe(true);
        controller.send(0x90, 61, 127);
      } else {
        const port = await page.evaluate(
          () => (window as any).appStores.oscListenerStatus.get().port,
        );
        await sendOscButton(port, 1);
      }
      const clear = page
        .getByRole("button", { name: "Clear programmer", exact: true })
        .first();
      await expect(clear).toHaveAttribute("data-mapping-state", "compatible");
      await page.screenshot({
        path: testInfo.outputPath("learning-active.png"),
        fullPage: true,
      });
      await clear.click();
      await expect(status).not.toBeVisible();
      await expect
        .poll(() =>
          page.evaluate((transport) => {
            const stores = (window as any).appStores;
            return (
              transport === "OSC" ? stores.oscMappings : stores.midiMappings
            )
              .get()
              .some((mapping: any) => mapping.action.id === "programmer.clear");
          }, transport),
        )
        .toBe(true);
      await expect(
        page.getByRole("gridcell", { name: "programmer.clear", exact: true }),
      ).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath("learned-mapping-row.png"),
        fullPage: true,
      });
      await page.evaluate(() => {
        const api = (window as any).appStores.dockApi.get();
        api.addPanel({
          id: "mapping-controls",
          component: "ClipList",
          title: "Controls",
          params: {},
        });
        api.getPanel("learned-mappings").api.close();
      });
      await expect(
        page.getByRole("tab", { name: "Learned mappings", exact: true }),
      ).not.toBeVisible();
      await runMappingCommand(page, `Open ${transport} Input`);
      await expect(
        page.getByRole("gridcell", { name: "programmer.clear", exact: true }),
      ).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath("reopened-mapping-row.png"),
        fullPage: true,
        animations: "disabled",
      });
      await runMappingCommand(page, `Map ${transport} controller`);
      await expect(status).toBeVisible();
      await status
        .getByRole("button", { name: "Cancel mapping", exact: true })
        .click();
      await expect(status).not.toBeVisible();
      await expect(clear).toHaveAttribute("data-mapping-state", "inactive");
      await runMappingCommand(page, `Map ${transport} controller`);
      await runMappingCommand(page, "Cancel controller mapping");
      await expect(status).not.toBeVisible();
    } finally {
      await controller?.close();
    }
  });
}
