// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, type Page, type Route } from "@playwright/test";
import { disconnectEngine, waitForTestHooks } from "./app-hooks";

export interface StartupShowfileOptions {
  createIfMissing?: boolean;
  newShowfileName?: string;
  showfileName?: string;
  timeoutMs?: number;
}

export interface AvailableDraftFixture {
  showfileName: string;
  modifiedMs?: number | null;
  savedModifiedMs?: number | null;
  validationStatus?: "unchecked";
}

/** Route full showfile discovery and the targeted draft request in UI tests. */
export async function routeShowfileDiscovery(
  page: Page,
  handler: (route: Route) => Promise<void>,
  draft: AvailableDraftFixture | null = null,
): Promise<void> {
  await Promise.all([
    page.route("**/api/showfiles", handler),
    page.route("**/api/showfiles/*/draft", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ draft }),
      });
    }),
  ]);
}

/** Seeds browser storage so startup opens the requested saved showfile. */
export async function seedStartupShowfileName(
  page: Page,
  showfileName = "default",
): Promise<void> {
  await page.addInitScript((name) => {
    if (window.top !== window) return;
    window.localStorage.setItem("nightfall.currentShowfileName", name);
    window.localStorage.setItem("nightfall.e2eAutoOpenStartupShowfile", name);
  }, showfileName);
}

/** Escapes a string for use inside a regular expression literal. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Returns the accessible-name matcher for a saved showfile revision button. */
function savedShowfileButtonName(showfileName: string): RegExp {
  return new RegExp(
    `^(?:Open saved showfile|Revert to saved showfile) ${escapeRegExp(
      showfileName,
    )}$`,
    "i",
  );
}

/** Returns the accessible-name matcher for one showfile expansion button. */
function showfileToggleButtonName(showfileName: string): RegExp {
  return new RegExp(`^Show revisions for ${escapeRegExp(showfileName)}$`, "i");
}

/** Resolves startup draft recovery when it blocks app hydration. */
export async function resolveStartupDraftRecoveryIfVisible(
  page: Page,
  action: "keep-saved" | "load-draft" = "keep-saved",
): Promise<void> {
  const buttonName = action === "load-draft" ? "Load Draft" : "Keep Saved";
  const button = page.getByRole("button", { name: buttonName });
  if (await button.isVisible({ timeout: 250 }).catch(() => false)) {
    await button.click();
  }
}

/** Creates a named blank showfile through the current startup picker flow. */
async function createNamedShowfileFromPicker(
  page: Page,
  showfileName: string,
): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "Open Showfile" });
  await dialog.getByRole("button", { name: "New showfile" }).click();

  const nameDialog = page.getByRole("dialog", { name: "New Showfile" });
  await expect(nameDialog).toBeVisible();
  await nameDialog.getByLabel("Show name").fill(showfileName);
  await nameDialog.getByRole("button", { name: "Create Show" }).click();
  await expect(nameDialog).not.toBeVisible({ timeout: 10_000 });
}

/** Opens the requested saved showfile when the startup picker is visible. */
export async function openStartupShowfileIfPrompted(
  page: Page,
  options: StartupShowfileOptions = {},
): Promise<void> {
  const showfileName = options.showfileName ?? "default";
  const dialog = page.getByRole("dialog", { name: "Open Showfile" });
  const prompted = await dialog
    .isVisible({ timeout: options.timeoutMs ?? 250 })
    .catch(() => false);
  if (!prompted) return;

  const savedShowfile = dialog.getByRole("button", {
    name: savedShowfileButtonName(showfileName),
  });
  if (!(await savedShowfile.isVisible().catch(() => false))) {
    const showfileToggle = dialog.getByRole("button", {
      name: showfileToggleButtonName(showfileName),
    });
    if (await showfileToggle.isVisible().catch(() => false)) {
      await showfileToggle.click();
      await savedShowfile
        .waitFor({ state: "visible", timeout: 1_000 })
        .catch(() => undefined);
    }
  }

  if (await savedShowfile.isVisible().catch(() => false)) {
    await savedShowfile.click();
    await expect(dialog).not.toBeVisible({ timeout: 10_000 });
    return;
  }

  const retryButton = dialog.getByRole("button", { name: "Retry" });
  if (await retryButton.isVisible().catch(() => false)) {
    await retryButton.click();
    return;
  }

  if (
    await dialog
      .getByText("Loading showfiles...")
      .isVisible()
      .catch(() => false)
  ) {
    return;
  }

  if (options.createIfMissing) {
    await createNamedShowfileFromPicker(
      page,
      options.newShowfileName ?? `e2e-${Date.now()}`,
    );
    await expect(dialog).not.toBeVisible({ timeout: 10_000 });
    return;
  }
}

/**
 * Replaces the loaded show's saved panel layout with the application default layout,
 * so shell tests do not depend on how the demo show author arranged its panels.
 */
export async function resetToDefaultLayout(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Open command palette" }).click();
  const commandInput = page.getByPlaceholder("Type a command or search...");
  await expect(commandInput).toBeVisible();
  await commandInput.fill("Reset Layout");
  await page.keyboard.press("Enter");
  await expect(commandInput).toBeHidden();
  await expect
    .poll(() =>
      page.evaluate(() =>
        Boolean(
          (window as any).appStores?.dockApi
            ?.get?.()
            ?.getPanel?.("panel-FixtureGrid"),
        ),
      ),
    )
    .toBe(true);
  // The default layout re-collapses its edge groups on the next frame; let that
  // settle so callers can expand edges or move panels without being undone.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

/** Returns whether a Playwright error came from a navigation replacing the page mid-call. */
function isNavigationInterruption(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("Execution context was destroyed")
  );
}

/**
 * Waits for the app shell to become interactive on a resynced backend session,
 * resolving startup draft and showfile prompts as they appear. Readiness comes
 * from the app's test hooks, so the wait is event-driven in dev servers and
 * e2e builds alike. With `showfileName`, it then loads that showfile unless it
 * is already current.
 */
export async function waitForDockviewApp(
  page: Page,
  options: StartupShowfileOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 45_000;
  const deadline = Date.now() + timeoutMs;
  /** Returns the time left before the overall startup deadline. */
  const remainingMs = () => Math.max(1_000, deadline - Date.now());

  for (;;) {
    await waitForTestHooks(page, remainingMs());
    let outcome: Awaited<
      ReturnType<Window["__nightfallTest"]["whenStartupSettled"]>
    >;
    try {
      outcome = await page.evaluate(
        (waitMs) =>
          window.__nightfallTest.whenStartupSettled({ timeoutMs: waitMs }),
        remainingMs(),
      );
    } catch (error) {
      if (isNavigationInterruption(error)) continue;
      throw new Error(`Dockview startup readiness timed out`, {
        cause: error,
      });
    }
    if (outcome === "interactive") break;

    if (outcome === "draft-prompt") {
      await resolveStartupDraftRecoveryIfVisible(page);
    } else {
      await openStartupShowfileIfPrompted(page, options);
    }
    // Give the prompt a moment to close before startup is sampled again.
    await page
      .waitForFunction(
        (phase) => window.__nightfallTest?.readiness().lifecyclePhase !== phase,
        outcome === "draft-prompt"
          ? "startup-draft-prompt"
          : "startup-showfile-prompt",
        { timeout: 1_000 },
      )
      .catch(() => undefined);
  }

  // The splash fades out after startup turns interactive; wait until it and
  // the startup picker no longer cover the shell, then let effects settle.
  await page.waitForFunction(
    () => {
      /** Returns whether an element participates visibly in the current layout. */
      const isElementVisible = (element: Element | null) => {
        if (!element) return false;
        const style = window.getComputedStyle(element);
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number(style.opacity) !== 0 &&
          element.getClientRects().length > 0
        );
      };
      return (
        !isElementVisible(
          document.querySelector('[data-testid="startup-splash"]'),
        ) &&
        !isElementVisible(
          document.querySelector('[role="dialog"][aria-label="Open Showfile"]'),
        )
      );
    },
    undefined,
    { timeout: remainingMs() },
  );
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );

  if (!options.showfileName) return;

  const requestedName = options.showfileName;
  try {
    await page.evaluate(
      ({ name, waitMs }) =>
        window.__nightfallTest.showfiles
          .ensureLoaded(name, { timeoutMs: waitMs })
          .then(() => undefined),
      { name: requestedName, waitMs: remainingMs() },
    );
  } catch (error) {
    if (!isNavigationInterruption(error)) throw error;
    await waitForTestHooks(page, remainingMs());
    await page.evaluate(
      ({ name, waitMs }) =>
        window.__nightfallTest.showfiles
          .ensureLoaded(name, { timeoutMs: waitMs })
          .then(() => undefined),
      { name: requestedName, waitMs: remainingMs() },
    );
  }
}

const EMPTY_OBJECT_STORE_NAMES = [
  "activeInstances",
  "blueprints",
  "colorPaths",
  "cueDurationProfiles",
  "cues",
  "clips",
  "fixtureGeometries",
  "fixtures",
  "flows",
  "flowPortValues",
  "flowTriggerTicks",
  "fx",
  "fxModules",
  "groups",
  "masters",
  "sceneObjects",
  "sequenceLookaheadStates",
  "sequences",
  "stepFx",
  "timecodes",
  "timelineBeatgridDetectionStatus",
  "timelineBeatgridPreview",
  "timelineBeatgridProposals",
  "timelineLookaheadActionStatuses",
  "timelineRecordingPreviews",
  "timelineRecordingStates",
  "timelines",
] as const;

const EMPTY_ARRAY_STORE_NAMES = [
  "activeSelectionSpanTargets",
  "attributeMetadata",
  "availableFxModules",
  "colorPathDefaults",
  "controls",
  "dmxUniverseData",
  "fixtureLibrary",
  "inputContributionTrace",
  "midiDevices",
  "midiMappings",
  "objectLibrary",
  "oscMappings",
  "oscSources",
  "programmerSelection",
  "programmerState",
  "visualizerEditSelection",
  "visualizerSceneObjectSelection",
] as const;

const EMPTY_NULL_STORE_NAMES = [
  "layerNavigationRequest",
  "layerObjectNavigationRequest",
  "midiLastEvent",
  "objectProfile",
  "oscLastEvent",
  "oscListenerStatus",
  "patchBindingNavigationRequest",
  "programmerResolvedSelection",
  "programmerSpatialSelection",
  "sceneObjectNavigationRequest",
  "sequenceNavigationRequest",
] as const;

/**
 * Moves the Fixtures panel out of the default layout's collapsed bottom edge
 * group into the main grid and activates it. Specs that dock their own panels
 * "within" Fixtures then get a visible, full-size group instead of a collapsed
 * edge strip.
 */
export async function dockFixturesInMainGrid(page: Page): Promise<void> {
  await page.evaluate(() => {
    const dockApi = (window as any).appStores.dockApi.get();
    const existingFixturePanel = dockApi.getPanel("panel-FixtureGrid");
    const gridReference = dockApi.panels.find(
      (panel: any) =>
        panel.id !== "panel-FixtureGrid" && panel.api.location.type === "grid",
    );
    if (
      existingFixturePanel &&
      existingFixturePanel.api.location.type !== "grid"
    ) {
      existingFixturePanel.api.close();
    }
    const fixturePanel =
      dockApi.getPanel("panel-FixtureGrid") ??
      dockApi.addPanel({
        id: "panel-FixtureGrid",
        component: "FixtureGrid",
        title: "Fixtures",
        params: { initialPanelId: "panel-FixtureGrid" },
        position: gridReference
          ? {
              referencePanel: gridReference.id,
              direction: "within",
            }
          : undefined,
      });
    fixturePanel.api.setActive();
    fixturePanel.focus();
  });
}

/**
 * Freezes the hydrated frontend, clears mutable showfile stores, and verifies a
 * store-driven spec starts with no inherited application data.
 */
export async function prepareStoreSeededTestApp(
  page: Page,
  options: StartupShowfileOptions = {},
): Promise<void> {
  await waitForDockviewApp(page, options);
  await disconnectEngine(page);

  await dockFixturesInMainGrid(page);

  await page.evaluate(
    ({ arrayStoreNames, nullStoreNames, objectStoreNames }) => {
      const stores = (window as any).appStores;

      for (const name of objectStoreNames) {
        stores[name].set({});
      }
      for (const name of arrayStoreNames) {
        stores[name].set([]);
      }
      for (const name of nullStoreNames) {
        stores[name].set(null);
      }
      stores.bindings.set({ disabled: [], input: [], output: [] });
      stores.layerStack.set([]);
      stores.parameters.set(new Map());
    },
    {
      arrayStoreNames: EMPTY_ARRAY_STORE_NAMES,
      nullStoreNames: EMPTY_NULL_STORE_NAMES,
      objectStoreNames: EMPTY_OBJECT_STORE_NAMES,
    },
  );
  await expect
    .poll(() =>
      page.evaluate(
        ({ arrayStoreNames, nullStoreNames, objectStoreNames }) => {
          const stores = (window as any).appStores;
          return {
            arrays: Object.fromEntries(
              arrayStoreNames.map((name) => [name, stores[name].get().length]),
            ),
            bindings:
              stores.bindings.get().input.length +
              stores.bindings.get().output.length +
              stores.bindings.get().disabled.length,
            layerStack: stores.layerStack.get().length,
            nulls: Object.fromEntries(
              nullStoreNames.map((name) => [name, stores[name].get() === null]),
            ),
            objects: Object.fromEntries(
              objectStoreNames.map((name) => [
                name,
                Object.keys(stores[name].get()).length,
              ]),
            ),
            parameters: stores.parameters.get().size,
          };
        },
        {
          arrayStoreNames: EMPTY_ARRAY_STORE_NAMES,
          nullStoreNames: EMPTY_NULL_STORE_NAMES,
          objectStoreNames: EMPTY_OBJECT_STORE_NAMES,
        },
      ),
    )
    .toEqual({
      arrays: Object.fromEntries(
        EMPTY_ARRAY_STORE_NAMES.map((name) => [name, 0]),
      ),
      bindings: 0,
      layerStack: 0,
      nulls: Object.fromEntries(
        EMPTY_NULL_STORE_NAMES.map((name) => [name, true]),
      ),
      objects: Object.fromEntries(
        EMPTY_OBJECT_STORE_NAMES.map((name) => [name, 0]),
      ),
      parameters: 0,
    });
}
