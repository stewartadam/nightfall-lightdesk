// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { prepareFreshBackendShowfile } from "./backend-showfile";
import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

/** Read the backend-owned assignment bank and button modes after websocket synchronization. */
async function assignments(page: Page) {
  return page.evaluate(() =>
    (window as any).appStores.faders.get().map((fader: any) => ({
      clip: fader.assigned_clip_id,
      master: fader.assigned_master_id,
      buttonMode: fader.button_mode,
    })),
  );
}

/** Sends one fader command and returns its backend outcome type. */
async function sendFaderCommand(page: Page, command: object) {
  const result = await page.evaluate(
    (command) =>
      (window as any).appStores.sendAndAwait({
        module: "FaderCommand",
        command,
      }),
    command,
  );
  return result.outcome.type;
}

/**
 * Save an edited bank, clear it, and verify loading restores assignments, button modes and
 * visible faders.
 */
test("fader assignments survive saving and loading a showfile", async ({
  page,
  backendSlot,
}, testInfo) => {
  test.setTimeout(90_000);
  await prepareFreshBackendShowfile(backendSlot.backendPort);
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto("/?e2e=1&startup:draftRecovery=false");
  await waitForDockviewApp(page);
  await expect
    .poll(() =>
      page.evaluate(
        () => Object.keys((window as any).appStores.clips.get()).length,
      ),
    )
    .toBe(0);
  const setup = await page.evaluate(async () => {
    const stores = (window as any).appStores;
    const uid = crypto.randomUUID().replaceAll("-", "");
    const fx = await stores.sendAndAwait({
      module: "FxCommand",
      command: {
        type: "StoreFx",
        data: {
          identifiers: { uid, id: 2, label: "Fader Test FX" },
          selection: { source: { type: "Resolved", data: [] }, clauses: [] },
          attributes: {},
        },
      },
    });
    const clip = await stores.sendAndAwait({
      module: "ClipCommand",
      command: {
        type: "StoreClip",
        data: {
          identifiers: {
            uid: crypto.randomUUID().replaceAll("-", ""),
            id: 2,
            label: "Saved fader clip",
          },
          source: { type: "Fx", data: uid },
          priority: 0,
          options: { auto_release: false, deactivate_on_sequence_end: false },
        },
      },
    });
    return [fx.outcome.type, clip.outcome.type];
  });
  expect(setup).toEqual(["Succeeded", "Succeeded"]);

  const result = await page.evaluate(async () => {
    const stores = (window as any).appStores;
    return stores.sendAndAwait({
      module: "FaderCommand",
      command: { type: "AssignClip", data: { fader_index: 1, clip_id: 2 } },
    });
  });
  expect(result.outcome.type).toBe("Succeeded");
  expect(
    await sendFaderCommand(page, {
      type: "SetButtonMode",
      data: { fader_index: 1, mode: "Toggle" },
    }),
  ).toBe("Succeeded");
  await expect
    .poll(async () => (await assignments(page))[0])
    .toEqual({ clip: 2, master: null, buttonMode: "Toggle" });
  const expected = await assignments(page);
  const saved = await page.evaluate(() =>
    (window as any).appStores.sendAndAwait({
      module: "DeskCommand",
      command: {
        type: "SaveNamedShowfile",
        data: "fader-roundtrip",
      },
    }),
  );
  expect(saved.outcome.type).toBe("Succeeded");
  const savedDirectory = join(
    backendSlot.dataDir,
    "fader-roundtrip.nightfall-show",
  );
  const compressed = readFileSync(join(savedDirectory, "showfile.json.gz"));
  expect([...compressed.subarray(0, 2)]).toEqual([0x1f, 0x8b]);
  expect(existsSync(join(savedDirectory, "showfile.json"))).toBe(false);
  const persisted = JSON.parse(gunzipSync(compressed).toString("utf8"));
  const response = await page.request.get(
    "/api/showfiles/current/showfile.json",
  );
  expect(response.ok()).toBe(true);
  expect(persisted.faders).toBeDefined();
  expect((await response.json()).faders).toEqual(persisted.faders);
  const cleared = await page.evaluate(() =>
    (window as any).appStores.sendAndAwait({
      module: "FaderCommand",
      command: { type: "ClearClip", data: { fader_index: 1 } },
    }),
  );
  expect(cleared.outcome.type).toBe("Succeeded");
  expect(
    await sendFaderCommand(page, {
      type: "SetButtonMode",
      data: { fader_index: 1, mode: "Go" },
    }),
  ).toBe("Succeeded");
  await expect
    .poll(async () => (await assignments(page))[0])
    .toEqual({ clip: null, master: null, buttonMode: "Go" });
  await page.evaluate(() =>
    (window as any).appStores.send({
      module: "DeskCommand",
      command: { type: "LoadNamedShowfile", data: "fader-roundtrip" },
    }),
  );
  await expect
    .poll(() => assignments(page), { timeout: 30_000 })
    .toEqual(expected);
  await page.getByRole("button", { name: "Open command palette" }).click();
  await page.getByPlaceholder("Type a command or search...").fill("Open Clips");
  await page.keyboard.press("Enter");
  const fader = page.locator('[data-fader-index="1"]');
  await expect(fader).toBeVisible();
  const label = await page.evaluate(() => {
    const clips = Object.values((window as any).appStores.clips.get()) as any[];
    return clips.find(([clip]) => clip.identifiers.id === 2)[0].identifiers
      .label;
  });
  await expect(fader.getByText(label, { exact: true })).toBeVisible();
  await expect(fader.locator(".noUi-handle")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("restored-faders.png") });
});
