// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

test.use({ sampleDataOnly: true });

/** Exercises inline overwrite authorization, owner changes, and complete configuration resets. */
test("clip creation requires Alt to overwrite the current owner", async ({
  page,
}, testInfo) => {
  await page.addInitScript(() =>
    localStorage.removeItem("nightfall.e2eAutoOpenStartupShowfile"),
  );
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
  await page.waitForFunction(() =>
    Object.values((window as any).appStores?.sequences?.get() ?? {}).some(
      (sequence: any) => sequence.identifiers.id === 1,
    ),
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
  const seeded = await page.evaluate(
    () =>
      (Object.values((window as any).appStores.clips.get()) as any[]).find(
        ([clip]) => clip.identifiers.id === 50,
      )[0],
  );
  seeded.priority = 7;
  seeded.options = { auto_release: false, deactivate_on_sequence_end: true };
  await page.evaluate(
    (clip) =>
      (window as any).appStores.sendAndAwait({
        module: "ClipCommand",
        command: { type: "StoreClip", data: clip },
      }),
    seeded,
  );
  await expect
    .poll(() =>
      page.evaluate(
        (uid) => (window as any).appStores.clips.get()[uid][0],
        seeded.identifiers.uid,
      ),
    )
    .toEqual(seeded);
  const original = seeded;
  await page.keyboard.press(
    process.platform === "darwin" ? "Meta+Shift+P" : "Control+Shift+P",
  );
  const palette = page.getByPlaceholder("Type a command or search...");
  await palette.fill("Open Clips");
  await palette.press("Enter");
  await page.getByRole("button", { name: "Add clip", exact: true }).click();
  const create = page.getByRole("dialog", { name: "Create clip" });
  await expect(
    create.getByRole("button", { name: "Create", exact: true }),
  ).toBeEnabled();
  await create.getByLabel("Label", { exact: true }).fill("Replacement");
  await create.getByLabel("ID", { exact: true }).fill("50");
  const overwrite = create.getByRole("button", {
    name: "Overwrite",
    exact: true,
  });
  await expect(overwrite).toBeDisabled();
  await create.getByLabel("Label", { exact: true }).press("Enter");
  await expect(create).toBeVisible();
  await create.getByRole("button", { name: "ID already exists" }).hover();
  await expect(page.getByRole("tooltip")).toContainText(
    "Hold Alt and click Overwrite",
  );
  await page.screenshot({
    path: testInfo.outputPath("clip-overwrite-warning.png"),
  });
  await page.keyboard.down("Alt");
  await expect(overwrite).toBeEnabled();
  await page.keyboard.up("Alt");
  await expect(overwrite).toBeDisabled();
  await page.keyboard.down("Alt");
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(overwrite).toBeDisabled();
  await page.keyboard.up("Alt");
  await create.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(
    await page.evaluate(
      (uid) => (window as any).appStores.clips.get()[uid][0],
      original.identifiers.uid,
    ),
  ).toEqual(original);
  await page.getByRole("button", { name: "Add clip", exact: true }).click();
  await create.getByLabel("Label", { exact: true }).fill("Replacement");
  await create.getByLabel("ID", { exact: true }).fill("50");
  await page.keyboard.down("Alt");
  await expect(overwrite).toBeEnabled();
  const replacement = {
    ...original,
    identifiers: {
      ...original.identifiers,
      uid: crypto.randomUUID().replaceAll("-", ""),
      label: "New owner",
    },
  };
  await page.evaluate(async (clip) => {
    const stores = (window as any).appStores;
    await stores.sendAndAwait({
      module: "ClipCommand",
      command: { type: "DeleteClip", data: 50 },
    });
    await stores.sendAndAwait({
      module: "ClipCommand",
      command: { type: "StoreClip", data: clip },
    });
  }, replacement);
  await expect
    .poll(() =>
      page.evaluate(
        (uid) => (window as any).appStores.clips.get()[uid]?.[0],
        replacement.identifiers.uid,
      ),
    )
    .toEqual(replacement);
  await expect(overwrite).toBeDisabled();
  await page.keyboard.up("Alt");
  await page.keyboard.down("Alt");
  await expect(overwrite).toBeEnabled();
  await page.mouse.move(0, 0);
  await page.screenshot({
    path: testInfo.outputPath("clip-overwrite-enabled.png"),
  });
  await overwrite.click();
  await page.keyboard.up("Alt");
  await expect(create).not.toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        (uid) =>
          (window as any).appStores.clips.get()[uid][0].identifiers.label,
        replacement.identifiers.uid,
      ),
    )
    .toBe("Replacement");
  const updated = await page.evaluate(
    (uid) => (window as any).appStores.clips.get()[uid][0],
    replacement.identifiers.uid,
  );
  expect(updated.identifiers.uid).toBe(replacement.identifiers.uid);
  expect(updated.identifiers.label).toBe("Replacement");
  expect(updated.source == null).toBe(true);
  expect(updated.priority).toBe(0);
  expect(updated.options).toEqual({
    auto_release: true,
    deactivate_on_sequence_end: false,
  });
});
