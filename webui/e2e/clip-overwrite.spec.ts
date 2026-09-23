// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

test.use({ sampleDataOnly: true });

/** Confirms duplicate clip creation preserves identity and cancellation leaves its source intact. */
test("clip creation confirms overwriting an existing ID", async ({
  page,
}, testInfo) => {
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  await page.waitForFunction(
    () =>
      Object.keys((window as any).appStores?.fixtures?.get() ?? {}).length ===
      56,
  );
  const input = page.locator("#header-cmdline");
  await input.fill("store clip 50");
  await input.press("Enter");
  await expect
    .poll(() =>
      page.evaluate(() =>
        (Object.values((window as any).appStores.clips.get()) as any[]).some(
          ([clip]) => clip.identifiers.id === 50,
        ),
      ),
    )
    .toBe(true);
  await input.fill("set clip 50 target=sequence 1");
  await input.press("Enter");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (Object.values((window as any).appStores.clips.get()) as any[]).find(
            ([clip]) => clip.identifiers.id === 50,
          )?.[0].source?.type,
      ),
    )
    .toBe("Sequence");
  const original = await page.evaluate(
    () =>
      (Object.values((window as any).appStores.clips.get()) as any[]).find(
        ([clip]) => clip.identifiers.id === 50,
      )[0],
  );
  await page.keyboard.press(
    process.platform === "darwin" ? "Meta+Shift+P" : "Control+Shift+P",
  );
  const palette = page.getByPlaceholder("Type a command or search...");
  await palette.fill("Open Clips");
  await palette.press("Enter");
  await page.getByRole("button", { name: "Add clip", exact: true }).click();
  const create = page.getByRole("dialog", { name: "Create clip" });
  await create.getByLabel("Label", { exact: true }).fill("Replacement");
  await create.getByLabel("ID", { exact: true }).fill("50");
  await create.getByRole("button", { name: "Create", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "Overwrite clip?" });
  await expect(confirm).toBeVisible();
  await expect(confirm.locator(":scope > div")).toHaveCSS("opacity", "1");
  await page.screenshot({
    path: testInfo.outputPath("clip-overwrite-confirmation.png"),
  });
  await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(create.getByLabel("ID", { exact: true })).toHaveValue("50");
  expect(
    await page.evaluate(
      (uid) => (window as any).appStores.clips.get()[uid][0],
      original.identifiers.uid,
    ),
  ).toEqual(original);
  await create.getByRole("button", { name: "Create", exact: true }).click();
  await confirm.getByRole("button", { name: "Overwrite", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        (uid) =>
          (window as any).appStores.clips.get()[uid][0].identifiers.label,
        original.identifiers.uid,
      ),
    )
    .toBe("Replacement");
  const updated = await page.evaluate(
    (uid) => (window as any).appStores.clips.get()[uid][0],
    original.identifiers.uid,
  );
  expect(updated.identifiers.uid).toBe(original.identifiers.uid);
  expect(updated.identifiers.label).toBe("Replacement");
  expect(updated.source == null).toBe(true);
});
