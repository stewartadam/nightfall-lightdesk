// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import { expect, type Locator, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

test.setTimeout(120_000);

const STALE_GROUP_ID = 7;
const STALE_GROUP_UID = "0000000000000000000000000000a007";
const MISSING_FIXTURE_UID = "0000000000000000000000000000dead";
const VIRTUAL_REFERENCE_COUNT = 1_200;
const STAGE_NODE = "stagenode";

/** Opens a panel through the command palette. */
async function openPanel(page: Page, panelName: string): Promise<void> {
  await page.getByRole("button", { name: "Open command palette" }).click();
  const commandInput = page.getByPlaceholder("Type a command or search...");
  await expect(commandInput).toBeVisible();
  await commandInput.fill(`Open ${panelName}`);
  await page.keyboard.press("Enter");
}

/** Opens the References panel and returns it once visible. */
async function openReferencesPanel(page: Page): Promise<Locator> {
  await openPanel(page, "References");
  const panel = page.locator('[data-panel-kind="references"]');
  await expect(panel).toBeVisible();
  return panel;
}

/** Sends one command to the backend from the page and fails the test when it fails. */
async function sendCommand(page: Page, command: object): Promise<void> {
  await page.evaluate(async (data) => {
    const result = await (window as any).appStores.sendAndAwait(data);
    if (result.outcome.type !== "Succeeded") {
      throw new Error(`command failed: ${JSON.stringify(result)}`);
    }
  }, command);
}

/** Patches fixture 1 from the fixture library and returns its UID. */
async function createFixture(page: Page): Promise<string> {
  await sendCommand(page, {
    module: "FixtureLibraryCommand",
    command: {
      type: "CreateFixtureFromLibrary",
      data: {
        id: 1,
        make: "Generic",
        model: "Moving Head RGBW",
        mode: "Spot",
        label: "Live Fixture",
        update_existing_ids: [],
        update_existing_only: false,
      },
    },
  });
  let fixtureUid = "";
  await expect
    .poll(async () => {
      fixtureUid = await page.evaluate(() => {
        const fixtures: Array<{ identifiers: { id: number; uid: string } }> =
          Object.values((window as any).appStores.fixtures.get());
        return (
          fixtures.find((fixture) => fixture.identifiers.id === 1)?.identifiers
            .uid ?? ""
        );
      });
      return fixtureUid;
    })
    .not.toBe("");
  return fixtureUid;
}

/** Stores a group whose resolved selection names fixture 1 and a fixture that does not exist. */
async function storeStaleGroup(page: Page, fixtureUid: string): Promise<void> {
  await sendCommand(page, {
    module: "GroupCommand",
    command: {
      type: "StoreGroup",
      data: {
        identifiers: {
          id: STALE_GROUP_ID,
          uid: STALE_GROUP_UID,
          label: "Stale Group",
        },
        selection: {
          source: {
            type: "Resolved",
            data: [
              { fixture_uid: fixtureUid, index: 1 },
              { fixture_uid: MISSING_FIXTURE_UID, index: 1 },
            ],
          },
          clauses: [],
        },
        description: "",
      },
    },
  });
}

/** Opens a fresh backend show and the app connected to it. */
test.beforeEach(async ({ backendSlot, page }) => {
  await prepareFreshBackendShowfile(backendSlot.backendPort);
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("nightfall.currentShowfileName", "default");
  });
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await waitForDockviewApp(page);
});

/**
 * Verifies the References panel lists the backend's references and missing ones, prunes the
 * missing fixture as one undo step, and that undo restores it.
 */
test("references panel surfaces and prunes missing fixture references", async ({
  page,
}, testInfo) => {
  const fixtureUid = await createFixture(page);
  await storeStaleGroup(page, fixtureUid);
  const panel = await openReferencesPanel(page);

  await panel.getByLabel("Filter references").fill(MISSING_FIXTURE_UID);
  await expect(
    panel.getByText(`Fixture UID ${MISSING_FIXTURE_UID}`),
  ).toBeVisible();
  await expect(panel.getByText("Missing").first()).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("references-panel-references.png"),
    fullPage: true,
  });

  await panel.getByRole("tab", { name: "Health", exact: true }).click();
  await expect(
    panel.getByText("Missing fixture UID", { exact: true }),
  ).toBeVisible();
  await expect(panel.getByText("7: Stale Group")).toBeVisible();
  const prune = panel.getByRole("button", { name: "Prune" });
  await expect(prune).toBeEnabled();
  await page.screenshot({
    path: testInfo.outputPath("references-panel-health.png"),
    fullPage: true,
  });

  await prune.click();
  await expect(panel.getByRole("status")).toHaveText("No missing references");
  await expect(prune).toBeDisabled();
  await expect
    .poll(() =>
      page.evaluate(
        (uid) =>
          (window as any).appStores.groups.get()[uid]?.selection.source.data
            .length,
        STALE_GROUP_UID,
      ),
    )
    .toBe(1);
  await page.screenshot({
    path: testInfo.outputPath("references-panel-pruned.png"),
    fullPage: true,
  });

  await sendCommand(page, {
    module: "UndoCommand",
    command: { type: "Undo", data: {} },
  });
  await expect(
    panel.getByText("Missing fixture UID", { exact: true }),
  ).toBeVisible();
});

/** Verifies a group another object references cannot be deleted, and the error names it. */
test("groups referenced by other objects cannot be deleted", async ({
  page,
}) => {
  const fixtureUid = await createFixture(page);
  await storeStaleGroup(page, fixtureUid);
  await sendCommand(page, {
    module: "GroupCommand",
    command: {
      type: "StoreGroup",
      data: {
        identifiers: {
          id: 8,
          uid: "0000000000000000000000000000a008",
          label: "Uses Stale",
        },
        selection: {
          source: { type: "Group", data: { type: "ById", data: 7 } },
          clauses: [],
        },
        description: "",
      },
    },
  });

  const message = await page.evaluate(async () => {
    const result = await (window as any).appStores.sendAndAwait({
      module: "GroupCommand",
      command: { type: "DeleteGroup", data: 7 },
    });
    return result.outcome.type === "Failed" ? result.outcome.data.message : "";
  });
  expect(message).toBe(
    "Cannot delete group 7 because it is referenced by: group 8 (Uses Stale)",
  );
  await expect(page.getByText(message).first()).toBeVisible();
});

/** Verifies the References table virtualizes a large reference set from the backend. */
test("references panel virtualizes large reference sets", async ({ page }) => {
  const fixtureUid = await createFixture(page);
  await sendCommand(page, {
    module: "GroupCommand",
    command: {
      type: "StoreGroup",
      data: {
        identifiers: {
          id: 1,
          uid: "0000000000000000000000000000a001",
          label: "Large Group",
        },
        selection: {
          source: {
            type: "Resolved",
            data: Array.from({ length: VIRTUAL_REFERENCE_COUNT }, () => ({
              fixture_uid: fixtureUid,
              index: 1,
            })),
          },
          clauses: [],
        },
        description: "",
      },
    },
  });
  const panel = await openReferencesPanel(page);

  const table = panel.locator('[data-component="ReferencesTable"]');
  const scroller = table.locator('[data-grid-kind="tanstack"]');
  await expect
    .poll(async () => Number(await table.getAttribute("data-reference-count")))
    .toBe(VIRTUAL_REFERENCE_COUNT);

  const renderedRows = panel.locator(
    '[role="gridcell"][data-grid-column-key="target"]',
  );
  await expect(renderedRows.first()).toBeVisible();
  expect(await renderedRows.count()).toBeLessThan(VIRTUAL_REFERENCE_COUNT);

  await scroller.evaluate((element) => {
    element.scrollTop = Math.floor(element.scrollHeight / 2);
  });
  await expect
    .poll(() => renderedRows.count())
    .toBeLessThan(VIRTUAL_REFERENCE_COUNT);
  await expect(renderedRows.first()).toHaveCSS("height", "36px");
  await page.screenshot({
    path: test.info().outputPath("shared-virtual-references.png"),
    fullPage: true,
  });
});

/** Verifies reference table headers expose draggable resize handles. */
test("references panel resizes table columns by dragging headers", async ({
  page,
}, testInfo) => {
  const panel = await openReferencesPanel(page);
  const targetHeader = panel.getByRole("columnheader", {
    name: "Target",
    exact: true,
  });
  const targetResizer = panel.getByRole("separator", {
    name: "Resize Target",
    exact: true,
  });
  await expect(targetHeader).toBeVisible();
  await expect(targetResizer).toBeVisible();

  const before = await targetHeader.boundingBox();
  const handleBox = await targetResizer.boundingBox();
  expect(before).not.toBeNull();
  expect(handleBox).not.toBeNull();
  if (!before || !handleBox) return;

  await page.mouse.move(
    handleBox.x + handleBox.width / 2,
    handleBox.y + handleBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    handleBox.x + handleBox.width / 2 + 72,
    handleBox.y + handleBox.height / 2,
    { steps: 4 },
  );
  await page.mouse.up();

  await expect
    .poll(async () => {
      const after = await targetHeader.boundingBox();
      return after ? after.width : 0;
    })
    .toBeGreaterThan(before.width + 48);

  const resizedWidth = Number(
    await targetResizer.getAttribute("aria-valuenow"),
  );
  await targetResizer.focus();
  await page.keyboard.press("ArrowRight");
  await expect(targetResizer).toHaveAttribute(
    "aria-valuenow",
    String(resizedWidth + 10),
  );
  await expect(targetHeader).toHaveAttribute("aria-sort", "none");
  await page.keyboard.press("Enter");
  await expect(targetHeader).toHaveAttribute("aria-sort", "none");

  await page.screenshot({
    path: testInfo.outputPath("references-panel-resized-columns.png"),
    fullPage: true,
  });
});

/**
 * Verifies an output patched to a network target that was later removed shows as a manual health
 * issue. Restores the backend's network outputs afterwards, since they are app settings rather
 * than show data.
 */
test("references panel surfaces missing output transport targets", async ({
  page,
}, testInfo) => {
  const originalOutputs = await page.evaluate(
    () => (window as any).appStores.ioSettings.get().network_dmx_outputs,
  );
  try {
    await sendCommand(page, {
      module: "SettingsCommand",
      command: {
        type: "SetNetworkDmxOutputs",
        data: {
          targets: [
            ...originalOutputs.targets,
            {
              id: STAGE_NODE,
              protocol: "ArtNet",
              delivery: { type: "Unicast", data: { ip: "127.0.0.1" } },
            },
          ],
        },
      },
    });
    await createFixture(page);
    const input = page.locator("#header-cmdline");
    await input.fill(`patch fix 1 @${STAGE_NODE}:1.1`);
    await input.press("Enter");
    await expect(input).toHaveValue("");
    const panel = await openReferencesPanel(page);
    await panel.getByLabel("Filter references").fill(STAGE_NODE);
    await expect(
      panel.getByText(`Output transport target ${STAGE_NODE}`),
    ).toBeVisible();
    await expect(panel.getByText("OK").first()).toBeVisible();

    await sendCommand(page, {
      module: "SettingsCommand",
      command: { type: "SetNetworkDmxOutputs", data: originalOutputs },
    });
    await expect(panel.getByText("Missing").first()).toBeVisible();
    await panel.getByRole("tab", { name: "Health", exact: true }).click();
    await expect(
      panel.getByText("Missing output transport target", { exact: true }),
    ).toBeVisible();
    await expect(panel.getByText("Manual", { exact: true })).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("references-panel-network-target-health.png"),
      fullPage: true,
    });
  } finally {
    await sendCommand(page, {
      module: "SettingsCommand",
      command: { type: "SetNetworkDmxOutputs", data: originalOutputs },
    });
  }
});

/** Keeps shared filters, empty messages, and both tables usable in a narrow panel. */
test("references shared controls filter and show empty states at narrow widths", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 620, height: 900 });
  const fixtureUid = await createFixture(page);
  await storeStaleGroup(page, fixtureUid);
  const panel = await openReferencesPanel(page);
  const filter = panel.getByRole("textbox", { name: "Filter references" });
  await filter.fill(MISSING_FIXTURE_UID);
  await panel
    .getByRole("combobox", { name: "Reference domain" })
    .selectOption("group");
  await panel.getByRole("checkbox", { name: "Missing", exact: true }).check();
  await expect(
    panel.getByRole("grid", { name: "References", exact: true }),
  ).toHaveAttribute("aria-readonly", "true");
  await expect(
    panel.getByText(`Fixture UID ${MISSING_FIXTURE_UID}`, { exact: true }),
  ).toBeVisible();
  await filter.fill("no-matching-reference");
  await expect(panel.getByRole("status")).toHaveText("No references");
  await panel.getByRole("tab", { name: "Health", exact: true }).click();
  await expect(panel.getByRole("status")).toHaveText("No missing references");
  await filter.fill(MISSING_FIXTURE_UID);
  await expect(
    panel.getByText("Missing fixture UID", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByRole("grid", { name: "Reference health", exact: true }),
  ).toHaveAttribute("aria-readonly", "true");
  await page.screenshot({
    path: testInfo.outputPath("references-shared-narrow.png"),
    fullPage: true,
  });
});
