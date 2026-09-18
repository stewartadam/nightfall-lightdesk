// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, type Page, type Route } from "@playwright/test";

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

/** Waits for the app shell stores, resolving startup showfile prompts first. */
export async function waitForDockviewApp(
  page: Page,
  options: StartupShowfileOptions = {},
): Promise<void> {
  const usesVitePreview =
    process.env.NIGHTFALL_PLAYWRIGHT_VITE_MODE === "preview";
  /** Returns whether startup has finished revealing the interactive shell. */
  const isInteractiveShellReady = () => {
    const stores = (window as any).appStores;
    if (!stores?.dockApi?.get?.() || !stores?.send) return false;

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
  };

  /** Returns whether the active runtime session has completed startup resync. */
  const isRuntimeSessionReady = async () => {
    const [
      { appLifecycle },
      websocket,
      readiness,
      layoutReadiness,
      showfileLoading,
      settings,
      activeLayout,
    ] = await Promise.all([
      import(/* @vite-ignore */ "/state/app-lifecycle.ts"),
      import(/* @vite-ignore */ "/lib/engine-runtime.ts"),
      import(/* @vite-ignore */ "/components/shell/startup/readiness.ts"),
      import(
        /* @vite-ignore */ "/components/shell/docking/layout-readiness.ts"
      ),
      import(/* @vite-ignore */ "/lib/showfile-loading.ts"),
      import(/* @vite-ignore */ "/state/settings.ts"),
      import(/* @vite-ignore */ "/lib/dockview-active-layout.ts"),
    ]);
    const autoOpenName = readiness.e2eAutoOpenStartupShowfileName();
    return (
      appLifecycle.get().phase === "interactive" &&
      websocket.connectionStatus() ===
        websocket.EngineRuntimeStatus.Connected &&
      websocket.resyncComplete() &&
      autoOpenName === null &&
      layoutReadiness.dockviewLayoutShowfileRevision.get() >=
        showfileLoading.currentShowfileRevision.get() &&
      layoutReadiness.dockviewLayoutSettingsSnapshotRevision.get() >=
        settings.$settingsSnapshotRevision.get() &&
      layoutReadiness.dockviewLayoutActiveLayoutKey.get() ===
        activeLayout.activeLayoutKey(
          settings.$settings.get().active_panel_layout,
        )
    );
  };

  /** Lets startup effects settle before accepting a transient ready state. */
  const waitForRenderStability = () =>
    new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });

  try {
    await expect
      .poll(
        async () => {
          const storesReady = await page.evaluate(isInteractiveShellReady);
          if (storesReady) {
            await page.evaluate(waitForRenderStability);
            return (
              (await page.evaluate(isInteractiveShellReady)) &&
              (usesVitePreview
                ? await page.evaluate(() => {
                    const stores = (window as any).appStores;
                    return Boolean(
                      stores?.runtimeCapabilities?.get?.() &&
                        Object.keys(stores?.fixtures?.get?.() ?? {}).length > 0,
                    );
                  })
                : await page.evaluate(isRuntimeSessionReady))
            );
          }

          await resolveStartupDraftRecoveryIfVisible(page);
          await openStartupShowfileIfPrompted(page, options);

          return (
            (await page.evaluate(isInteractiveShellReady)) &&
            (usesVitePreview
              ? await page.evaluate(() => {
                  const stores = (window as any).appStores;
                  return Boolean(
                    stores?.runtimeCapabilities?.get?.() &&
                      Object.keys(stores?.fixtures?.get?.() ?? {}).length > 0,
                  );
                })
              : await page.evaluate(isRuntimeSessionReady))
          );
        },
        { timeout: options.timeoutMs ?? 45_000 },
      )
      .toBe(true);
  } catch (error) {
    if (usesVitePreview) throw error;
    const diagnostics = await page.evaluate(async () => {
      const [
        lifecycle,
        websocket,
        readiness,
        layout,
        showfile,
        settings,
        active,
      ] = await Promise.all([
        import("/state/app-lifecycle.ts"),
        import("/lib/engine-runtime.ts"),
        import("/components/shell/startup/readiness.ts"),
        import("/components/shell/docking/layout-readiness.ts"),
        import("/lib/showfile-loading.ts"),
        import("/state/settings.ts"),
        import("/lib/dockview-active-layout.ts"),
      ]);
      const activeLayoutKey = active.activeLayoutKey(
        settings.$settings.get().active_panel_layout,
      );
      const layoutActiveLayoutKey = layout.dockviewLayoutActiveLayoutKey.get();
      return {
        lifecyclePhase: lifecycle.appLifecycle.get().phase,
        connectionStatus: websocket.connectionStatus(),
        resyncComplete: websocket.resyncComplete(),
        autoOpenName: readiness.e2eAutoOpenStartupShowfileName(),
        autoOpenRequested: readiness.e2eAutoOpenStartupShowfileWasRequested(),
        showfileName: showfile.currentShowfileName.get(),
        showfileRevision: showfile.currentShowfileRevision.get(),
        layoutShowfileRevision: layout.dockviewLayoutShowfileRevision.get(),
        settingsRevision: settings.$settingsSnapshotRevision.get(),
        layoutSettingsRevision:
          layout.dockviewLayoutSettingsSnapshotRevision.get(),
        activeLayoutKeyMatches: activeLayoutKey === layoutActiveLayoutKey,
        activeLayoutKeyLength: activeLayoutKey?.length ?? null,
        layoutActiveLayoutKeyLength: layoutActiveLayoutKey?.length ?? null,
      };
    });
    throw new Error(
      `Dockview startup readiness timed out: ${JSON.stringify(diagnostics)}`,
      { cause: error },
    );
  }

  if (!options.showfileName) return;

  const requestedName = options.showfileName;
  const loadTimeoutMs = options.timeoutMs ?? 45_000;
  const loadDeadline = Date.now() + loadTimeoutMs;

  while (Date.now() < loadDeadline) {
    const requestedShowfileNeedsLoad = await page.evaluate(async (name) => {
      const { currentShowfileName, normalizedShowfileName } = await import(
        "/lib/showfile-loading.ts"
      );
      return currentShowfileName.get() !== normalizedShowfileName(name);
    }, requestedName);
    if (!requestedShowfileNeedsLoad) return;

    const remainingMs = Math.max(1_000, loadDeadline - Date.now());
    try {
      await page.evaluate(
        async ({ requestedName: name, timeoutMs }) => {
          const [{ loadShowfileNameAndAwait }, readiness, websocket] =
            await Promise.all([
              import("/lib/showfile-actions.ts"),
              import("/components/shell/startup/readiness.ts"),
              import("/lib/engine-runtime.ts"),
            ]);
          websocket.markResyncPending();
          await readiness.waitForStartupWorldSwapCommand(
            loadShowfileNameAndAwait(name),
            timeoutMs,
            name,
          );
        },
        { requestedName, timeoutMs: remainingMs },
      );
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.includes("Execution context was destroyed")
      ) {
        throw error;
      }
    }

    await expect
      .poll(
        async () =>
          (await page.evaluate(isInteractiveShellReady)) &&
          (await page.evaluate(isRuntimeSessionReady)),
        { timeout: Math.max(1_000, loadDeadline - Date.now()) },
      )
      .toBe(true);
  }

  throw new Error(`Timed out loading requested showfile ${requestedName}`);
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
 * Freezes the hydrated frontend, clears mutable showfile stores, and verifies a
 * store-driven spec starts with no inherited application data.
 */
export async function prepareStoreSeededTestApp(
  page: Page,
  options: StartupShowfileOptions = {},
): Promise<void> {
  await waitForDockviewApp(page, options);
  await page.evaluate(async () => {
    const { engineRuntime } = await import("/lib/engine-runtime.ts");
    engineRuntime.stop();
  });
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const websocket = await import("/lib/engine-runtime.ts");
        return (
          websocket.connectionStatus() ===
          websocket.EngineRuntimeStatus.Disconnected
        );
      }),
    )
    .toBe(true);

  await page.evaluate(
    ({ arrayStoreNames, nullStoreNames, objectStoreNames }) => {
      const stores = (window as any).appStores;
      const dockApi = stores.dockApi.get();
      const existingFixturePanel = dockApi.getPanel("panel-FixtureGrid");
      const gridReference = dockApi.panels.find(
        (panel: any) =>
          panel.id !== "panel-FixtureGrid" &&
          panel.api.location.type === "grid",
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
