// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, test } from "./playwright-fixtures";

/** Verifies settings tabs keep selects styled and editor settings isolated from General. */
test("settings select styling stays browser-specific", async ({
  browserName,
  page,
}) => {
  await page.goto("/?e2e=1");

  await expect(page.locator("button[title='Menu']")).toBeVisible();
  await page.locator("button[title='Menu']").click();
  await page.getByRole("button", { name: "Settings" }).click();

  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();

  const select = dialog.getByLabel("Selection flatten behavior");
  await expect(select).toBeVisible();
  const backupRetentionInput = dialog.getByLabel("Backups to keep");
  await expect(backupRetentionInput).toBeVisible();
  await expect(backupRetentionInput).toHaveAttribute("min", "0");
  await expect(dialog.getByText("Cue / Sequence Authoring")).toBeHidden();
  await expect(dialog.getByLabel("Insert and paste position")).toBeHidden();

  await dialog.getByRole("tab", { name: "Editors" }).click();
  await expect(dialog.getByText("Cue / Sequence Authoring")).toBeVisible();
  const timelinePlacementSelect = dialog.getByLabel(
    "Insert and paste position",
  );
  await expect(timelinePlacementSelect).toBeVisible();
  await expect(timelinePlacementSelect).toHaveValue("Playhead");

  await dialog.getByRole("tab", { name: "General" }).click();
  await expect(select).toBeVisible();

  const styles = await select.evaluate((element) => {
    const computed = window.getComputedStyle(element as HTMLSelectElement);
    return {
      appearance: computed.appearance,
      backgroundImage: computed.backgroundImage,
      paddingRight: computed.paddingRight,
    };
  });

  if (browserName === "webkit") {
    expect(styles.appearance).toBe("none");
    expect(styles.backgroundImage).not.toBe("none");
    expect(Number.parseFloat(styles.paddingRight)).toBeGreaterThanOrEqual(32);
    return;
  }

  expect(styles.backgroundImage).toBe("none");
});

/** Verifies settings network controls show interface friendly names with system names and IPs. */
test("settings network interface list shows friendly names", async ({
  page,
}) => {
  await page.goto("/?e2e=1");

  await expect(page.locator("main#app")).toBeVisible();
  await page.waitForFunction(() =>
    Boolean((window as any).appStores?.availableNetworkInterfaces),
  );

  await expect(page.locator("button[title='Menu']")).toBeVisible();
  await page.locator("button[title='Menu']").click();
  await page.getByRole("button", { name: "Settings" }).click();

  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("tab", { name: "Network" }).click();

  const expectedText = [
    "System Default (Wi-Fi (en0, 192.168.1.44))",
    "USB 2.5G LAN (en7, 2.0.0.10)",
    "Configured interface: USB 2.5G LAN (en7, 2.0.0.10)",
    "System default interface: Wi-Fi (en0, 192.168.1.44)",
  ];
  await expect
    .poll(async () =>
      page.evaluate(async (expected) => {
        const stores = (window as any).appStores;
        stores.availableNetworkInterfaces.set([
          {
            name: "en0",
            friendly_name: "Wi-Fi",
            addresses: ["192.168.1.44"],
          },
          {
            name: "en7",
            friendly_name: "USB 2.5G LAN",
            addresses: ["2.0.0.10"],
          },
        ]);
        stores.networkInterfaceStatus.set({
          default_interface: {
            name: "en0",
            friendly_name: "Wi-Fi",
            addresses: ["192.168.1.44"],
          },
          current_interface: {
            name: "en7",
            friendly_name: "USB 2.5G LAN",
            addresses: ["2.0.0.10"],
          },
          current_interface_mode: "SelectedInterface",
          selected_interface_missing: false,
        });
        stores.ioSettings.set({
          ...stores.ioSettings.get(),
          network_interface: "en7",
        });
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );
        const settingsDialog = document.querySelector(
          '[role="dialog"][aria-label="Settings"]',
        );
        const text = settingsDialog?.textContent ?? "";
        return expected.every((item) => text.includes(item));
      }, expectedText),
    )
    .toBe(true);
});

/** Verifies the stale input timeout control remains visible while signal-loss policy is Hold. */
test("settings stale input timeout remains visible for hold policy", async ({
  page,
}) => {
  await page.goto("/?e2e=1");

  await expect(page.locator("main#app")).toBeVisible();
  await page.waitForFunction(() =>
    Boolean((window as any).appStores?.ioSettings),
  );
  await page.evaluate(() => {
    const stores = (window as any).appStores;
    stores.ioSettings.set({
      ...stores.ioSettings.get(),
      input_signal_loss_policy: { type: "Hold" },
      input_signal_loss_timeout: { secs: 3, nanos: 0 },
    });
  });

  await expect(page.locator("button[title='Menu']")).toBeVisible();
  await page.locator("button[title='Menu']").click();
  await page.getByRole("button", { name: "Settings" }).click();

  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("tab", { name: "Network" }).click();

  await expect(dialog.getByLabel("Input signal loss policy")).toHaveValue(
    "Hold",
  );
  const timeoutInput = dialog.getByLabel("Input stale timeout (ms)");
  await expect(timeoutInput).toBeVisible();
  await expect
    .poll(async () => {
      const inputValue = await timeoutInput.inputValue();
      const storeValue = await page.evaluate(() => {
        const timeout = (window as any).appStores.ioSettings.get()
          .input_signal_loss_timeout;
        return String(timeout.secs * 1000 + timeout.nanos / 1_000_000);
      });
      return inputValue === storeValue;
    })
    .toBe(true);
});
