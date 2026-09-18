// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { prepareFreshBackendShowfile } from "./backend-showfile";
import { expect, type Page, test } from "./playwright-fixtures";
import { prepareStoreSeededTestApp } from "./showfile-startup";

const ownedVirtualReferenceCount = 1_200;

/**
 * Opens a panel through the command palette.
 */
async function openPanel(page: Page, panelName: string) {
  await page.getByRole("button", { name: "Open command palette" }).click();
  const commandInput = page.getByPlaceholder("Type a command or search...");
  await expect(commandInput).toBeVisible();
  await commandInput.fill(`Open ${panelName}`);
  await page.keyboard.press("Enter");
}

/**
 * Seeds browser stores with a stale resolved fixture reference for panel checks.
 */
async function seedMissingSelectionReference(page: Page) {
  await page.waitForFunction(() => {
    const stores = (window as any).appStores;
    const fixtureMap = stores.fixtures.get();
    const groupMap = stores.groups.get();
    const hasMissingReference =
      groupMap["group-stale"]?.selection?.source?.type === "Resolved" &&
      groupMap["group-stale"].selection.source.data.some(
        (reference: any) => reference.fixture_uid === "fixture-missing",
      );
    if (fixtureMap["fixture-live"] && hasMissingReference) return true;

    stores.fixtures.set({
      ...fixtureMap,
      "fixture-live": {
        identifiers: {
          id: 1,
          uid: "fixture-live",
          label: "Live Fixture",
        },
        make: "Test",
        model: "Fixture",
        mode: "Default",
        elements: [{ label: "Element 1", parameters: [] }],
      },
    });
    stores.groups.set({
      ...groupMap,
      "group-stale": {
        identifiers: {
          id: 7,
          uid: "group-stale",
          label: "Stale Group",
        },
        selection: {
          source: {
            type: "Resolved",
            data: [
              { fixture_uid: "fixture-live", index: 1 },
              { fixture_uid: "fixture-missing", index: 1 },
            ],
          },
          clauses: [],
        },
        description: "",
      },
    });
    return (
      Boolean(stores.fixtures.get()["fixture-live"]) &&
      stores.groups
        .get()
        ["group-stale"]?.selection?.source?.data?.some(
          (reference: any) => reference.fixture_uid === "fixture-missing",
        )
    );
  });
}

/**
 * Seeds browser stores with an output binding targeting a removed Output transport target.
 */
async function seedMissingOutputTransportTargetReference(page: Page) {
  await page.waitForFunction(() => {
    const stores = (window as any).appStores;
    const snapshot = stores.bindings.get();
    const output = Array.isArray(snapshot.output) ? snapshot.output : [];
    const includesMissingTarget = output.some(
      (binding: any) =>
        binding.target?.type === "Transport" &&
        binding.target?.data?.target === "removed-node",
    );
    if (includesMissingTarget) return true;

    stores.bindings.set({
      ...snapshot,
      output: [
        ...output.filter(
          (binding: any) =>
            binding.target?.type !== "Transport" ||
            binding.target?.data?.target !== "removed-node",
        ),
        {
          source: { type: "Console", data: {} },
          target: { type: "Transport", data: { target: "removed-node" } },
          priority: 0,
          clone: false,
        },
      ],
    });
    return stores.bindings
      .get()
      .output.some(
        (binding: any) =>
          binding.target?.type === "Transport" &&
          binding.target?.data?.target === "removed-node",
      );
  });
}

/**
 * Seeds enough explicit group selections to exercise reference virtualization.
 */
async function seedOwnedVirtualReferenceSet(page: Page): Promise<void> {
  await page.evaluate((referenceCount) => {
    const stores = (window as any).appStores;
    const fixtureUid = "fixture-virtualized-owned";
    stores.fixtures.set({
      [fixtureUid]: {
        identifiers: {
          id: 1,
          uid: fixtureUid,
          label: "Virtualized Reference Fixture",
        },
        make: "Owned",
        model: "Reference Fixture",
        mode: "Default",
        elements: [{ label: "Element 1", parameters: [] }],
      },
    });
    stores.groups.set(
      Object.fromEntries(
        Array.from({ length: referenceCount }, (_, index) => {
          const id = index + 1;
          const uid = `group-virtualized-owned-${id}`;
          return [
            uid,
            {
              identifiers: {
                id,
                uid,
                label: `Virtualized Reference Group ${id}`,
              },
              selection: {
                source: {
                  type: "Resolved",
                  data: [{ fixture_uid: fixtureUid, index: 1 }],
                },
                clauses: [],
              },
              description: "",
            },
          ];
        }),
      ),
    );
  }, ownedVirtualReferenceCount);
  await expect
    .poll(() =>
      page.evaluate(
        () => Object.keys((window as any).appStores.groups.get()).length,
      ),
    )
    .toBe(ownedVirtualReferenceCount);
}

/** Opens each references scenario with disconnected, verified-empty stores. */
test.beforeEach(async ({ backendSlot, page }) => {
  await prepareFreshBackendShowfile(backendSlot.backendPort);
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("nightfall.currentShowfileName", "default");
  });
  await page.goto("/?startup:draftRecovery=false&e2e=1");
  await expect(page.locator("main#app")).toBeVisible();
  await prepareStoreSeededTestApp(page);
});

/**
 * Verifies the References panel renders reverse references and health issues.
 */
test("references panel surfaces missing selection references", async ({
  page,
}, testInfo) => {
  await openPanel(page, "References");
  await seedMissingSelectionReference(page);

  const panel = page.locator('[data-panel-kind="references"]');
  await expect(panel).toBeVisible();
  await panel.getByLabel("Filter references").fill("fixture-missing");
  await expect(panel.getByText("fixture-missing")).toBeVisible();
  await expect(panel.getByText("Missing").first()).toBeVisible();

  await panel.getByRole("tab", { name: "Health", exact: true }).click();
  await expect
    .poll(async () => {
      await seedMissingSelectionReference(page);
      const hasIssue =
        (await panel.getByText("Missing fixture UID").count()) > 0;
      const hasSource = (await panel.getByText("7: Stale Group").count()) > 0;
      const canPrune = await panel
        .getByRole("button", { name: "Prune" })
        .isEnabled();
      return hasIssue && hasSource && canPrune;
    })
    .toBe(true);

  await page.screenshot({
    path: testInfo.outputPath("references-panel-health.png"),
    fullPage: true,
  });
});

/**
 * Verifies the References table virtualizes an owned large reference set.
 */
test("references panel virtualizes large reference sets", async ({ page }) => {
  await seedOwnedVirtualReferenceSet(page);
  await openPanel(page, "References");

  const panel = page.locator('[data-panel-kind="references"]');
  await expect(panel).toBeVisible();
  const table = panel.locator('[data-component="ReferencesTable"]');
  const scroller = table.locator('[data-grid-kind="tanstack"]');
  await expect
    .poll(async () => Number(await table.getAttribute("data-reference-count")))
    .toBeGreaterThan(1000);

  const renderedRows = panel.locator(
    '[role="gridcell"][data-grid-column-key="target"]',
  );
  await expect(renderedRows.first()).toBeVisible();
  const totalReferences = Number(
    await table.getAttribute("data-reference-count"),
  );
  expect(await renderedRows.count()).toBeLessThan(totalReferences);

  await scroller.evaluate((element) => {
    element.scrollTop = Math.floor(element.scrollHeight / 2);
  });
  await expect.poll(() => renderedRows.count()).toBeLessThan(totalReferences);
  await expect(renderedRows.first()).toHaveCSS("height", "36px");
  await page.screenshot({
    path: test.info().outputPath("shared-virtual-references.png"),
    fullPage: true,
  });
});

/**
 * Verifies reference table headers expose draggable resize handles.
 */
test("references panel resizes table columns by dragging headers", async ({
  page,
}, testInfo) => {
  await openPanel(page, "References");

  const panel = page.locator('[data-panel-kind="references"]');
  await expect(panel).toBeVisible();
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
 * Verifies stale output transport target references are visible as manual health issues.
 */
test("references panel surfaces missing output transport targets", async ({
  page,
}, testInfo) => {
  await openPanel(page, "References");

  const panel = page.locator('[data-panel-kind="references"]');
  await expect(panel).toBeVisible();
  await seedMissingOutputTransportTargetReference(page);
  await panel.getByLabel("Filter references").fill("removed-node");
  await expect(
    panel.getByText("Output transport target removed-node"),
  ).toBeVisible();
  await expect(panel.getByText("Missing").first()).toBeVisible();

  await panel.getByRole("tab", { name: "Health", exact: true }).click();
  await expect
    .poll(async () => {
      await seedMissingOutputTransportTargetReference(page);
      const hasIssue =
        (await panel.getByText("Missing Output transport target").count()) > 0;
      const hasTarget =
        (await panel
          .getByText("Output transport target removed-node")
          .count()) > 0;
      return hasIssue && hasTarget;
    })
    .toBe(true);

  await page.screenshot({
    path: testInfo.outputPath("references-panel-network-target-health.png"),
    fullPage: true,
  });
});

/** Keeps shared filters, empty messages, and both tables usable in a narrow panel. */
test("references shared controls filter and show empty states at narrow widths", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 620, height: 900 });
  await openPanel(page, "References");
  await seedMissingSelectionReference(page);
  const panel = page.locator('[data-panel-kind="references"]');
  const filter = panel.getByRole("textbox", { name: "Filter references" });
  await filter.fill("fixture-missing");
  await panel
    .getByRole("combobox", { name: "Reference domain" })
    .selectOption("group");
  await panel.getByRole("checkbox", { name: "Missing", exact: true }).check();
  await expect(
    panel.getByRole("grid", { name: "References", exact: true }),
  ).toHaveAttribute("aria-readonly", "true");
  await expect(
    panel.getByText("fixture-missing", { exact: true }),
  ).toBeVisible();
  await filter.fill("no-matching-reference");
  await expect(panel.getByRole("status")).toHaveText("No references");
  await panel.getByRole("tab", { name: "Health", exact: true }).click();
  await expect(panel.getByRole("status")).toHaveText("No missing references");
  await filter.fill("fixture-missing");
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
