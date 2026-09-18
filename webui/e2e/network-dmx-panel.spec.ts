// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { UsbDmxDeviceInfo } from "../types/index";
import { expect, type Locator, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

const COMMAND_INPUT_PLACEHOLDER = "Type a command or search...";

/** Opens a unique blank showfile for network and USB settings assertions. */
async function openOwnedNetworkDmxApp(page: Page): Promise<void> {
  const testInfo = test.info();
  const showfileName = `network-dmx-${testInfo.workerIndex}-${testInfo.retry}-${Date.now()}`;

  await page.addInitScript(() => {
    window.localStorage.clear();
  });
  await page.goto("/?startup:draftRecovery=false&e2e=1");

  const openDialog = page.getByRole("dialog", { name: "Open Showfile" });
  await expect(openDialog).toBeVisible();
  await openDialog.getByRole("button", { name: "New showfile" }).click();
  const newDialog = page.getByRole("dialog", { name: "New Showfile" });
  await expect(newDialog).toBeVisible();
  await newDialog.getByLabel("Show name").fill(showfileName);
  await newDialog.getByRole("button", { name: "Create Show" }).click();
  await expect(newDialog).not.toBeVisible({ timeout: 10_000 });
  await waitForDockviewApp(page);
}

/** Opens a panel through the command palette. */
async function openPanel(page: Page, panelName: string) {
  await page.getByRole("button", { name: "Open command palette" }).click();

  const commandInput = page.getByPlaceholder(COMMAND_INPUT_PLACEHOLDER);
  await expect(commandInput).toBeVisible();
  await commandInput.fill(`Open ${panelName}`);
  await page.keyboard.press("Enter");
}

/** Returns the visible I/O Transports component boundary for scoped panel assertions. */
function networkDmxPanel(page: Page): Locator {
  return page.locator('[data-component="IoTransportsPanel"]');
}

/** Returns one discovered network-interface row by system interface name. */
function networkInterfaceRow(panel: Locator, interfaceName: string): Locator {
  return panel.locator(
    `[data-slot="network-interface-row"][data-interface-name="${interfaceName}"]`,
  );
}

/** Returns one configured I/O Transports target row by its stable target id. */
function networkDmxTargetRow(panel: Locator, targetId: string): Locator {
  return panel.locator(
    `[data-slot="target-row"][data-target-id="${targetId}"]`,
  );
}

/** Returns one configured USB target row by its stable target id. */
function usbDmxTargetRow(panel: Locator, targetId: string): Locator {
  return panel.locator(
    `[data-slot="usb-target-row"][data-target-id="${targetId}"]`,
  );
}

/** Enables one transport output through the panel and waits for persisted settings state. */
async function enableTransportOutput(
  page: Page,
  panel: Locator,
  switchName: string,
  settingKey: "network_output_enabled" | "usb_output_enabled",
): Promise<void> {
  await page.waitForFunction(
    (key) =>
      typeof (window as any).appStores?.ioSettings?.get?.()?.[key] ===
      "boolean",
    settingKey,
  );
  const outputSwitch = panel.getByRole("switch", { name: switchName });
  if (!(await outputSwitch.isChecked())) {
    await outputSwitch.setChecked(true);
  }
  await expect
    .poll(() =>
      page.evaluate(
        (key) => (window as any).appStores.ioSettings.get()[key],
        settingKey,
      ),
    )
    .toBe(true);
  await expect(outputSwitch).toBeChecked();
}

/** Seeds deterministic network interfaces into the UI stores and returns the rendered summary text. */
async function seedNetworkInterfaces(page: Page) {
  return await page.evaluate(async () => {
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
        addresses: ["2.0.0.10", "10.0.0.10"],
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
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
    return (
      document.querySelector(
        '[data-component="IoTransportsPanel"] [data-slot="interface-summary"]',
      )?.textContent ?? ""
    );
  });
}

/** Seeds deterministic compatible USB DMX devices and locks the test store against live backend refreshes. */
async function seedUsbDmxDevices(
  page: Page,
  devices: UsbDmxDeviceInfo[] = [
    {
      id: "id-16c0:05dc,port-20:1.2",
      label: "Anyma uDMX (16c0:05dc) - bus 20 port 1.2",
      vendor_id: 0x16c0,
      product_id: 0x05dc,
      manufacturer: "Anyma",
      product: "uDMX",
      serial_number: undefined,
      location: "bus 20 port 1.2",
    },
  ],
) {
  await page.evaluate((seedDevices) => {
    const stores = (window as any).appStores;
    const usbStore = stores.availableUsbDmxDevices as any;
    if (!usbStore.__e2eOriginalSet) {
      usbStore.__e2eOriginalSet = usbStore.set.bind(usbStore);
      usbStore.set = (nextDevices: unknown) => {
        const lockedDevices = (window as any).__e2eUsbDmxDevices;
        usbStore.__e2eOriginalSet(lockedDevices ?? nextDevices);
      };
    }
    (window as any).__e2eUsbDmxDevices = seedDevices;
    usbStore.__e2eOriginalSet(seedDevices);
  }, devices);
}

/** Seeds USB output target mappings into the UI settings store. */
async function seedUsbDmxTargets(
  page: Page,
  targets: { id: string; device: string; device_label?: string }[],
) {
  await page.evaluate((seedTargets) => {
    const stores = (window as any).appStores;
    const settings = stores.ioSettings.get();
    stores.ioSettings.set({
      ...settings,
      usb_dmx_outputs: { targets: seedTargets },
    });
  }, targets);
}

/**
 * Verifies I/O Transports columns keep usable widths in a narrow panel.
 */
test("I/O transports panel keeps table columns usable", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await page.goto("/?e2e=1");

  await expect(page.locator("main#app")).toBeVisible();
  await page.waitForTimeout(3_000);

  await openPanel(page, "I/O Transports");

  const panel = networkDmxPanel(page);
  await expect(panel).toBeVisible();
  await expect(
    panel.getByRole("heading", { name: "Network", exact: true }),
  ).toBeVisible();

  const protocolHeaderBox = await panel
    .getByRole("columnheader", { name: "Protocol" })
    .boundingBox();
  const modeHeaderBox = await panel
    .getByRole("columnheader", { name: "Mode" })
    .boundingBox();
  const protocolSelectBox = await panel
    .getByLabel("sacn protocol")
    .boundingBox();
  const modeSelectBox = await panel
    .getByLabel("sacn delivery mode")
    .boundingBox();

  expect(protocolHeaderBox).not.toBeNull();
  expect(modeHeaderBox).not.toBeNull();
  expect(protocolSelectBox).not.toBeNull();
  expect(modeSelectBox).not.toBeNull();

  expect(protocolHeaderBox!.width).toBeGreaterThan(100);
  expect(protocolSelectBox!.width).toBeGreaterThan(100);
  expect(protocolHeaderBox!.x + protocolHeaderBox!.width).toBeLessThanOrEqual(
    modeHeaderBox!.x + 1,
  );
  expect(protocolSelectBox!.x + protocolSelectBox!.width).toBeLessThanOrEqual(
    modeSelectBox!.x + 1,
  );
  await page.screenshot({
    path: test.info().outputPath("shared-network-tables.png"),
    fullPage: true,
  });
});

/**
 * Verifies I/O Transports output can be globally disabled and enabled from the panel.
 */
test("I/O transports panel toggles network output", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/?e2e=1");

  await expect(page.locator("main#app")).toBeVisible();
  await page.waitForFunction(() =>
    Boolean((window as any).appStores?.ioSettings),
  );
  await page.waitForTimeout(3_000);
  await openPanel(page, "I/O Transports");

  const panel = networkDmxPanel(page);
  await expect(panel).toBeVisible();
  const networkSection = panel.locator(
    'section[aria-label="Network I/O transports"]',
  );
  const outputSwitch = networkSection.getByRole("switch", {
    name: "Enable network output",
  });

  /** Reads the current network output enabled state from the hydrated settings store. */
  const networkOutputEnabled = async () =>
    page.evaluate(
      () =>
        (window as any).appStores.ioSettings.get().network_output_enabled ??
        true,
    );

  if (!(await networkOutputEnabled())) {
    await outputSwitch.setChecked(true);
    await expect.poll(networkOutputEnabled, { timeout: 5_000 }).toBe(true);
  }

  await expect(outputSwitch).toBeChecked();
  await expect(networkDmxTargetRow(panel, "sacn")).toContainText("OK");

  await outputSwitch.setChecked(false);
  await expect.poll(networkOutputEnabled, { timeout: 5_000 }).toBe(false);
  await expect(outputSwitch).not.toBeChecked();
  await expect(
    networkDmxTargetRow(panel, "sacn").getByRole("status", {
      name: "sacn output disabled",
    }),
  ).toBeVisible();

  await outputSwitch.setChecked(true);
  await expect.poll(networkOutputEnabled, { timeout: 5_000 }).toBe(true);
  await expect(outputSwitch).toBeChecked();
  await expect(networkDmxTargetRow(panel, "sacn")).toContainText("OK");
});

/**
 * Verifies I/O Transports input listeners can be globally disabled and enabled from the panel.
 */
test("I/O transports panel toggles network input", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/?e2e=1");

  await expect(page.locator("main#app")).toBeVisible();
  await page.waitForFunction(() =>
    Boolean((window as any).appStores?.ioSettings),
  );
  await page.waitForTimeout(3_000);
  await openPanel(page, "I/O Transports");

  const panel = networkDmxPanel(page);
  await expect(panel).toBeVisible();
  const networkSection = panel.locator(
    'section[aria-label="Network I/O transports"]',
  );
  const inputSwitch = networkSection.getByRole("switch", {
    name: "Enable network input",
  });

  /** Reads the current network input enabled state from the hydrated settings store. */
  const networkInputEnabled = async () =>
    page.evaluate(
      () =>
        (window as any).appStores.ioSettings.get().network_input_enabled ??
        true,
    );

  if (!(await networkInputEnabled())) {
    await inputSwitch.setChecked(true);
    await expect.poll(networkInputEnabled, { timeout: 5_000 }).toBe(true);
  }

  await expect(inputSwitch).toBeChecked();

  await inputSwitch.setChecked(false);
  await expect.poll(networkInputEnabled, { timeout: 5_000 }).toBe(false);
  await expect(inputSwitch).not.toBeChecked();

  await inputSwitch.setChecked(true);
  await expect.poll(networkInputEnabled, { timeout: 5_000 }).toBe(true);
  await expect(inputSwitch).toBeChecked();
  await page.screenshot({
    path: test.info().outputPath("network-input-enabled.png"),
    fullPage: true,
  });
});

/**
 * Verifies USB output can be globally disabled and enabled from the panel.
 */
test("I/O transports panel toggles USB output", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/?e2e=1");

  await expect(page.locator("main#app")).toBeVisible();
  await page.waitForFunction(() =>
    Boolean((window as any).appStores?.ioSettings),
  );
  await page.waitForTimeout(3_000);
  await openPanel(page, "I/O Transports");

  const panel = networkDmxPanel(page);
  await expect(panel).toBeVisible();
  const usbSection = panel.locator(
    'section[aria-label="USB output transports"]',
  );
  const usbSwitch = usbSection.getByRole("switch", {
    name: "Enable USB output",
  });

  /** Reads the current USB output enabled state from the hydrated settings store. */
  const usbOutputEnabled = async () =>
    page.evaluate(
      () =>
        (window as any).appStores.ioSettings.get().usb_output_enabled ?? true,
    );

  if (!(await usbOutputEnabled())) {
    await usbSwitch.setChecked(true);
    await expect.poll(usbOutputEnabled, { timeout: 5_000 }).toBe(true);
  }

  await expect(usbSwitch).toBeChecked();

  await usbSwitch.setChecked(false);
  await expect.poll(usbOutputEnabled, { timeout: 5_000 }).toBe(false);
  await expect(usbSwitch).not.toBeChecked();
  const usbRow = usbDmxTargetRow(panel, "udmx");
  await usbRow.scrollIntoViewIfNeeded();
  await expect(
    usbRow.getByRole("status", { name: "udmx usb output disabled" }),
  ).toBeVisible();

  await usbSwitch.setChecked(true);
  await expect.poll(usbOutputEnabled, { timeout: 5_000 }).toBe(true);
  await expect(usbSwitch).toBeChecked();
});

/**
 * Verifies protocol changes move unsupported add-row delivery modes to unicast.
 */
test("I/O transports panel enables new transport IP after protocol mode normalization", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/?e2e=1");

  await expect(page.locator("main#app")).toBeVisible();
  await page.waitForTimeout(3_000);

  await openPanel(page, "I/O Transports");

  const panel = networkDmxPanel(page);
  const mode = panel.getByLabel("New transport delivery mode");
  const ip = panel.getByLabel("New transport unicast ip");

  await mode.selectOption({ label: "Multicast" });
  await expect(ip).toBeDisabled();

  await panel.getByLabel("New transport protocol").selectOption({
    label: "Art-Net",
  });

  await expect(mode).toHaveValue("Unicast");
  await expect(ip).toBeEnabled();
});

/**
 * Verifies external control shares a section with interface names, addresses, and status.
 */
test("I/O transports panel lists network interfaces", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await openOwnedNetworkDmxApp(page);

  await expect(page.locator("main#app")).toBeVisible();
  await openPanel(page, "I/O Transports");

  const summary = networkDmxPanel(page).locator(
    '[data-slot="interface-summary"]',
  );
  const networkSection = networkDmxPanel(page).locator(
    'section[aria-label="Network I/O transports"]',
  );
  const usbSection = networkDmxPanel(page).locator(
    'section[aria-label="USB output transports"]',
  );
  await expect(summary).toBeVisible();
  await expect(
    summary.getByRole("switch", { name: "Enable external control" }),
  ).toBeVisible();
  await expect(
    summary.getByRole("combobox", { name: "External control interface" }),
  ).toBeVisible();
  const seededSummaryText = await seedNetworkInterfaces(page);
  await expect(
    summary.getByRole("heading", { name: "Network Interfaces" }),
  ).toBeVisible();
  await expect(
    summary.getByRole("columnheader", { name: "Interface" }),
  ).toBeVisible();
  await expect(
    summary.getByRole("columnheader", { name: "Name" }),
  ).toBeVisible();
  await expect(
    summary.getByRole("columnheader", { name: "Addresses" }),
  ).toBeVisible();
  const addressesHeader = summary.getByRole("columnheader", {
    name: "Addresses",
  });
  const statusHeader = summary.getByRole("columnheader", { name: "Status" });
  await expect(statusHeader).toBeVisible();

  const addressesHeaderBox = await addressesHeader.boundingBox();
  const statusHeaderBox = await statusHeader.boundingBox();
  expect(addressesHeaderBox).not.toBeNull();
  expect(statusHeaderBox).not.toBeNull();
  expect(statusHeaderBox!.width).toBeGreaterThan(addressesHeaderBox!.width);
  const networkSectionBox = await networkSection.boundingBox();
  const summaryBox = await summary.boundingBox();
  const usbSectionBox = await usbSection.boundingBox();
  expect(networkSectionBox).not.toBeNull();
  expect(summaryBox).not.toBeNull();
  expect(usbSectionBox).not.toBeNull();
  expect(summaryBox!.y).toBeGreaterThan(networkSectionBox!.y);
  expect(summaryBox!.y).toBeLessThan(usbSectionBox!.y);

  expect(seededSummaryText).toContain("Wi-Fi");
  expect(seededSummaryText).toContain("en0");
  expect(seededSummaryText).toContain("192.168.1.44");
  expect(seededSummaryText).toContain("USB 2.5G LAN");
  expect(seededSummaryText).toContain("en7");
  expect(seededSummaryText).toContain("2.0.0.10, 10.0.0.10");
  expect(seededSummaryText).toContain("Current");
  expect(seededSummaryText).toContain("Default");
  await page.screenshot({
    path: test.info().outputPath("network-interfaces-external-control.png"),
  });
});

/**
 * Verifies network interface badges follow the latest interface list/status after the current interface disappears.
 */
test("I/O transports panel updates network interface badges after unplug", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/?e2e=1");

  await expect(page.locator("main#app")).toBeVisible();
  await page.waitForFunction(() =>
    Boolean((window as any).appStores?.availableNetworkInterfaces),
  );
  await openPanel(page, "I/O Transports");

  const panel = networkDmxPanel(page);
  const summary = panel.locator('[data-slot="interface-summary"]');
  await expect(summary).toBeVisible();

  await page.evaluate(async () => {
    const stores = (window as any).appStores;
    const wifi = {
      name: "en0",
      friendly_name: "Wi-Fi",
      addresses: ["192.168.1.44"],
    };
    const usbLan = {
      name: "en7",
      friendly_name: "USB 2.5G LAN",
      addresses: ["2.0.0.10"],
    };
    stores.availableNetworkInterfaces.set([wifi, usbLan]);
    stores.networkInterfaceStatus.set({
      default_interface: usbLan,
      current_interface: usbLan,
      current_interface_mode: "SystemDefault",
      selected_interface_missing: false,
    });
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
  });

  await expect(networkInterfaceRow(panel, "en7")).toContainText("Current");
  await expect(networkInterfaceRow(panel, "en7")).toContainText("Default");

  await page.evaluate(async () => {
    const stores = (window as any).appStores;
    const wifi = {
      name: "en0",
      friendly_name: "Wi-Fi",
      addresses: ["192.168.1.44"],
    };
    stores.availableNetworkInterfaces.set([wifi]);
    stores.networkInterfaceStatus.set({
      default_interface: wifi,
      current_interface: wifi,
      current_interface_mode: "SystemDefault",
      selected_interface_missing: false,
    });
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
  });

  await expect(networkInterfaceRow(panel, "en7")).toHaveCount(0);
  await expect(networkInterfaceRow(panel, "en0")).toContainText("Current");
  await expect(networkInterfaceRow(panel, "en0")).toContainText("Default");
  await expect(networkInterfaceRow(panel, "en0")).not.toContainText(
    "Available",
  );
});

/**
 * Verifies add-row validation appears in the Status column and row outline.
 */
test("I/O transports panel shows new transport validation status", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/?e2e=1");

  await expect(page.locator("main#app")).toBeVisible();
  await page.waitForTimeout(3_000);

  await openPanel(page, "I/O Transports");

  const panel = networkDmxPanel(page);
  const newRow = panel.locator('[data-slot="new-target-row"]');
  await expect(
    newRow.getByRole("status", { name: "New transport status: Enter ID" }),
  ).toBeVisible();

  await panel.getByLabel("New transport delivery mode").selectOption({
    label: "Multicast",
  });
  await expect(
    newRow.getByRole("status", { name: "New transport status: Enter ID" }),
  ).toBeVisible();
  await expect(newRow).not.toHaveClass(/outline-red-500/);

  await panel
    .getByLabel("New transport id")
    .fill(`dupenode${Date.now().toString(36)}`);
  await expect(
    newRow.getByRole("status", {
      name: "New transport status: Duplicate output",
    }),
  ).toBeVisible();
  await expect(newRow).toHaveClass(/outline-red-500/);

  await panel.getByLabel("New transport delivery mode").selectOption({
    label: "Unicast",
  });
  await panel.getByLabel("New transport id").fill("1bad");

  await expect(
    newRow.getByRole("status", { name: "New transport status: Invalid ID" }),
  ).toBeVisible();
  await expect(newRow).toHaveClass(/outline-red-500/);
  await expect(panel.getByLabel("New transport id")).not.toHaveClass(
    /border-red-500/,
  );

  await panel
    .getByLabel("New transport id")
    .fill(`validnode${Date.now().toString(36)}`);

  await expect(
    newRow.getByRole("status", { name: "New transport status: Ready" }),
  ).toBeVisible();
  await expect(newRow).not.toHaveClass(/outline-red-500/);
});

test("I/O transports panel configures named unicast targets", async ({
  page,
}) => {
  const targetId = `sacnnode${Date.now().toString(36)}`;
  const targetIp = `10.42.${Date.now() % 200}.${(Date.now() % 200) + 1}`;

  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/?e2e=1");

  await expect(page.locator("main#app")).toBeVisible();
  await page.waitForTimeout(3_000);

  await openPanel(page, "I/O Transports");

  const panel = networkDmxPanel(page);
  await expect(panel).toBeVisible();
  await expect(networkDmxTargetRow(panel, "sacn")).toBeVisible();
  await expect(networkDmxTargetRow(panel, "artnet")).toBeVisible();

  await panel.getByLabel("New transport id").fill(targetId);
  await panel.getByLabel("New transport protocol").selectOption({
    label: "sACN",
  });
  await panel.getByLabel("New transport delivery mode").selectOption({
    label: "Unicast",
  });
  await panel.getByLabel("New transport unicast ip").fill(targetIp);
  await panel
    .locator('[data-slot="new-target-row"]')
    .getByRole("button", { name: "Add" })
    .click();

  const targetRow = networkDmxTargetRow(panel, targetId);
  await expect(targetRow).toBeVisible();

  await targetRow.getByLabel(`${targetId} delivery mode`).selectOption({
    label: "Unicast",
  });
  await expect(targetRow.getByLabel(`${targetId} unicast ip`)).toBeEnabled();
  await targetRow.getByLabel(`${targetId} unicast ip`).fill(targetIp);
  await targetRow.getByLabel(`${targetId} unicast ip`).blur();
  await expect(targetRow.getByLabel(`${targetId} unicast ip`)).toHaveValue(
    targetIp,
  );
});

/**
 * Verifies new named USB mappings are created from discovered device choices.
 */
test("I/O transports panel configures named USB targets", async ({ page }) => {
  const targetId = `frontusb${Date.now().toString(36)}`;
  const deviceId = "id-16c0:05dc,serial-ABC123,port-20:1.4";

  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/?e2e=1");

  await expect(page.locator("main#app")).toBeVisible();
  await page.waitForTimeout(3_000);

  await openPanel(page, "I/O Transports");

  const panel = networkDmxPanel(page);
  await expect(
    panel.getByRole("heading", { name: "USB", exact: true }),
  ).toBeVisible();
  await expect(usbDmxTargetRow(panel, "udmx")).toBeVisible();
  await seedUsbDmxDevices(page, [
    {
      id: deviceId,
      label: `Anyma uDMX (16c0:05dc) - ${deviceId}`,
      vendor_id: 0x16c0,
      product_id: 0x05dc,
      manufacturer: "Anyma",
      product: "uDMX",
      serial_number: "ABC123",
      location: "bus 20 port 1.4",
    },
  ]);

  const newUsbRow = panel.locator('[data-slot="new-usb-target-row"]');
  await newUsbRow.getByLabel("New USB transport id").fill(targetId);
  await expect(newUsbRow.getByLabel("New USB device")).toHaveValue(deviceId);
  await expect(
    newUsbRow
      .getByLabel("New USB device")
      .locator(`option[value="${deviceId}"]`),
  ).toContainText("Anyma uDMX (ABC123)");
  await expect(
    newUsbRow.getByRole("status", {
      name: "New USB transport status: Ready",
    }),
  ).toBeVisible();
  await newUsbRow.getByRole("button", { name: "Add" }).click();

  const targetRow = usbDmxTargetRow(panel, targetId);
  await expect(targetRow).toBeVisible();
  await expect(targetRow.getByLabel(`${targetId} usb device`)).toHaveValue(
    deviceId,
  );
  await expect(
    targetRow
      .getByLabel(`${targetId} usb device`)
      .locator(`option[value="${deviceId}"]`),
  ).toContainText("Anyma uDMX (ABC123)");
});

/**
 * Verifies Auto can be added as a USB mapping when no existing target uses it.
 */
test("I/O transports panel offers auto for new USB target when unused", async ({
  page,
}) => {
  const targetId = `autousb${Date.now().toString(36)}`;
  const deviceId = "id-16c0:05dc,serial-ABC123,port-20:1.4";

  await page.setViewportSize({ width: 1400, height: 900 });
  await openOwnedNetworkDmxApp(page);

  await expect(page.locator("main#app")).toBeVisible();
  await openPanel(page, "I/O Transports");
  await seedUsbDmxDevices(page, [
    {
      id: deviceId,
      label: "Anyma uDMX (16c0:05dc) - bus 20 port 1.4",
      vendor_id: 0x16c0,
      product_id: 0x05dc,
      manufacturer: "Anyma",
      product: "uDMX",
      serial_number: "ABC123",
      location: "bus 20 port 1.4",
    },
  ]);
  await seedUsbDmxTargets(page, [
    { id: "udmx", device: deviceId, device_label: "Anyma uDMX" },
  ]);

  const newUsbRow = networkDmxPanel(page).locator(
    '[data-slot="new-usb-target-row"]',
  );
  const select = newUsbRow.getByLabel("New USB device");
  await expect(select).toHaveValue("default");
  await expect(select.locator('option[value="default"]')).toContainText(
    "Auto (first compatible uDMX)",
  );

  await newUsbRow.getByLabel("New USB transport id").fill(targetId);
  await expect(
    newUsbRow.getByRole("status", {
      name: "New USB transport status: Ready",
    }),
  ).toBeVisible();
  await newUsbRow.getByRole("button", { name: "Add" }).click();

  const targetRow = usbDmxTargetRow(networkDmxPanel(page), targetId);
  await expect(targetRow).toBeVisible();
  await expect(targetRow.getByLabel(`${targetId} usb device`)).toHaveValue(
    "default",
  );
});

/**
 * Verifies an empty USB device list uses neutral add-row styling.
 */
test("I/O transports panel keeps no USB devices state neutral", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/?e2e=1");

  await expect(page.locator("main#app")).toBeVisible();
  await page.waitForFunction(() =>
    Boolean((window as any).appStores?.availableUsbDmxDevices),
  );
  await openPanel(page, "I/O Transports");
  await seedUsbDmxDevices(page, []);

  const newUsbRow = networkDmxPanel(page).locator(
    '[data-slot="new-usb-target-row"]',
  );
  const select = newUsbRow.getByLabel("New USB device");
  await expect(select).toBeDisabled();
  await expect(select.locator("option")).toContainText(
    "No compatible USB devices",
  );
  await expect(select).toHaveClass(/border-gray-700/);
  await expect(select).not.toHaveClass(/border-red-500/);
  await expect(newUsbRow).not.toHaveClass(/outline-red-500/);
});

/**
 * Verifies saved USB mappings remain visible when their hardware is unplugged.
 */
test("I/O transports panel preserves missing saved USB devices", async ({
  page,
}) => {
  const targetId = `missingusb${Date.now().toString(36)}`;
  const missingDeviceId = "id-16c0:05dc,serial-unplugged,port-20:1.7";

  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/?e2e=1");

  await expect(page.locator("main#app")).toBeVisible();
  await page.waitForFunction(() =>
    Boolean((window as any).appStores?.availableUsbDmxDevices),
  );
  await openPanel(page, "I/O Transports");
  const panel = networkDmxPanel(page);
  await expect(panel).toBeVisible();
  await enableTransportOutput(
    page,
    panel,
    "Enable USB output",
    "usb_output_enabled",
  );
  await seedUsbDmxTargets(page, [
    { id: "udmx", device: "default" },
    { id: targetId, device: missingDeviceId, device_label: "Anyma uDMX" },
  ]);
  await seedUsbDmxDevices(page);

  const targetRow = usbDmxTargetRow(panel, targetId);
  await targetRow.scrollIntoViewIfNeeded();
  await expect(targetRow).toBeVisible();
  await expect(targetRow.getByLabel(`${targetId} usb device`)).toHaveValue(
    missingDeviceId,
  );
  await expect(targetRow.getByText("Missing", { exact: true })).toBeVisible();
  await expect(
    targetRow
      .getByLabel(`${targetId} usb device`)
      .locator(`option[value="${missingDeviceId}"]`),
  ).toContainText("Anyma uDMX (unplugged, port 20:1.7)");
});

/**
 * Verifies connected compatible USB devices are listed separately from transport mappings.
 */
test("I/O transports panel lists connected compatible USB devices", async ({
  page,
}) => {
  const firstDevice = "id-16c0:05dc,serial-0001,port-20:1.2";
  const secondDevice = "id-16c0:05dc,serial-0001,port-20:1.3";

  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/?e2e=1");

  await expect(page.locator("main#app")).toBeVisible();
  await openPanel(page, "I/O Transports");
  await seedUsbDmxDevices(page, [
    {
      id: firstDevice,
      label: "Anyma uDMX (16c0:05dc) - bus 20 port 1.2",
      vendor_id: 0x16c0,
      product_id: 0x05dc,
      manufacturer: "Anyma",
      product: "uDMX",
      serial_number: "0001",
      location: "bus 20 port 1.2",
    },
    {
      id: secondDevice,
      label: "Anyma uDMX (16c0:05dc) - bus 20 port 1.3",
      vendor_id: 0x16c0,
      product_id: 0x05dc,
      manufacturer: "Anyma",
      product: "uDMX",
      serial_number: "0001",
      location: "bus 20 port 1.3",
    },
  ]);

  const summary = networkDmxPanel(page).locator(
    '[data-slot="usb-device-summary"]',
  );
  await expect(summary).toBeVisible();
  await expect(
    summary.getByRole("heading", { name: "Connected USB Devices" }),
  ).toBeVisible();
  await expect(
    summary.getByRole("columnheader", { name: "Device" }),
  ).toBeVisible();
  await expect(
    summary.getByRole("columnheader", { name: "USB ID" }),
  ).toBeVisible();
  await expect(
    summary.getByRole("columnheader", { name: "Serial" }),
  ).toBeVisible();
  await expect(
    summary.getByRole("columnheader", { name: "Location" }),
  ).toBeVisible();
  await expect(
    summary.getByRole("columnheader", { name: "Selector" }),
  ).toHaveCount(0);
  await expect(summary).toContainText("Anyma uDMX");
  await expect(summary).toContainText("16c0:05dc");
  await expect(summary).toContainText("0001");
  await expect(summary).toContainText("bus 20 port 1.2");
  await expect(summary).toContainText("bus 20 port 1.3");
  await expect(summary).not.toContainText(firstDevice);
  await expect(summary).not.toContainText(secondDevice);
});

/**
 * Verifies multiple adapters with the same vendor/product ID can be selected independently.
 */
test("I/O transports panel distinguishes same-SKU USB devices", async ({
  page,
}) => {
  const firstDevice = "id-16c0:05dc,serial-0001,port-20:1.2";
  const secondDevice = "id-16c0:05dc,serial-0001,port-20:1.3";

  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/?e2e=1");

  await expect(page.locator("main#app")).toBeVisible();
  await page.waitForTimeout(3_000);

  await openPanel(page, "I/O Transports");
  await seedUsbDmxTargets(page, [{ id: "udmx", device: "default" }]);
  await seedUsbDmxDevices(page, [
    {
      id: firstDevice,
      label: "Anyma uDMX (16c0:05dc) - bus 20 port 1.2",
      vendor_id: 0x16c0,
      product_id: 0x05dc,
      manufacturer: "Anyma",
      product: "uDMX",
      serial_number: "0001",
      location: "bus 20 port 1.2",
    },
    {
      id: secondDevice,
      label: "Anyma uDMX (16c0:05dc) - bus 20 port 1.3",
      vendor_id: 0x16c0,
      product_id: 0x05dc,
      manufacturer: "Anyma",
      product: "uDMX",
      serial_number: "0001",
      location: "bus 20 port 1.3",
    },
  ]);

  const select = usbDmxTargetRow(networkDmxPanel(page), "udmx").getByLabel(
    "udmx usb device",
  );
  await expect(select.locator("option")).toHaveCount(3);
  await expect(select.locator(`option[value="${firstDevice}"]`)).toContainText(
    "Anyma uDMX (0001, port 20:1.2)",
  );
  await expect(select.locator(`option[value="${secondDevice}"]`)).toContainText(
    "Anyma uDMX (0001, port 20:1.3)",
  );
  await expect(
    select.locator(`option[value="${firstDevice}"]`),
  ).not.toContainText("16c0:05dc");
  await expect(
    select.locator(`option[value="${secondDevice}"]`),
  ).not.toContainText("bus 20 port 1.3");

  const newSelect = networkDmxPanel(page)
    .locator('[data-slot="new-usb-target-row"]')
    .getByLabel("New USB device");
  await expect(
    newSelect.locator(`option[value="${firstDevice}"]`),
  ).toContainText("Anyma uDMX (0001, port 20:1.2)");
  await expect(
    newSelect.locator(`option[value="${secondDevice}"]`),
  ).toContainText("Anyma uDMX (0001, port 20:1.3)");

  await select.selectOption(secondDevice);
  await expect(select).toHaveValue(secondDevice);
  await expect(select.locator(`option[value="default"]`)).toContainText(
    "Auto (first compatible uDMX)",
  );

  await select.selectOption("default");
  await expect(select).toHaveValue("default");
});

/**
 * Verifies delivery edits keep IP controls interactive while waiting for a unique persisted output.
 */
test("I/O transports panel enables IP editing before duplicate unicast edits are saved", async ({
  page,
}) => {
  const duplicateTargetId = `artnetlocal${Date.now().toString(36)}`;

  await page.setViewportSize({ width: 1400, height: 900 });
  await openOwnedNetworkDmxApp(page);

  await expect(page.locator("main#app")).toBeVisible();
  await openPanel(page, "I/O Transports");
  await page.evaluate((targetId) => {
    const stores = (window as any).appStores;
    const settings = stores.ioSettings.get();
    stores.ioSettings.set({
      ...settings,
      network_dmx_outputs: {
        targets: [
          {
            id: "sacn",
            protocol: "Sacn",
            delivery: { type: "SacnMulticast" },
          },
          {
            id: "artnet",
            protocol: "ArtNet",
            delivery: { type: "ArtNetBroadcast" },
          },
          {
            id: targetId,
            protocol: "ArtNet",
            delivery: {
              type: "Unicast",
              data: { ip: "127.0.0.1" },
            },
          },
        ],
      },
    });
  }, duplicateTargetId);

  const panel = networkDmxPanel(page);
  const artNetRow = networkDmxTargetRow(panel, "artnet");
  const artNetIp = artNetRow.getByLabel("artnet unicast ip");

  await expect(artNetIp).toBeDisabled();
  await artNetRow.getByLabel("artnet delivery mode").selectOption({
    label: "Unicast",
  });

  await expect(artNetIp).toBeEnabled();
  await expect(artNetIp).toHaveValue("127.0.0.1");
});

/**
 * Verifies network output send failures are visible on their configured target row.
 */
test("I/O transports panel surfaces send failures for target troubleshooting", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await openOwnedNetworkDmxApp(page);

  await expect(page.locator("main#app")).toBeVisible();

  await openPanel(page, "I/O Transports");

  const panel = networkDmxPanel(page);
  await enableTransportOutput(
    page,
    panel,
    "Enable network output",
    "network_output_enabled",
  );
  const artNetRow = networkDmxTargetRow(panel, "artnet");
  await artNetRow.getByLabel("artnet delivery mode").selectOption({
    label: "Broadcast",
  });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const settings = (window as any).appStores.ioSettings.get();
        const target = settings.network_dmx_outputs?.targets?.find(
          (candidate: any) => candidate.id === "artnet",
        );
        return target?.delivery?.type;
      }),
    )
    .toBe("ArtNetBroadcast");

  const warning = panel.getByRole("status", {
    name: /artnet output warning: HostUnreachable/,
  });
  await page.evaluate(async () => {
    const { engineRuntime } = await import(
      /* @vite-ignore */ "/lib/engine-runtime.ts"
    );
    engineRuntime.stop();
    const stores = (window as any).appStores;
    stores.engineMetrics.set({
      fps: 60,
      active_layers: 0,
      active_universes: 1,
      artnet_send_time_ms: 1,
      artnet_universe_count: 1,
      sacn_send_time_ms: null,
      sacn_universe_count: 0,
      network_output_send_failures: [
        {
          protocol: "ArtNet",
          universe: 0,
          error_kind: "HostUnreachable",
          message: "No route to host",
          count: 2,
        },
      ],
    });
  });
  await expect(warning).toHaveCount(1);
  await expect(warning).toBeVisible();
  await expect(warning).toContainText("HostUnreachable");
});
