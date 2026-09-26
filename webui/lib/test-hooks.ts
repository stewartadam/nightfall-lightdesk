// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * The supported surface end-to-end tests use to observe and drive the app.
 *
 * `window.__nightfallTest` exposes lifecycle promises (shell interactive,
 * resync complete, layout applied, showfile loaded) and a few runtime
 * handles. Stores stay on `window.appStores`. Browser-side harnesses and the
 * app internals white-box specs need load through `window.__nightfallHarness`,
 * which only dev servers and e2e builds include.
 */

import type { ReadableAtom } from "nanostores";
import { createEffect, createRoot, createSignal } from "solid-js";
import { registerUiAction } from "../components/providers/command-registry";
import {
  dockviewLayoutSettingsSnapshotRevision,
  dockviewLayoutShowfileRevision,
} from "../components/shell/docking/layout-readiness";
import {
  e2eAutoOpenStartupShowfileName,
  e2eAutoOpenStartupShowfileSettled,
  waitForStartupWorldSwapCommand,
} from "../components/shell/startup/readiness";
import type { NightfallHarness } from "../e2e/harness/registry";
import { type AppLifecyclePhase, appLifecycle } from "../state/app-lifecycle";
import { $settings, $settingsSnapshotRevision } from "../state/settings";
import {
  backendAppState,
  connectionStatus,
  EngineRuntimeStatus,
  engineRuntime,
  markResyncPending,
  resyncComplete,
  resyncGeneration,
} from "./engine-runtime";
import {
  loadShowfileNameAndAwait,
  saveNamedShowfileCommand,
} from "./showfile-actions";
import {
  currentShowfileName,
  currentShowfileRevision,
  normalizedShowfileName,
} from "./showfile-loading";
import { testHooksEnabled } from "./test-mode";

/** Startup and layout signals a test waits on, sampled at one instant. */
export type TestReadiness = {
  lifecyclePhase: AppLifecyclePhase;
  connectionStatus: EngineRuntimeStatus;
  resyncComplete: boolean;
  resyncGeneration: number;
  /** Whether the e2e startup showfile request is still waiting to open. */
  startupAutoOpenPending: boolean;
  showfileName: string;
  showfileRevision: number;
  layoutShowfileRevision: number;
  settingsRevision: number;
  layoutSettingsRevision: number;
  /** Whether Dockview applied the layout for the current showfile and settings. */
  layoutApplied: boolean;
  /** Whether startup finished and a resynced backend session drives the shell. */
  shellInteractive: boolean;
};

/** Where startup stands once it no longer advances without the user. */
export type StartupOutcome = "interactive" | "draft-prompt" | "showfile-prompt";

/** Options shared by every lifecycle wait. */
export type WaitOptions = {
  /** Rejects with the last readiness snapshot after this long. Defaults to 45 s. */
  timeoutMs?: number;
};

/** Lifecycle promises and runtime handles published on `window.__nightfallTest`. */
export type NightfallTestHooks = {
  /** Samples the current startup and layout signals. */
  readiness(): TestReadiness;
  /**
   * Resolves once startup is interactive, or stops at a startup prompt that
   * needs the test to choose a showfile or resolve a draft.
   */
  whenStartupSettled(options?: WaitOptions): Promise<StartupOutcome>;
  /** Resolves once the shell is interactive and its layout is applied. */
  whenShellInteractive(options?: WaitOptions): Promise<TestReadiness>;
  /** Resolves once a resync newer than `afterGeneration` has completed. */
  whenResynced(
    afterGeneration: number,
    options?: WaitOptions,
  ): Promise<TestReadiness>;
  /** Resolves once Dockview applied the layout for the current showfile and settings. */
  whenLayoutApplied(options?: WaitOptions): Promise<TestReadiness>;
  /** Resolves once the named showfile is loaded and the shell is interactive again. */
  whenShowfileLoaded(
    name: string,
    options?: WaitOptions,
  ): Promise<TestReadiness>;
  /** Engine runtime handles, named as `lib/engine-runtime` exports them. */
  runtime: {
    /** The engine runtime facade; tests may wrap its methods to observe traffic. */
    engineRuntime: typeof engineRuntime;
    EngineRuntimeStatus: typeof EngineRuntimeStatus;
    connectionStatus: typeof connectionStatus;
    resyncComplete: typeof resyncComplete;
    resyncGeneration: typeof resyncGeneration;
    backendAppState: typeof backendAppState;
    markResyncPending: typeof markResyncPending;
    /** Stops the engine and resolves once the connection reports disconnected. */
    disconnect(options?: WaitOptions): Promise<void>;
  };
  showfiles: {
    /**
     * Loads a saved showfile through the backend and waits for the world swap,
     * the resync and the backend's confirmation of the new showfile.
     */
    load(name: string, options?: WaitOptions): Promise<void>;
    /**
     * Loads the named showfile unless it is already current, then resolves
     * once the shell is interactive on it.
     */
    ensureLoaded(name: string, options?: WaitOptions): Promise<TestReadiness>;
    /** Sends a world-swapping desk command and waits like `load`. */
    swapWorld(
      command: unknown,
      expectedShowfileName: string,
      options?: WaitOptions,
    ): Promise<void>;
    /** Returns the desk command that saves the current show under a name. */
    saveNamedCommand: typeof saveNamedShowfileCommand;
  };
  uiActions: {
    /**
     * Registers a UI action as a mounted panel would, returning the disposer its unmount runs.
     */
    register: typeof registerUiAction;
  };
};

const DEFAULT_TIMEOUT_MS = 45_000;

const readinessAtoms: ReadableAtom<unknown>[] = [
  appLifecycle,
  currentShowfileName,
  currentShowfileRevision,
  dockviewLayoutShowfileRevision,
  dockviewLayoutSettingsSnapshotRevision,
  $settings,
  $settingsSnapshotRevision,
  e2eAutoOpenStartupShowfileSettled,
];

/** Samples the startup and layout signals that decide test readiness. */
function readiness(): TestReadiness {
  const showfileRevision = currentShowfileRevision.get();
  const settingsRevision = $settingsSnapshotRevision.get();
  const layoutShowfileRevision = dockviewLayoutShowfileRevision.get();
  const layoutSettingsRevision = dockviewLayoutSettingsSnapshotRevision.get();
  const layoutApplied =
    layoutShowfileRevision >= showfileRevision &&
    layoutSettingsRevision >= settingsRevision;
  const startupAutoOpenPending = e2eAutoOpenStartupShowfileName() !== null;
  const lifecyclePhase = appLifecycle.get().phase;
  const status = connectionStatus();
  const resynced = resyncComplete();
  return {
    lifecyclePhase,
    connectionStatus: status,
    resyncComplete: resynced,
    resyncGeneration: resyncGeneration(),
    startupAutoOpenPending,
    showfileName: currentShowfileName.get(),
    showfileRevision,
    layoutShowfileRevision,
    settingsRevision,
    layoutSettingsRevision,
    layoutApplied,
    shellInteractive:
      lifecyclePhase === "interactive" &&
      status === EngineRuntimeStatus.Connected &&
      resynced &&
      !startupAutoOpenPending &&
      layoutApplied,
  };
}

/**
 * Resolves with the first readiness snapshot `accept` maps to a value. It
 * re-evaluates whenever a runtime signal or readiness store changes, and
 * rejects with the last snapshot when the timeout elapses.
 */
function waitForReadiness<Result>(
  description: string,
  accept: (state: TestReadiness) => Result | undefined,
  options: WaitOptions = {},
): Promise<Result> {
  return new Promise((resolve, reject) => {
    createRoot((dispose) => {
      const [storeChange, setStoreChange] = createSignal(0);
      const unlisteners = readinessAtoms.map((store) =>
        store.listen(() => setStoreChange((count) => count + 1)),
      );
      let settled = false;
      /** Releases the watcher once the wait resolves or times out. */
      const finish = () => {
        settled = true;
        window.clearTimeout(timer);
        for (const unlisten of unlisteners) unlisten();
        queueMicrotask(dispose);
      };
      const timer = window.setTimeout(() => {
        if (settled) return;
        finish();
        reject(
          new Error(
            `Timed out waiting for ${description}: ${JSON.stringify(readiness())}`,
          ),
        );
      }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

      /** Re-evaluates readiness on every tracked signal or store change. */
      createEffect(() => {
        storeChange();
        if (settled) return;
        const state = readiness();
        const result = accept(state);
        if (result === undefined) return;
        finish();
        resolve(result);
      });
    });
  });
}

/** Maps a readiness snapshot to its startup outcome, if startup has settled. */
function startupOutcome(state: TestReadiness): StartupOutcome | undefined {
  if (state.shellInteractive) return "interactive";
  if (state.startupAutoOpenPending) return undefined;
  if (state.lifecyclePhase === "startup-draft-prompt") return "draft-prompt";
  if (state.lifecyclePhase === "startup-showfile-prompt") {
    return "showfile-prompt";
  }
  return undefined;
}

/** Sends a world-swapping desk command and waits for the swapped world to be ready. */
function swapWorld(
  command: unknown,
  expectedShowfileName: string,
  options: WaitOptions = {},
): Promise<void> {
  markResyncPending();
  return waitForStartupWorldSwapCommand(
    engineRuntime.sendCommandAndAwait({ module: "DeskCommand", command }),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    expectedShowfileName,
  );
}

/** Loads a saved showfile and waits for its world swap and resync. */
function loadShowfile(name: string, options: WaitOptions = {}): Promise<void> {
  markResyncPending();
  return waitForStartupWorldSwapCommand(
    loadShowfileNameAndAwait(name),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    name,
  );
}

/** Resolves once the named showfile is current and the shell is interactive. */
function whenShowfileLoaded(
  name: string,
  options?: WaitOptions,
): Promise<TestReadiness> {
  const expectedName = normalizedShowfileName(name);
  return waitForReadiness(
    `showfile ${expectedName}`,
    (state) =>
      state.shellInteractive && state.showfileName === expectedName
        ? state
        : undefined,
    options,
  );
}

/** Loads the named showfile unless it is current, then waits for the shell. */
async function ensureShowfileLoaded(
  name: string,
  options?: WaitOptions,
): Promise<TestReadiness> {
  if (currentShowfileName.get() !== normalizedShowfileName(name)) {
    await loadShowfile(name, options);
  }
  return whenShowfileLoaded(name, options);
}

/** Builds the hooks object the app publishes for tests. */
function createTestHooks(): NightfallTestHooks {
  return {
    readiness,
    whenStartupSettled: (options) =>
      waitForReadiness("startup to settle", startupOutcome, options),
    whenShellInteractive: (options) =>
      waitForReadiness(
        "the interactive shell",
        (state) => (state.shellInteractive ? state : undefined),
        options,
      ),
    whenResynced: (afterGeneration, options) =>
      waitForReadiness(
        `a resync after generation ${afterGeneration}`,
        (state) =>
          state.resyncComplete && state.resyncGeneration > afterGeneration
            ? state
            : undefined,
        options,
      ),
    whenLayoutApplied: (options) =>
      waitForReadiness(
        "the layout to apply",
        (state) => (state.layoutApplied ? state : undefined),
        options,
      ),
    whenShowfileLoaded,
    runtime: {
      engineRuntime,
      EngineRuntimeStatus,
      connectionStatus,
      resyncComplete,
      resyncGeneration,
      backendAppState,
      markResyncPending,
      disconnect: (options) => {
        engineRuntime.stop();
        return waitForReadiness(
          "the engine to disconnect",
          (state) =>
            state.connectionStatus === EngineRuntimeStatus.Disconnected
              ? true
              : undefined,
          options,
        ).then(() => undefined);
      },
    },
    showfiles: {
      load: loadShowfile,
      ensureLoaded: ensureShowfileLoaded,
      swapWorld,
      saveNamedCommand: saveNamedShowfileCommand,
    },
    uiActions: {
      register: registerUiAction,
    },
  };
}

/**
 * Loads one browser-side harness from the registry's lazy chunk. Shipped
 * builds alias the registry to a stub that rejects, so they carry no harnesses.
 */
const loadHarness: NightfallHarness["load"] = (name) =>
  import("../e2e/harness/registry").then((registry) =>
    registry.loadHarness(name),
  );

/** Publishes `window.__nightfallTest` and the harness loader when tests may use them. */
export function installTestHooks(): void {
  if (typeof window === "undefined" || !testHooksEnabled()) return;
  const testWindow = window as typeof window & {
    __nightfallTest?: NightfallTestHooks;
    __nightfallHarness?: NightfallHarness;
  };
  testWindow.__nightfallTest = createTestHooks();
  testWindow.__nightfallHarness ??= { load: loadHarness };
}
