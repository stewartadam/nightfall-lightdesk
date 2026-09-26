// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prepareFreshBackendShowfile } from "./backend-showfile";
import { expect, type Page, test } from "./playwright-fixtures";

const SHOWFILE_FIXTURE_PATH =
  "crates/app/tests/data/procedural-showfile-parse-data.json";
const SHOWFILE_SNAPSHOT_FILENAME = "showfile.json";
const SHOWFILE_FOLDER_EXTENSION = "nightfall-show";
const CURRENT_SHOWFILE_STORAGE_KEY = "nightfall.currentShowfileName";

type SeededStartupDraft = {
  name: string;
  savedDir: string;
  draftDir: string;
};

// Startup prompts only run while the backend has no world loaded (AppState Initialized).
// Seeds go into each test backend's disposable data dir, which teardown deletes.
test.use({ emptyStartupWorld: true });

/** Return a stable folder path for one showfile name under the backend data root. */
function showfileDir(dataRoot: string, name: string): string {
  return join(dataRoot, `${name}.${SHOWFILE_FOLDER_EXTENSION}`);
}

/** Return a stable draft folder path for one showfile name under the backend data root. */
function draftDir(dataRoot: string, name: string): string {
  return join(dataRoot, "drafts", `${name}.${SHOWFILE_FOLDER_EXTENSION}`);
}

/** Write saved and draft showfile folders that the real backend can discover. */
function seedStartupDraft(dataRoot: string, name: string): SeededStartupDraft {
  const savedDir = showfileDir(dataRoot, name);
  const draftShowfileDir = draftDir(dataRoot, name);
  const seed = { name, savedDir, draftDir: draftShowfileDir };

  const savedSnapshot = JSON.parse(readFileSync(SHOWFILE_FIXTURE_PATH, "utf8"));
  const draftSnapshot = {
    ...savedSnapshot,
    metadata: {
      ...savedSnapshot.metadata,
      lastSavedUnixSec:
        Number(savedSnapshot.metadata?.lastSavedUnixSec ?? 0) + 1,
    },
    settings: {
      ...savedSnapshot.settings,
      programmer_auto_select: !savedSnapshot.settings?.programmer_auto_select,
    },
  };

  mkdirSync(savedDir, { recursive: true });
  mkdirSync(draftShowfileDir, { recursive: true });
  writeFileSync(
    join(savedDir, SHOWFILE_SNAPSHOT_FILENAME),
    `${JSON.stringify(savedSnapshot, null, 2)}\n`,
  );
  writeFileSync(
    join(draftShowfileDir, SHOWFILE_SNAPSHOT_FILENAME),
    `${JSON.stringify(draftSnapshot, null, 2)}\n`,
  );

  return seed;
}

/** Prepare the browser to start on a specific recoverable draft showfile. */
async function setStartupShowfile(
  page: Page,
  showfileName: string,
): Promise<void> {
  await page.addInitScript(
    ({ key, value }) => {
      window.localStorage.clear();
      window.localStorage.setItem(key, value);
    },
    { key: CURRENT_SHOWFILE_STORAGE_KEY, value: showfileName },
  );
}

/** Verifies the real backend Load Draft path reaches the full app shell. */
test("loads the app shell after choosing a real startup draft", async ({
  backendSlot,
  page,
}) => {
  const seed = seedStartupDraft(backendSlot.dataDir, "real-load-draft");
  await setStartupShowfile(page, seed.name);

  await page.goto("/?startup:draftRecovery=true");
  const dialog = page.getByRole("dialog", {
    name: `Resume your work on ${seed.name}?`,
  });
  await expect(dialog).toBeVisible();

  await dialog.getByRole("button", { name: "Load Draft" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("button[title='Menu']")).toBeVisible();
});

/** Verifies an already-Ready backend world cannot complete a newly requested swap or hide its failure prompt. */
test("keeps world-swap phases owned while the old world is Ready", async ({
  backendSlot,
  page,
}) => {
  const showfileName = await prepareFreshBackendShowfile(
    backendSlot.backendPort,
  );
  await setStartupShowfile(page, showfileName);
  await page.goto("/");
  await expect(page.locator("button[title='Menu']")).toBeVisible();

  const heldPhases = await page.evaluate(async () => {
    const { appLifecycle, transitionAppLifecycle } = await import(
      "/state/app-lifecycle.ts"
    );
    const { backendAppState } = await import("/lib/engine-runtime.ts");
    const phases: string[] = [backendAppState()];
    try {
      for (const type of [
        "loading-saved",
        "loading-draft",
        "showfile-prompt",
      ] as const) {
        transitionAppLifecycle({ type });
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
        phases.push(appLifecycle.get().phase);
      }
    } finally {
      transitionAppLifecycle({ type: "interactive" });
    }
    return phases;
  });
  expect(heldPhases).toEqual([
    "Ready",
    "startup-loading-saved",
    "startup-loading-draft",
    "startup-showfile-prompt",
  ]);
});

for (const scenario of [
  "both",
  "saved-only",
  "draft-only",
  "neither",
] as const) {
  /** Checks welcome actions against real snapshot deletion and loads the available default. */
  test(`startup availability: ${scenario}`, async ({
    backendSlot,
    page,
  }, testInfo) => {
    const seed = seedStartupDraft(backendSlot.dataDir, `startup-${scenario}`);
    await setStartupShowfile(page, seed.name);
    if (scenario === "draft-only" || scenario === "neither") {
      rmSync(seed.savedDir, { recursive: true });
    }
    if (scenario === "saved-only" || scenario === "neither") {
      rmSync(seed.draftDir, { recursive: true });
    }
    await page.goto("/?startup:draftRecovery=true");
    const dialog = page.getByRole("dialog", {
      name: `Resume your work on ${seed.name}?`,
    });
    if (scenario === "neither") {
      await expect(dialog).toBeHidden();
      await expect(
        page.getByRole("dialog", { name: "Open Showfile", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", {
          name: `Show revisions for ${seed.name}`,
          exact: true,
        }),
      ).toBeHidden();
    } else {
      await expect(dialog).toBeVisible();
      const saved = dialog.getByRole("button", { name: "Keep Saved" });
      const draft = dialog.getByRole("button", { name: "Load Draft" });
      await expect(saved).toBeVisible();
      await expect(draft).toBeVisible();
      if (scenario === "draft-only") await expect(saved).toBeDisabled();
      else await expect(saved).toBeEnabled();
      if (scenario === "saved-only") await expect(draft).toBeDisabled();
      else await expect(draft).toBeEnabled();
      await expect(scenario === "saved-only" ? saved : draft).toBeFocused();
    }
    await page.screenshot({
      path: testInfo.outputPath(`startup-${scenario}.png`),
      animations: "disabled",
    });
    if (scenario !== "neither") {
      await page.keyboard.press("Enter");
      await expect(dialog).toBeHidden();
      await expect(page.locator("button[title='Menu']")).toBeVisible();
    }
  });
}
