// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

/** Creates sample data from startup, checks its draft, and verifies the next new show defaults empty. */
test("new show optionally includes standalone sample data", async ({
  page,
  backendSlot,
}, testInfo) => {
  await page.addInitScript(() => {
    window.localStorage.removeItem("nightfall.e2eAutoOpenStartupShowfile");
  });
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  const picker = page.getByRole("dialog", {
    name: "Open Showfile",
    exact: true,
  });
  await expect(picker).toBeVisible();
  await picker.getByRole("button", { name: "New showfile" }).click();
  const dialog = page.getByRole("dialog", {
    name: "New Showfile",
    exact: true,
  });
  const samples = dialog.getByRole("checkbox", { name: "Include sample data" });
  await expect(samples).not.toBeChecked();
  await dialog.getByLabel("Show name").fill("Sample Tour");
  await samples.check();
  await page.screenshot({ path: testInfo.outputPath("new-show-samples.png") });
  await dialog.getByRole("button", { name: "Create Show" }).click();
  await waitForDockviewApp(page);
  await expect
    .poll(() =>
      page.evaluate(
        () => Object.keys((window as any).appStores.fixtures.get()).length,
      ),
    )
    .toBeGreaterThan(0);
  const snapshot = JSON.parse(
    readFileSync(
      join(
        backendSlot.dataDir,
        "drafts",
        "Sample Tour.nightfall-show",
        "showfile.json",
      ),
      "utf8",
    ),
  );
  expect(snapshot.fixtures).toHaveLength(56);
  expect(snapshot.sceneObjects).toHaveLength(3);
  expect(snapshot.bindings.output).toEqual([]);
  expect(snapshot.bindings.disabled).toHaveLength(56);
  expect(
    snapshot.sceneObjects.every(
      (object: any) =>
        object.properties.type === "StageElement" &&
        !object.properties.data.modelPath,
    ),
  ).toBe(true);
  expect(snapshot.timelines.length).toBeGreaterThan(0);
  for (const timeline of snapshot.timelines) {
    expect(timeline.audio_enabled).toBe(true);
    const audioPath = timeline.audio_path as string;
    expect(audioPath).toMatch(/^timeline-audio\/[a-f0-9]+\/(lofi|rap)\.mp3$/);
    const bundledAudio = readFileSync(
      join("crates/app/assets/sample-audio", audioPath.split("/").at(-1)!),
    );
    const installedAudio = readFileSync(
      join(backendSlot.dataDir, "drafts/Sample Tour.nightfall-show", audioPath),
    );
    expect(installedAudio.equals(bundledAudio)).toBe(true);
    const response = await page.request.get(
      `/api/showfiles/current/${audioPath}`,
    );
    expect(response.ok()).toBe(true);
    expect((await response.body()).equals(bundledAudio)).toBe(true);
  }
  expect(
    snapshot.fixtures.every((fixture: any) => !fixture.library_asset_etag),
  ).toBe(true);
  expect(snapshot.fxModule).toEqual([]);
  for (const id of [4, 5, 29]) {
    expect(snapshot.clips.some((clip: any) => clip.identifiers.id === id)).toBe(
      false,
    );
  }
  expect(
    snapshot.fx.some((fx: any) => [1, 2].includes(fx.identifiers.id)),
  ).toBe(false);
  expect(
    snapshot.sequences.some((sequence: any) => sequence.identifiers.id === 29),
  ).toBe(false);

  await expect
    .poll(() =>
      page.evaluate(() =>
        localStorage.getItem("nightfall.currentShowfileName"),
      ),
    )
    .toBe("Sample Tour");

  await page.getByRole("button", { name: "Open command palette" }).click();
  await page.getByPlaceholder("Type a command or search...").fill("Open Patch");
  await page.keyboard.press("Enter");
  const patch = page.locator('[data-panel-kind="patch"]:visible');
  await expect(
    patch.getByRole("button", { name: "Add fixture", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("sample-show-patch.png"),
    animations: "disabled",
  });

  await page.getByRole("button", { name: "Open command palette" }).click();
  await page
    .getByPlaceholder("Type a command or search...")
    .fill("Open Visualizer");
  await page.keyboard.press("Enter");
  const visualizer = page.locator('[data-panel-id="panel-Visualizer"]');
  await expect(visualizer).toBeVisible();
  await expect(visualizer.locator("canvas")).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () => Object.keys((window as any).appStores.sceneObjects.get()).length,
      ),
    )
    .toBe(3);
  await page.screenshot({
    path: testInfo.outputPath("sample-show-arrangement.png"),
    animations: "disabled",
  });

  const saveResult = await page.evaluate(() =>
    (window as any).appStores.sendAndAwait({
      module: "DeskCommand",
      command: { type: "SaveShowfile", data: {} },
    }),
  );
  expect(saveResult.outcome.type).toBe("Succeeded");
  for (const timeline of snapshot.timelines) {
    expect(
      readFileSync(
        join(
          backendSlot.dataDir,
          "Sample Tour.nightfall-show",
          timeline.audio_path,
        ),
      ).length,
    ).toBeGreaterThan(0);
  }

  await page.getByTitle("Menu", { exact: true }).click();
  await page.getByRole("button", { name: /New Showfile/ }).click();
  await expect(samples).not.toBeChecked();
  await samples.check();
  await page.screenshot({
    path: testInfo.outputPath("new-show-menu.png"),
    animations: "disabled",
  });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByTitle("Menu", { exact: true }).click();
  await page.getByRole("button", { name: /New Showfile/ }).click();
  await expect(samples).not.toBeChecked();
  await dialog.getByLabel("Show name").fill("Empty Tour");
  await dialog.getByRole("button", { name: "Create Show" }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        localStorage.getItem("nightfall.currentShowfileName"),
      ),
    )
    .toBe("Empty Tour");
  await expect
    .poll(() =>
      page.evaluate(
        () => Object.keys((window as any).appStores.fixtures.get()).length,
      ),
    )
    .toBe(0);
  const empty = JSON.parse(
    readFileSync(
      join(
        backendSlot.dataDir,
        "drafts",
        "Empty Tour.nightfall-show",
        "showfile.json",
      ),
      "utf8",
    ),
  );
  expect(empty.fixtures).toEqual([]);
  expect(empty.timelines).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("new-show-empty.png") });
});
