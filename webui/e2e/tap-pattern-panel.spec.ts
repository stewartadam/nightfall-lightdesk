// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

const COMMAND_INPUT_PLACEHOLDER = "Type a command or search...";
const TAP_PATTERN_STORAGE_KEY = "nightfall-tap-pattern-panel:taps";
const TAP_PATTERN_STARTUP_STORAGE_KEY =
  "nightfall.e2eTapPatternStartupPrepared";

/**
 * Returns whether a locator becomes visible within a short timeout.
 */
async function becomesVisible(locator: ReturnType<Page["locator"]>) {
  try {
    await locator.waitFor({ state: "visible", timeout: 1_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Opens a panel through the command palette.
 */
async function openPanel(page: Page, panelName: string) {
  await page.keyboard.press("Meta+Shift+P");

  const commandInput = page.getByPlaceholder(COMMAND_INPUT_PLACEHOLDER);
  if (!(await becomesVisible(commandInput))) {
    await page.keyboard.press("Control+Shift+P");
  }
  if (!(await becomesVisible(commandInput))) {
    await page.getByRole("button", { name: "Open command palette" }).click();
  }
  await expect(commandInput).toBeVisible();
  await commandInput.fill(`Open ${panelName}`);
  await page.keyboard.press("Enter");
}

/**
 * Installs a deterministic clock used by tap capture during the test.
 */
async function installTapClock(page: Page) {
  await page.addInitScript(() => {
    const fallbackNow = Date.now.bind(Date);
    Object.defineProperty(performance, "now", {
      configurable: true,
      value: () =>
        (window as Window & { __tapNow?: number }).__tapNow ?? fallbackNow(),
    });
  });
}

/** Opens the Tap Pattern test shell in a unique blank showfile. */
async function openTapPatternApp(page: Page) {
  const testInfo = test.info();
  const showfileName = `tap-pattern-${testInfo.workerIndex}-${testInfo.retry}-${Date.now()}`;
  await installTapClock(page);
  await page.addInitScript(
    ({ startupStorageKey, tapsStorageKey }) => {
      if (window.sessionStorage.getItem(startupStorageKey) === "true") return;
      window.sessionStorage.setItem(startupStorageKey, "true");
      window.localStorage.removeItem("nightfall.currentShowfileName");
      window.localStorage.removeItem("nightfall.e2eAutoOpenStartupShowfile");
      window.localStorage.removeItem(tapsStorageKey);
    },
    {
      startupStorageKey: TAP_PATTERN_STARTUP_STORAGE_KEY,
      tapsStorageKey: TAP_PATTERN_STORAGE_KEY,
    },
  );
  await page.setViewportSize({ width: 1500, height: 950 });
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
  await expect(page.locator("main#app")).toBeVisible();
}

/**
 * Clicks the segment timeline after setting the fake monotonic timestamp.
 */
async function clickTapAt(page: Page, timeMs: number) {
  await page.evaluate((nextTimeMs) => {
    (window as Window & { __tapNow?: number }).__tapNow = nextTimeMs;
  }, timeMs);
  await page
    .getByRole("button", { name: "Record tap from taps timeline" })
    .click();
}

/**
 * Presses a key after setting the fake monotonic timestamp.
 */
async function keyTapAt(page: Page, timeMs: number, key = "A") {
  await page.evaluate((nextTimeMs) => {
    (window as Window & { __tapNow?: number }).__tapNow = nextTimeMs;
  }, timeMs);
  await page.keyboard.press(key);
}

/**
 * Dispatches a keydown event after setting the fake monotonic timestamp.
 */
async function dispatchKeyDownAt(page: Page, timeMs: number, key: string) {
  await page.evaluate(
    ({ nextTimeMs, keyName }) => {
      (window as Window & { __tapNow?: number }).__tapNow = nextTimeMs;
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: keyName, bubbles: true }),
      );
    },
    { nextTimeMs: timeMs, keyName: key },
  );
}

/**
 * Returns the next sequence identifier available in the app stores.
 */
async function nextSequenceId(page: Page) {
  return page.evaluate(() => {
    const sequences = Object.values(
      (window as any).appStores?.sequences?.get?.() ?? {},
    ) as Array<{ identifiers: { id: number } }>;
    const existingIds = new Set(
      sequences.map((sequence) => sequence.identifiers.id),
    );
    let nextId = 1;
    while (existingIds.has(nextId)) {
      nextId += 1;
    }
    return nextId;
  });
}

/**
 * Reads the generated sequence and cue timing summary from the app stores.
 */
async function sequenceSummary(page: Page, sequenceId: number) {
  return page.evaluate((expectedSequenceId) => {
    const stores = (window as any).appStores;
    const sequence = Object.values(stores.sequences.get()).find(
      (candidate: any) => candidate.identifiers.id === expectedSequenceId,
    ) as any;
    if (!sequence) return null;
    const durationToMs = (duration: any) =>
      duration.secs * 1000 + duration.nanos / 1_000_000;
    const cues = sequence.steps.map((uid: string) => stores.cues.get()[uid]);
    if (cues.some((cue: any) => !cue)) return null;
    return {
      label: sequence.identifiers.label,
      wrap: sequence.wrap,
      stepCount: sequence.steps.length,
      cueLabels: cues.map((cue: any) => cue?.identifiers.label),
      cueInstructionCounts: cues.map((cue: any) => cue?.instructions?.length),
      cuePartCounts: cues.map((cue: any) => cue?.parts?.length),
      triggerTypes: cues.map((cue: any) => cue?.trigger?.type),
      delaysMs: cues.map((cue: any) => durationToMs(cue?.trigger?.data)),
    };
  }, sequenceId);
}

/**
 * Deletes a generated sequence from the backend through the app stores.
 */
async function deleteSequence(page: Page, sequenceId: number) {
  await page.evaluate(async (expectedSequenceId) => {
    const stores = (window as any).appStores;
    await stores?.send?.({
      module: "CueCommand",
      command: { type: "DeleteSequence", data: expectedSequenceId },
    });
  }, sequenceId);
}

/**
 * Validates that armed toolbar actions leave the taps surface keyboard-active.
 */
test("tap pattern panel captures keyboard taps after toolbar arming", async ({
  page,
}) => {
  await openTapPatternApp(page);

  await openPanel(page, "Tap Pattern");
  const panel = page.getByRole("region", { name: "Tap Pattern panel" });
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: "Arm", exact: true }).click();
  await expect(
    panel.getByRole("button", { name: "Disarm", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () => document.activeElement?.getAttribute("aria-label") ?? null,
      ),
    )
    .toBe("Record tap from taps timeline");

  await keyTapAt(page, 10, "1");
  await expect(panel.getByText("1 taps").first()).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate((storageKey) => {
        const stored = window.localStorage.getItem(storageKey);
        return stored ? JSON.parse(stored) : null;
      }, TAP_PATTERN_STORAGE_KEY),
    )
    .toMatchObject({
      taps: [{ id: 1, timeMs: 0, key: "1" }],
    });

  await panel.getByRole("button", { name: "Restart", exact: true }).click();
  await expect(panel.getByText("0 taps").first()).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () => document.activeElement?.getAttribute("aria-label") ?? null,
      ),
    )
    .toBe("Record tap from taps timeline");

  await keyTapAt(page, 20, "2");
  await expect(panel.getByText("1 taps").first()).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate((storageKey) => {
        const stored = window.localStorage.getItem(storageKey);
        return stored ? JSON.parse(stored) : null;
      }, TAP_PATTERN_STORAGE_KEY),
    )
    .toMatchObject({
      taps: [{ id: 1, timeMs: 0, key: "2" }],
    });
});

/**
 * Validates one-shot sequence creation from steady pulse taps.
 */
test("tap pattern panel creates one-shot sequence from steady pulse taps", async ({
  page,
}) => {
  await openTapPatternApp(page);

  await openPanel(page, "Tap Pattern");
  const panel = page.getByRole("region", { name: "Tap Pattern panel" });
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: "Arm", exact: true }).click();

  const expectedSequenceId = await nextSequenceId(page);
  try {
    for (const timeMs of [0, 500, 1000, 1500, 2000]) {
      await keyTapAt(page, timeMs, "A");
    }

    await expect(panel.getByText("5 taps").first()).toBeVisible();
    await expect(panel.getByText("120.0").first()).toBeVisible();
    await expect(
      panel.getByRole("button", {
        name: "Create Sequence",
        exact: true,
      }),
    ).toBeEnabled();
    await panel
      .getByRole("button", { name: "Create Sequence", exact: true })
      .click();
    await expect(
      page.getByText(`Creating sequence ${expectedSequenceId} with 1 step...`),
    ).toBeVisible({ timeout: 1_000 });
    await expect(
      page.getByText(`Created sequence ${expectedSequenceId} with 1 step`),
    ).toBeVisible({ timeout: 10_000 });
    await expect
      .poll(() => sequenceSummary(page, expectedSequenceId), {
        timeout: 10_000,
      })
      .toEqual({
        label: `Tap Pattern ${expectedSequenceId}`,
        wrap: true,
        stepCount: 1,
        cueLabels: ["Step 1"],
        cueInstructionCounts: [0],
        cuePartCounts: [0],
        triggerTypes: ["AfterDelay"],
        delaysMs: [500],
      });
    await expect(
      page.getByRole("tab", {
        name: `Sequence ${expectedSequenceId}: Tap Pattern ${expectedSequenceId}`,
      }),
    ).toBeVisible();
    await expect(
      page.locator('[data-grid-owner="sequence-editor"]').last(),
    ).toBeVisible({ timeout: 20_000 });
  } finally {
    await deleteSequence(page, expectedSequenceId);
  }
});

/**
 * Validates one-shot sequence creation when timeline clicks arm and record taps.
 */
test("tap pattern panel creates one-shot sequence from timeline clicks", async ({
  page,
}) => {
  await openTapPatternApp(page);

  await openPanel(page, "Tap Pattern");
  const panel = page.getByRole("region", { name: "Tap Pattern panel" });
  await expect(panel).toBeVisible();

  const expectedSequenceId = await nextSequenceId(page);
  try {
    for (const timeMs of [50, 225, 375]) {
      await clickTapAt(page, timeMs);
    }

    await expect(panel.getByText("2 taps").first()).toBeVisible();
    await expect(
      panel.getByRole("button", {
        name: "Create Sequence",
        exact: true,
      }),
    ).toBeEnabled();
    await panel
      .getByRole("button", { name: "Create Sequence", exact: true })
      .click();
    await expect(
      page.getByText(`Created sequence ${expectedSequenceId} with 1 step`),
    ).toBeVisible({ timeout: 2_500 });
    await expect
      .poll(() => sequenceSummary(page, expectedSequenceId), {
        timeout: 10_000,
      })
      .toEqual({
        label: `Tap Pattern ${expectedSequenceId}`,
        wrap: true,
        stepCount: 1,
        cueLabels: ["Step 1"],
        cueInstructionCounts: [0],
        cuePartCounts: [0],
        triggerTypes: ["AfterDelay"],
        delaysMs: [150],
      });
    await expect(
      page.getByRole("tab", {
        name: `Sequence ${expectedSequenceId}: Tap Pattern ${expectedSequenceId}`,
      }),
    ).toBeVisible();
    await expect(
      page.locator('[data-grid-owner="sequence-editor"]').last(),
    ).toBeVisible({ timeout: 20_000 });
  } finally {
    await deleteSequence(page, expectedSequenceId);
  }
});

/**
 * Validates one-shot sequence creation from irregular armed timeline clicks.
 */
test("tap pattern panel creates one-shot sequence from irregular timeline clicks", async ({
  page,
}) => {
  await openTapPatternApp(page);

  await openPanel(page, "Tap Pattern");
  const panel = page.getByRole("region", { name: "Tap Pattern panel" });
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: "Arm", exact: true }).click();

  const expectedSequenceId = await nextSequenceId(page);
  try {
    for (const timeMs of [50, 225, 600]) {
      await clickTapAt(page, timeMs);
    }

    await expect(panel.getByText("3 taps").first()).toBeVisible();
    await expect(
      panel.getByRole("button", {
        name: "Create Sequence",
        exact: true,
      }),
    ).toBeEnabled();
    await panel
      .getByRole("button", { name: "Create Sequence", exact: true })
      .click();
    await expect(
      page.getByText(`Creating sequence ${expectedSequenceId} with 3 steps...`),
    ).toBeVisible({ timeout: 1_000 });
    await expect(
      page.getByText(`Created sequence ${expectedSequenceId} with 3 steps`),
    ).toBeVisible({ timeout: 2_500 });
    await expect
      .poll(() => sequenceSummary(page, expectedSequenceId), {
        timeout: 10_000,
      })
      .toEqual({
        label: `Tap Pattern ${expectedSequenceId}`,
        wrap: true,
        stepCount: 3,
        cueLabels: ["Step 1", "Step 2", "Step 3"],
        cueInstructionCounts: [0, 0, 0],
        cuePartCounts: [0, 0, 0],
        triggerTypes: ["AfterDelay", "AfterDelay", "AfterDelay"],
        delaysMs: [275, 175, 375],
      });
    await expect(
      page.getByRole("tab", {
        name: `Sequence ${expectedSequenceId}: Tap Pattern ${expectedSequenceId}`,
      }),
    ).toBeVisible();
    await expect(
      page.locator('[data-grid-owner="sequence-editor"]').last(),
    ).toBeVisible({ timeout: 20_000 });
  } finally {
    await deleteSequence(page, expectedSequenceId);
  }
});

/**
 * Validates click/key tap input, grouped pattern display, and keyboard clearing.
 */
test("tap pattern panel clusters repeated hook taps", async ({ page }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await openTapPatternApp(page);

  await openPanel(page, "Tap Pattern");
  let panel = page.getByRole("region", { name: "Tap Pattern panel" });
  await expect(panel).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Tap", exact: true }),
  ).toHaveCount(0);
  await expect(panel.getByText("Tap Pattern")).toHaveCount(0);
  await expect(panel.getByText("Beats/loop")).toBeVisible();
  await expect(panel.getByLabel("Sensitivity")).toBeVisible();
  await expect(panel.getByLabel("Granularity")).toBeVisible();
  const captureToolbar = panel.getByRole("toolbar", {
    name: "Tap capture controls",
  });
  await expect(captureToolbar).toBeVisible();
  await expect(captureToolbar.getByRole("button")).toHaveCount(4);
  await expect(
    captureToolbar.getByRole("button", { name: "Arm", exact: true }),
  ).toBeVisible();
  await expect(
    captureToolbar.getByRole("button", { name: "Delete last", exact: true }),
  ).toBeVisible();
  await expect(
    captureToolbar.getByRole("button", { name: "Restart", exact: true }),
  ).toBeVisible();
  await expect(
    captureToolbar.getByRole("button", {
      name: "Create Sequence",
      exact: true,
    }),
  ).toBeDisabled();
  await expect(captureToolbar.getByText("Beats/loop")).toHaveCount(0);
  await expect(captureToolbar.getByLabel("Sensitivity")).toHaveCount(0);
  await expect(captureToolbar.getByLabel("Granularity")).toHaveCount(0);
  await expect(
    panel.getByRole("button", { name: "Arm", exact: true }),
  ).toBeVisible();
  await clickTapAt(page, 5);
  await expect(
    panel.getByRole("button", { name: "Disarm", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    panel.getByRole("button", { name: "Arm", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(
    panel.getByRole("button", { name: "Disarm", exact: true }),
  ).toBeVisible();
  await expect(panel.getByText("0 taps").first()).toBeVisible();
  await keyTapAt(page, 10, "ArrowLeft");
  await dispatchKeyDownAt(page, 20, "é");
  await expect(panel.getByText("0 taps").first()).toBeVisible();
  await panel.getByRole("region", { name: "Grouped taps" }).click();
  await keyTapAt(page, 30, "2");
  await expect(panel.getByText("1 taps").first()).toBeVisible();
  await page.keyboard.press("Backspace");
  await expect(panel.getByText("0 taps").first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    panel.getByRole("button", { name: "Arm", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "Global" })
    .click({ position: { x: 20, y: 20 } });
  await keyTapAt(page, 40, "A");
  await expect(panel.getByText("0 taps").first()).toBeVisible();
  await panel
    .getByRole("button", { name: "Record tap from taps timeline" })
    .click();
  await keyTapAt(page, 50, "1");
  await expect(panel.getByText("1 taps").first()).toBeVisible();
  await panel.getByRole("button", { name: "Disarm", exact: true }).click();
  await clickTapAt(page, 60);
  await expect(panel.getByText("1 taps").first()).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "Disarm", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Backspace");
  await expect(panel.getByText("0 taps").first()).toBeVisible();

  const hookTapTimes = Array.from({ length: 6 }).flatMap((_, cycleIndex) =>
    [0, 310, 690].map((phaseMs) => cycleIndex * 2000 + phaseMs),
  );
  for (const [index, timeMs] of hookTapTimes.entries()) {
    if (index % 2 === 0) {
      await clickTapAt(page, timeMs);
    } else {
      await keyTapAt(page, timeMs, String.fromCharCode(65 + index));
    }
  }

  await expect(panel.getByText("Grouped Taps")).toBeVisible();
  await expect(panel.getByText("18 taps").first()).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate((storageKey) => {
        const stored = window.localStorage.getItem(storageKey);
        return stored ? JSON.parse(stored) : null;
      }, TAP_PATTERN_STORAGE_KEY),
    )
    .toMatchObject({
      taps: hookTapTimes.map((timeMs, index) => ({
        id: index + 1,
        timeMs,
        ...(index % 2 === 0 ? {} : { key: String.fromCharCode(65 + index) }),
      })),
      detectionOptions: { sensitivity: 50, granularity: 50 },
    });
  await panel
    .getByRole("button", { name: "Copy captured tap timings" })
    .click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(JSON.stringify(hookTapTimes));
  await panel
    .getByRole("button", { name: "Copy captured tap timings" })
    .click({ modifiers: ["Shift"] });
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(
      JSON.stringify({
        taps: hookTapTimes.map((timeMs, index) => ({
          id: index + 1,
          timeMs,
          ...(index % 2 === 0 ? {} : { key: String.fromCharCode(65 + index) }),
        })),
        detectionOptions: { sensitivity: 50, granularity: 50 },
      }),
    );
  await expect(
    panel.getByRole("cell", { name: "690ms" }).first(),
  ).toBeVisible();
  await expect(panel.getByRole("table", { name: "Pattern steps" })).toHaveClass(
    /nf-table/,
  );
  await page.screenshot({
    path: test.info().outputPath("shared-tap-tables.png"),
    fullPage: true,
  });
  const expectedSequenceId = await page.evaluate(() => {
    const sequences = Object.values(
      (window as any).appStores?.sequences?.get?.() ?? {},
    ) as Array<{ identifiers: { id: number } }>;
    const existingIds = new Set(
      sequences.map((sequence) => sequence.identifiers.id),
    );
    let nextId = 1;
    while (existingIds.has(nextId)) {
      nextId += 1;
    }
    return nextId;
  });
  await expect(
    panel.getByRole("button", {
      name: "Create Sequence",
      exact: true,
    }),
  ).toBeEnabled();
  await panel
    .getByRole("button", { name: "Create Sequence", exact: true })
    .click();
  await expect
    .poll(
      () =>
        page.evaluate((sequenceId) => {
          const stores = (window as any).appStores;
          const sequence = Object.values(stores.sequences.get()).find(
            (candidate: any) => candidate.identifiers.id === sequenceId,
          ) as any;
          if (!sequence) return null;
          const durationToMs = (duration: any) =>
            duration.secs * 1000 + duration.nanos / 1_000_000;
          const cues = sequence.steps.map(
            (uid: string) => stores.cues.get()[uid],
          );
          if (cues.some((cue: any) => !cue)) return null;
          return {
            label: sequence.identifiers.label,
            wrap: sequence.wrap,
            stepCount: sequence.steps.length,
            cueLabels: cues.map((cue: any) => cue?.identifiers.label),
            cueInstructionCounts: cues.map(
              (cue: any) => cue?.instructions?.length,
            ),
            cuePartCounts: cues.map((cue: any) => cue?.parts?.length),
            triggerTypes: cues.map((cue: any) => cue?.trigger?.type),
            delaysMs: cues.map((cue: any) => durationToMs(cue?.trigger?.data)),
          };
        }, expectedSequenceId),
      { timeout: 10_000 },
    )
    .toEqual({
      label: `Tap Pattern ${expectedSequenceId}`,
      wrap: true,
      stepCount: 3,
      cueLabels: ["Step 1", "Step 2", "Step 3"],
      cueInstructionCounts: [0, 0, 0],
      cuePartCounts: [0, 0, 0],
      triggerTypes: ["AfterDelay", "AfterDelay", "AfterDelay"],
      delaysMs: [1310, 310, 380],
    });
  await expect(
    page.getByRole("tab", {
      name: `Sequence ${expectedSequenceId}: Tap Pattern ${expectedSequenceId}`,
    }),
  ).toBeVisible();
  await expect(
    page.locator('[data-grid-owner="sequence-editor"]').last(),
  ).toBeVisible();
  await openPanel(page, "Tap Pattern");
  panel = page.getByRole("region", { name: "Tap Pattern panel" });
  await expect(panel).toBeVisible();
  await expect(
    panel.locator(".rounded-full").filter({ hasText: "3" }),
  ).toBeVisible();
  await panel.getByLabel("Granularity").evaluate((element) => {
    const input = element as HTMLInputElement;
    input.value = "100";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(panel.getByText("Fine")).toBeVisible();
  await expect(panel.getByText("3 steps")).toBeVisible();
  await expect(panel.getByText("6 grouped cycles")).toBeVisible();
  await expect(panel.locator('[data-tap-grouped-scale="true"]')).toBeVisible();
  await expect(
    panel.locator('[data-tap-grouped-scale="true"]').getByText("Beat / ms"),
  ).toBeVisible();
  await expect(
    panel.locator('[data-tap-grouped-scale="true"]').getByText("500ms"),
  ).toBeVisible();
  await panel.getByLabel("Beats/loop").evaluate((element) => {
    const input = element as HTMLInputElement;
    input.value = "3.5";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(
    panel.locator('[data-tap-grouped-scale="true"]').getByText("3.5"),
  ).toBeVisible();
  await expect(
    panel.locator('[data-tap-grouped-scale="true"]').getByText("2.000s"),
  ).toBeVisible();
  await expect(
    panel.locator('[data-tap-grouped-beat-divider="true"]'),
  ).toHaveCount(30);
  await panel.locator('[data-tap-pattern-step="1"]').hover();
  await expect(
    panel.locator(
      "[data-tap-segment-marker='true'][data-highlighted-step='true']",
    ),
  ).toHaveCount(6);
  await expect(
    panel.locator(
      "[data-tap-grouped-marker='true'][data-highlighted-step='true']",
    ),
  ).toHaveCount(6);
  await expect(
    panel.locator(
      "[data-tap-pattern-step-badge='true'][data-highlighted-step='true']",
    ),
  ).toHaveCount(1);
  await panel.getByText("Tap BPM").hover();
  await expect(
    panel.locator(
      "[data-tap-segment-marker='true'][data-highlighted-step='true']",
    ),
  ).toHaveCount(0);
  await panel.locator('[data-tap-grouped-marker="true"]').first().hover();
  await expect(
    panel.locator(
      "[data-tap-segment-marker='true'][data-highlighted-step='true']",
    ),
  ).toHaveCount(6);
  await expect(
    panel.locator(
      "[data-tap-grouped-marker='true'][data-highlighted-step='true']",
    ),
  ).toHaveCount(6);
  await expect(
    panel.locator(
      "[data-tap-pattern-step-badge='true'][data-highlighted-step='true']",
    ),
  ).toHaveCount(1);
  await panel.getByText("Tap BPM").hover();
  await expect(
    panel.locator(
      "[data-tap-segment-marker='true'][data-highlighted-step='true']",
    ),
  ).toHaveCount(0);
  await expect(
    panel.locator(
      "[data-tap-grouped-marker='true'][data-highlighted-step='true']",
    ),
  ).toHaveCount(0);
  await panel.locator('[data-tap-captured-row="true"]').first().hover();
  await expect(
    panel.locator(
      "[data-tap-segment-marker='true'][data-highlighted-step='true']",
    ),
  ).toHaveCount(6);
  await expect(
    panel.locator(
      "[data-tap-grouped-marker='true'][data-highlighted-step='true']",
    ),
  ).toHaveCount(6);
  await expect(
    panel.locator(
      "[data-tap-captured-step='true'][data-highlighted-step='true']",
    ),
  ).toHaveCount(6);
  await expect(
    panel.locator(
      "[data-tap-pattern-step-badge='true'][data-highlighted-step='true']",
    ),
  ).toHaveCount(1);
  await panel.locator('[data-tap-segment-marker="true"]').first().hover();
  await expect(
    panel.locator(
      "[data-tap-grouped-marker='true'][data-highlighted-step='true']",
    ),
  ).toHaveCount(6);
  await expect(
    panel.locator(
      "[data-tap-captured-step='true'][data-highlighted-step='true']",
    ),
  ).toHaveCount(6);
  await expect(
    panel.locator(
      "[data-tap-pattern-step-badge='true'][data-highlighted-step='true']",
    ),
  ).toHaveCount(1);
  await panel.getByText("Tap BPM").hover();
  await expect(
    panel.locator(
      "[data-tap-captured-step='true'][data-highlighted-step='true']",
    ),
  ).toHaveCount(0);
  const segmentTimelineBox = await panel
    .getByRole("button", { name: "Record tap from taps timeline" })
    .boundingBox();
  const segmentMarkerRects = await panel
    .locator('[data-tap-segment-marker="true"]')
    .evaluateAll((elements) =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right };
      }),
    );
  expect(segmentTimelineBox).not.toBeNull();
  expect(segmentMarkerRects).toHaveLength(hookTapTimes.length);
  expect(segmentMarkerRects[0].left).toBeGreaterThan(
    segmentTimelineBox?.x ?? 0,
  );
  expect(segmentMarkerRects[segmentMarkerRects.length - 1].right).toBeLessThan(
    (segmentTimelineBox?.x ?? 0) + (segmentTimelineBox?.width ?? 0),
  );
  const groupedTrackBox = await panel
    .locator('[data-tap-grouped-row-track="true"]')
    .first()
    .boundingBox();
  const groupedMarkerRects = await panel
    .locator('[data-tap-grouped-marker="true"]')
    .evaluateAll((elements) =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right };
      }),
    );
  expect(groupedTrackBox).not.toBeNull();
  expect(groupedMarkerRects).toHaveLength(hookTapTimes.length);
  expect(groupedMarkerRects[0].left).toBeGreaterThan(groupedTrackBox?.x ?? 0);
  expect(groupedMarkerRects[groupedMarkerRects.length - 1].right).toBeLessThan(
    (groupedTrackBox?.x ?? 0) + (groupedTrackBox?.width ?? 0),
  );
  const segmentFirstMarkerCenter =
    (segmentMarkerRects[0].left + segmentMarkerRects[0].right) / 2;
  const groupedFirstMarkerCenter =
    (groupedMarkerRects[0].left + groupedMarkerRects[0].right) / 2;
  const segmentFirstMarkerOffset =
    (segmentFirstMarkerCenter - (segmentTimelineBox?.x ?? 0)) /
    (segmentTimelineBox?.width ?? 1);
  const groupedFirstMarkerOffset =
    (groupedFirstMarkerCenter - (groupedTrackBox?.x ?? 0)) /
    (groupedTrackBox?.width ?? 1);
  expect(
    Math.abs(segmentFirstMarkerOffset - groupedFirstMarkerOffset),
  ).toBeLessThan(0.01);
  const groupedBox = await panel
    .getByRole("region", { name: "Grouped taps" })
    .boundingBox();
  const tablesBox = await panel
    .getByRole("region", { name: "Tap analysis" })
    .boundingBox();
  expect(groupedBox).not.toBeNull();
  expect(tablesBox).not.toBeNull();
  expect((groupedBox?.y ?? 0) + (groupedBox?.height ?? 0)).toBeLessThanOrEqual(
    tablesBox?.y ?? 0,
  );

  await page.reload();
  await expect(page.locator("main#app")).toBeVisible();
  await openPanel(page, "Tap Pattern");
  panel = page.getByRole("region", { name: "Tap Pattern panel" });
  await expect(panel.getByText("18 taps").first()).toBeVisible();
  await expect(panel.getByText("Fine")).toBeVisible();
  await expect(panel.getByText("6 grouped cycles")).toBeVisible();
  await expect(
    panel.getByRole("cell", { name: "690ms" }).first(),
  ).toBeVisible();

  await panel
    .getByRole("button", { name: "Record tap from taps timeline" })
    .focus();
  await page.keyboard.press("Backspace");
  await expect(panel.getByText("0 taps").first()).toBeVisible();
  await expect(panel.getByRole("cell", { name: "690ms" })).toHaveCount(0);

  await panel.getByRole("button", { name: "Arm", exact: true }).click();
  await clickTapAt(page, 5000);
  await expect(panel.getByText("1 taps").first()).toBeVisible();
  await page.keyboard.press("Delete");
  await expect(panel.getByText("0 taps").first()).toBeVisible();
  await page.evaluate(async (sequenceId) => {
    const stores = (window as any).appStores;
    await stores?.send?.({
      module: "CueCommand",
      command: { type: "DeleteSequence", data: sequenceId },
    });
  }, expectedSequenceId);
});
