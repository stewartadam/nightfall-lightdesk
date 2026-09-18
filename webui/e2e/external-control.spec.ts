// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

/** Opens a new show and the transport panel through the public navigation flow. */
async function openTransports(page: Page): Promise<void> {
  await page.setViewportSize({ width: 2200, height: 1000 });
  await page.addInitScript(() => {
    window.localStorage.clear();
  });
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  const openDialog = page.getByRole("dialog", { name: "Open Showfile" });
  await expect(openDialog).toBeVisible();
  await openDialog.getByRole("button", { name: "New showfile" }).click();
  const newDialog = page.getByRole("dialog", { name: "New Showfile" });
  await newDialog
    .getByLabel("Show name")
    .fill(`external-control-${Date.now()}`);
  await newDialog.getByRole("button", { name: "Create Show" }).click();
  await expect(newDialog).not.toBeVisible({ timeout: 10_000 });
  await waitForDockviewApp(page);
  await page.getByRole("button", { name: "Open command palette" }).click();
  await page
    .getByPlaceholder("Type a command or search...")
    .fill("Open I/O Transports");
  await page.keyboard.press("Enter");
}

/** Verifies permission changes rebind live, preserve local control, and persist on the host. */
test("external control binds All and a selected interface, then returns to local-only", async ({
  page,
  backendSlot,
}, testInfo) => {
  await openTransports(page);
  const section = page.getByRole("region", {
    name: "External control",
    exact: true,
  });
  const toggle = section.getByRole("switch", {
    name: "Enable external control",
  });
  const selector = section.getByRole("combobox", {
    name: "External control interface",
  });
  const interfaces = page.getByRole("region", {
    name: "Network interfaces",
    exact: true,
  });
  const badges = interfaces.getByText("Listening", { exact: true });
  await expect(toggle).not.toBeChecked();
  await expect(selector).toHaveValue("");
  await expect(badges).toHaveCount(0);
  await expect(section).not.toContainText("Listening on");
  try {
    await toggle.setChecked(true);
    await expect(toggle).toBeChecked();
    await expect(badges).toHaveCount(
      await interfaces.locator('[data-slot="network-interface-row"]').count(),
    );
    await expect
      .poll(async () =>
        JSON.parse(
          await readFile(
            join(backendSlot.dataDir, "external-control.json"),
            "utf8",
          ),
        ),
      )
      .toEqual({ enabled: true, interface: null });

    const choices = await selector
      .locator("option")
      .evaluateAll((options) =>
        options
          .map((option) => (option as HTMLOptionElement).value)
          .filter(Boolean),
      );
    if (choices.length) {
      await selector.selectOption(choices[0]);
      await expect(selector).toHaveValue(choices[0]);
      await expect(
        interfaces
          .locator('[data-slot="network-interface-row"]')
          .filter({
            has: page.getByText(choices[0], { exact: true }),
          })
          .getByText("Listening", { exact: true }),
      ).toBeVisible();
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as any).appStores.externalControlState.get()
                .listening_addresses,
          ),
        )
        .not.toContain(`0.0.0.0:${backendSlot.backendPort}`);
      await expect(section.getByRole("alert")).toHaveCount(0);
      await expect
        .poll(async () =>
          JSON.parse(
            await readFile(
              join(backendSlot.dataDir, "external-control.json"),
              "utf8",
            ),
          ),
        )
        .toEqual({ enabled: true, interface: choices[0] });
    }
    await page.screenshot({
      path: testInfo.outputPath("external-control-enabled.png"),
    });
    await toggle.setChecked(false);
    await expect(toggle).not.toBeChecked();
    await expect(badges).toHaveCount(0);
    await page.reload();
    await waitForDockviewApp(page);
    await expect(
      page
        .getByRole("region", { name: "External control", exact: true })
        .getByRole("switch"),
    ).not.toBeChecked();
  } finally {
    await testInfo.attach("external-control-state", {
      body: JSON.stringify(
        await page.evaluate(() =>
          (window as any).appStores.externalControlState.get(),
        ),
      ),
      contentType: "application/json",
    });
    if (
      !page.isClosed() &&
      (await toggle.isVisible()) &&
      (await toggle.isChecked())
    ) {
      await toggle.setChecked(false);
      await expect(toggle).not.toBeChecked();
    }
  }
});

/** Verifies unavailable adapters remain visible and are never replaced by All. */
test("external control keeps a missing interface and shows its listener error", async ({
  page,
}, testInfo) => {
  await openTransports(page);
  await page.evaluate(() => {
    const store = (window as any).appStores.externalControlState;
    store.set({
      ...store.get(),
      settings: { enabled: true, interface: "missing-adapter" },
      listening_addresses: ["127.0.0.1:3030"],
      error:
        "Interface missing-adapter is unavailable. Only local control is available.",
    });
  });
  const section = page.getByRole("region", {
    name: "External control",
    exact: true,
  });
  await expect(section.getByRole("combobox")).toHaveValue("missing-adapter");
  await expect(section.getByRole("alert")).toContainText(
    "Only local control is available",
  );
  await expect(page.getByText("Listening", { exact: true })).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("external-control-missing-interface.png"),
  });
});

/** Verifies badges track actual bindings across wildcard, partial, and local-only listener states. */
test("external control listening badges follow bound interface addresses", async ({
  page,
}, testInfo) => {
  await openTransports(page);
  await page.evaluate(() => {
    const stores = (window as any).appStores;
    stores.availableNetworkInterfaces.set([
      {
        name: "lan",
        friendly_name: "Ethernet",
        addresses: ["192.0.2.10", "198.51.100.10"],
      },
      { name: "wifi", friendly_name: "Wi-Fi", addresses: ["192.0.2.100"] },
    ]);
    stores.externalControlState.set({
      available: true,
      settings: { enabled: true, interface: "wifi" },
      listening_addresses: ["127.0.0.1:3030", "198.51.100.10:3030"],
      error: "Some listener addresses could not be bound.",
    });
  });
  const interfaces = page.getByRole("region", {
    name: "Network interfaces",
    exact: true,
  });
  const lan = interfaces.locator('[data-interface-name="lan"]');
  const wifi = interfaces.locator('[data-interface-name="wifi"]');
  await expect(lan.getByText("Listening", { exact: true })).toBeVisible();
  await expect(lan.getByText("Available", { exact: true })).toHaveCount(0);
  await expect(wifi.getByText("Listening", { exact: true })).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("external-control-listening-badges.png"),
  });

  for (const [addresses, count] of [
    [["0.0.0.0:3030"], 2],
    [["192.0.2.10:3030"], 1],
    [["127.0.0.1:3030"], 0],
    [[], 0],
  ] as const) {
    await page.evaluate((listeningAddresses) => {
      const store = (window as any).appStores.externalControlState;
      store.set({ ...store.get(), listening_addresses: listeningAddresses });
    }, addresses);
    await expect(
      interfaces.getByText("Listening", { exact: true }),
    ).toHaveCount(count);
    if (count === 1) {
      await expect(lan.getByText("Listening", { exact: true })).toBeVisible();
      await expect(wifi.getByText("Listening", { exact: true })).toHaveCount(0);
    }
  }
});
