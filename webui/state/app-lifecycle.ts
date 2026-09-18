// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { atom } from "nanostores";
import type { StartupDraftRecovery } from "../lib/showfile-startup";

export type AppLifecyclePhase =
  | "runtime-initializing"
  | "backend-connecting"
  | "startup-checking-draft"
  | "startup-draft-prompt"
  | "startup-showfile-prompt"
  | "startup-loading-draft"
  | "startup-loading-saved"
  | "interactive";

export type AppLifecycleState = {
  phase: AppLifecyclePhase;
  draftRecovery: StartupDraftRecovery | null;
  recoveryError: string | null;
  startupDraftRecoveryEnabled: boolean;
  startupDraftRecoveryChecked: boolean;
};

export type AppLifecycleTransition =
  | { type: "checking-drafts" }
  | {
      type: "draft-prompt";
      draftRecovery: StartupDraftRecovery;
      recoveryError?: string | null;
    }
  | { type: "showfile-prompt"; recoveryError?: string | null }
  | { type: "loading-draft" }
  | { type: "loading-saved" }
  | { type: "interactive" };

const INITIAL_APP_LIFECYCLE_STATE: AppLifecycleState = {
  phase: "runtime-initializing",
  draftRecovery: null,
  recoveryError: null,
  startupDraftRecoveryEnabled: false,
  startupDraftRecoveryChecked: false,
};
const VITE_FULL_RELOAD_LIFECYCLE_STORAGE_KEY =
  "nightfall.appLifecycle.viteFullReload";
const VITE_FULL_RELOAD_LIFECYCLE_MAX_AGE_MS = 30_000;

/** Returns whether a value is one of the app lifecycle phases. */
function isAppLifecyclePhase(value: unknown): value is AppLifecyclePhase {
  return (
    value === "runtime-initializing" ||
    value === "backend-connecting" ||
    value === "startup-checking-draft" ||
    value === "startup-draft-prompt" ||
    value === "startup-showfile-prompt" ||
    value === "startup-loading-draft" ||
    value === "startup-loading-saved" ||
    value === "interactive"
  );
}

/** Returns whether a value can safely hydrate the lifecycle store from HMR. */
function isAppLifecycleState(value: unknown): value is AppLifecycleState {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<AppLifecycleState>;
  return (
    isAppLifecyclePhase(candidate.phase) &&
    typeof candidate.startupDraftRecoveryEnabled === "boolean" &&
    typeof candidate.startupDraftRecoveryChecked === "boolean"
  );
}

/** Normalizes persisted lifecycle records into a safe restartable shape. */
export function normalizeRestoredAppLifecycleState(
  state: AppLifecycleState,
): AppLifecycleState {
  if (
    state.phase === "startup-loading-draft" ||
    state.phase === "startup-loading-saved"
  ) {
    return {
      ...INITIAL_APP_LIFECYCLE_STATE,
      phase: state.startupDraftRecoveryEnabled
        ? "backend-connecting"
        : "interactive",
      startupDraftRecoveryEnabled: state.startupDraftRecoveryEnabled,
      startupDraftRecoveryChecked: !state.startupDraftRecoveryEnabled,
    };
  }

  return {
    ...INITIAL_APP_LIFECYCLE_STATE,
    ...state,
  };
}

/** Returns sessionStorage when browser policy allows access. */
function getSessionStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** Reads and consumes lifecycle state saved for a Vite-triggered full reload. */
function consumeViteFullReloadLifecycleState(): AppLifecycleState | null {
  const storage = getSessionStorage();
  if (!storage) {
    return null;
  }

  const storedValue = storage.getItem(VITE_FULL_RELOAD_LIFECYCLE_STORAGE_KEY);
  storage.removeItem(VITE_FULL_RELOAD_LIFECYCLE_STORAGE_KEY);
  if (!storedValue) {
    return null;
  }

  try {
    const parsed = JSON.parse(storedValue) as {
      savedAtMs?: unknown;
      state?: unknown;
    };
    if (
      typeof parsed.savedAtMs !== "number" ||
      Date.now() - parsed.savedAtMs > VITE_FULL_RELOAD_LIFECYCLE_MAX_AGE_MS ||
      !isAppLifecycleState(parsed.state)
    ) {
      return null;
    }

    return normalizeRestoredAppLifecycleState(parsed.state);
  } catch {
    return null;
  }
}

/** Saves lifecycle state for the next Vite-triggered full document reload. */
function preserveViteFullReloadLifecycleState(): void {
  const storage = getSessionStorage();
  if (!storage) {
    return;
  }

  try {
    storage.setItem(
      VITE_FULL_RELOAD_LIFECYCLE_STORAGE_KEY,
      JSON.stringify({
        savedAtMs: Date.now(),
        state: appLifecycle.get(),
      }),
    );
  } catch {
    // Best effort only; a failed dev handoff should not affect runtime startup.
  }
}

/** Returns the initial lifecycle state, restoring dev reload state when present. */
function initialAppLifecycleState(): AppLifecycleState {
  const hmrState = import.meta.hot?.data.appLifecycleState;
  if (isAppLifecycleState(hmrState)) {
    return normalizeRestoredAppLifecycleState(hmrState);
  }

  const viteReloadState = consumeViteFullReloadLifecycleState();
  if (viteReloadState) {
    return viteReloadState;
  }

  return INITIAL_APP_LIFECYCLE_STATE;
}

export const appLifecycle = atom<AppLifecycleState>(initialAppLifecycleState());

/** Starts the app lifecycle once per real page load or HMR-preserved session. */
export function beginAppLifecycleStartup(
  startupDraftRecoveryEnabled: boolean,
): void {
  const current = appLifecycle.get();
  if (current.phase !== "runtime-initializing") {
    return;
  }

  appLifecycle.set({
    ...INITIAL_APP_LIFECYCLE_STATE,
    phase: "backend-connecting",
    startupDraftRecoveryEnabled,
    startupDraftRecoveryChecked: !startupDraftRecoveryEnabled,
  });
}

/** Restarts startup flow when a new backend session no longer has a showfile loaded. */
export function restartAppLifecycleForBackendSessionReset(): void {
  const current = appLifecycle.get();
  appLifecycle.set({
    ...INITIAL_APP_LIFECYCLE_STATE,
    phase: "backend-connecting",
    startupDraftRecoveryEnabled: current.startupDraftRecoveryEnabled,
    startupDraftRecoveryChecked: !current.startupDraftRecoveryEnabled,
  });
}

/** Applies an app lifecycle transition while preserving phase invariants. */
export function transitionAppLifecycle(
  transition: AppLifecycleTransition,
): void {
  const current = appLifecycle.get();
  switch (transition.type) {
    case "checking-drafts":
      appLifecycle.set({
        ...current,
        phase: "startup-checking-draft",
        draftRecovery: null,
        recoveryError: null,
      });
      break;
    case "draft-prompt":
      appLifecycle.set({
        ...current,
        phase: "startup-draft-prompt",
        draftRecovery: transition.draftRecovery,
        recoveryError: transition.recoveryError ?? null,
        startupDraftRecoveryChecked: true,
      });
      break;
    case "showfile-prompt":
      appLifecycle.set({
        ...current,
        phase: "startup-showfile-prompt",
        draftRecovery: null,
        recoveryError: transition.recoveryError ?? null,
        startupDraftRecoveryChecked: true,
      });
      break;
    case "loading-draft":
      appLifecycle.set({
        ...current,
        phase: "startup-loading-draft",
        draftRecovery: null,
        recoveryError: null,
        startupDraftRecoveryChecked: true,
      });
      break;
    case "loading-saved":
      appLifecycle.set({
        ...current,
        phase: "startup-loading-saved",
        draftRecovery: null,
        recoveryError: null,
        startupDraftRecoveryChecked: true,
      });
      break;
    case "interactive":
      appLifecycle.set({
        ...current,
        phase: "interactive",
        draftRecovery: null,
        recoveryError: null,
        startupDraftRecoveryChecked: true,
      });
      break;
  }
}

/** Returns whether startup UI should still suppress interactive overlays. */
export function isAppLifecycleStartupActive(): boolean {
  return appLifecycle.get().phase !== "interactive";
}

if (import.meta.hot) {
  import.meta.hot.on("vite:beforeFullReload", () => {
    preserveViteFullReloadLifecycleState();
  });

  import.meta.hot.dispose((data) => {
    data.appLifecycleState = appLifecycle.get();
  });

  import.meta.hot.accept();
}
