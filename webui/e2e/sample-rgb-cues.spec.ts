// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "./playwright-fixtures";

/** Checks persisted sample RGB values, removed examples, and visible clip names. */
test("sample RGB cues have the requested values and labels", async ({
  page,
  backendSlot,
}, testInfo) => {
  await page.addInitScript(() => {
    window.localStorage.removeItem("nightfall.e2eAutoOpenStartupShowfile");
  });
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await page
    .getByRole("dialog", { name: "Open Showfile", exact: true })
    .getByRole("button", { name: "New showfile" })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "New Showfile",
    exact: true,
  });
  await dialog.getByLabel("Show name").fill("RGB Samples");
  await dialog.getByRole("checkbox", { name: "Include sample data" }).check();
  await dialog.getByRole("button", { name: "Create Show" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => Object.keys((window as any).appStores.clips.get()).length,
      ),
    )
    .toBeGreaterThan(0);
  const snapshot = JSON.parse(
    readFileSync(
      join(
        backendSlot.dataDir,
        "drafts/RGB Samples.nightfall-show/showfile.json",
      ),
      "utf8",
    ),
  );
  expect(snapshot.clips.some((clip: any) => clip.identifiers.id === 9)).toBe(
    false,
  );
  expect(
    snapshot.sequences.some((sequence: any) => sequence.identifiers.id === 4),
  ).toBe(false);
  for (const [uid, values] of [
    ["5011047c-c1bb-4564-b621-d0da95587776", [0.5, 0, 0]],
    ["358919fa-b6b0-47ec-85c8-47298389bc41", [0, 0.5, 0]],
    ["9de3fae8-77ac-4a60-82cb-cdd4dba72cbd", [0, 0.5, 0]],
  ] as const) {
    const cue = snapshot.cues.find(
      (cue: any) =>
        cue.identifiers.uid.replaceAll("-", "") === uid.replaceAll("-", ""),
    );
    const attributes = cue.instructions[0].cue_instruction.values;
    expect([attributes.Red, attributes.Green, attributes.Blue]).toEqual(
      values.map((value) => ({
        type: "Inline",
        data: { type: "AbsolutePercent", data: { value } },
      })),
    );
  }
  await page.getByRole("button", { name: "Open command palette" }).click();
  await page.getByPlaceholder("Type a command or search...").fill("Open Clips");
  await page.keyboard.press("Enter");
  for (const label of [
    "RGB cycle (full)",
    "RGB cycle (half)",
    "RGB cycle (-50% rel.)",
  ]) {
    await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
  }
  await page.screenshot({
    path: testInfo.outputPath("sample-rgb-clips.png"),
    animations: "disabled",
  });
});
