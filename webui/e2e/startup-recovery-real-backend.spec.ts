// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { prepareFreshBackendShowfile } from "./backend-showfile";
import {
  type APIRequestContext,
  expect,
  type Page,
  test,
} from "./playwright-fixtures";

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

type ShowfileListResponse = {
  showfiles?: Array<{ path?: string }>;
};

/** Resolve the backend data root used by the active test backend. */
async function resolveBackendDataRoot(
  request: APIRequestContext,
): Promise<string> {
  const response = await request.get("/api/showfiles");
  const body = (await response.json()) as ShowfileListResponse;
  const existingPath = body.showfiles?.find(
    (showfile) => typeof showfile.path === "string",
  )?.path;
  if (existingPath) {
    return dirname(existingPath);
  }

  if (process.env.NIGHTFALL_DATA_DIR) {
    return process.env.NIGHTFALL_DATA_DIR;
  }

  if (process.platform === "darwin") {
    return join(
      os.homedir(),
      "Library",
      "Application Support",
      "com.nightfall.nightfall",
    );
  }

  if (process.platform === "win32") {
    return join(
      process.env.APPDATA ?? join(os.homedir(), "AppData", "Roaming"),
      "nightfall",
    );
  }

  return join(os.homedir(), ".local", "share", "nightfall");
}

/** Return a stable folder path for one showfile name under the backend data root. */
function showfileDir(dataRoot: string, name: string): string {
  return join(dataRoot, `${name}.${SHOWFILE_FOLDER_EXTENSION}`);
}

/** Return a stable draft folder path for one showfile name under the backend data root. */
function draftDir(dataRoot: string, name: string): string {
  return join(dataRoot, "drafts", `${name}.${SHOWFILE_FOLDER_EXTENSION}`);
}

/** Remove all folders created for a seeded startup draft. */
function cleanupSeededStartupDraft(seed: SeededStartupDraft): void {
  rmSync(seed.savedDir, { force: true, recursive: true });
  rmSync(seed.draftDir, { force: true, recursive: true });
}

/** Write saved and draft showfile folders that the real backend can discover. */
function seedStartupDraft(dataRoot: string, name: string): SeededStartupDraft {
  const savedDir = showfileDir(dataRoot, name);
  const draftShowfileDir = draftDir(dataRoot, name);
  const seed = { name, savedDir, draftDir: draftShowfileDir };
  cleanupSeededStartupDraft(seed);

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
  request,
}) => {
  const dataRoot = await resolveBackendDataRoot(request);
  const seed = seedStartupDraft(dataRoot, "codex-real-load-draft");
  await setStartupShowfile(page, seed.name);

  try {
    await page.goto("/?startup:draftRecovery=true");
    const dialog = page.getByRole("dialog", {
      name: `Resume your work on ${seed.name}?`,
    });
    await expect(dialog).toBeVisible();

    await dialog.getByRole("button", { name: "Load Draft" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator("button[title='Menu']")).toBeVisible();
    // A previously ready world must not complete a newly requested world swap.
    const loadingPhases = await page.evaluate(async () => {
      const { appLifecycle, transitionAppLifecycle } = await import(
        "/state/app-lifecycle.ts"
      );
      const phases: string[] = [];
      try {
        for (const type of ["loading-saved", "loading-draft"] as const) {
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
    expect(loadingPhases).toEqual([
      "startup-loading-saved",
      "startup-loading-draft",
    ]);
  } finally {
    if (existsSync(seed.savedDir) || existsSync(seed.draftDir)) {
      await prepareFreshBackendShowfile(backendSlot.backendPort).catch(
        () => undefined,
      );
    }
    cleanupSeededStartupDraft(seed);
  }
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
    request,
  }, testInfo) => {
    const seed = seedStartupDraft(
      await resolveBackendDataRoot(request),
      `startup-${scenario}`,
    );
    await setStartupShowfile(page, seed.name);
    try {
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
    } finally {
      await prepareFreshBackendShowfile(backendSlot.backendPort).catch(
        () => undefined,
      );
      cleanupSeededStartupDraft(seed);
    }
  });
}
