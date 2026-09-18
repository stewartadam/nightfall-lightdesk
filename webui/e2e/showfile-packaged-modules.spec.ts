// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prepareFreshBackendShowfile } from "./backend-showfile";
import { expect, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

/** The real backend catalog lets users create FX definitions from show-local modules without an installed library. */
test("creates module FX from the active show's packaged modules", async ({
  page,
  backendSlot,
}, testInfo) => {
  await prepareFreshBackendShowfile(backendSlot.backendPort);
  await page.goto("/?e2e=1");
  await waitForDockviewApp(page);
  const saved = await page.evaluate(() =>
    (window as any).appStores.sendAndAwait({
      module: "DeskCommand",
      command: {
        type: "SaveNamedShowfile",
        data: { name: "packaged-modules", options: {} },
      },
    }),
  );
  expect(saved.outcome.type).toBe("Succeeded");
  const show = join(
    backendSlot.dataDir,
    "drafts",
    "packaged-modules.nightfall-show",
  );
  for (const root of [backendSlot.dataDir, show]) {
    const modules = join(root, "fx-modules");
    if (existsSync(modules))
      renameSync(modules, join(root, "unused-fx-modules"));
  }
  mkdirSync(join(show, "fx-modules"));
  // Discovery and stored FX creation use filenames; playback is covered by the runtime tests.
  writeFileSync(join(show, "fx-modules/local-only.wasm"), new Uint8Array());
  await page.getByRole("button", { name: "Open command palette" }).click();
  await page.getByPlaceholder("Type a command or search...").fill("FX List");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Add effect" }).click();
  await page.getByRole("button", { name: "Module FX", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add Module FX" });
  await expect(dialog.getByLabel("Module").locator("option")).toHaveText([
    "local-only",
  ]);
  await expect(dialog.getByLabel("Module")).toHaveValue("local-only");
  await expect(
    dialog.getByText("No WebAssembly modules found", { exact: false }),
  ).toHaveCount(0);
  await dialog.getByRole("textbox", { name: "ID", exact: true }).fill("9876");
  await dialog
    .getByRole("textbox", { name: "Label", exact: true })
    .fill("Packaged Module FX");
  await expect(
    dialog.getByRole("button", { name: "Create", exact: true }),
  ).toBeEnabled();
  await page.screenshot({
    path: testInfo.outputPath("packaged-module-dialog.png"),
  });
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const modules = Object.values(
          (window as any).appStores.fxModules.get(),
        ) as any[];
        return modules.find((module) => module.identifiers.id === 9876)
          ?.module_name;
      }),
    )
    .toBe("local-only");
  const created = page.getByRole("button", {
    name: /9876: Packaged Module FX/i,
  });
  await created.scrollIntoViewIfNeeded();
  await expect(created).toBeInViewport();
  await page.screenshot({
    path: testInfo.outputPath("packaged-module-created.png"),
  });
});
