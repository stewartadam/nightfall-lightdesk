// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  backendAppState,
  connectionStatus,
  EngineRuntimeCommandDisconnectedError,
  EngineRuntimeStatus,
  markResyncPending,
  resyncComplete,
  resyncGeneration,
} from "../../../lib/engine-runtime";
import { loadDraftShowfileAndAwait } from "../../../lib/showfile-actions";
import {
  currentShowfileName,
  currentShowfileRevision,
  normalizedShowfileName,
  persistCurrentShowfileName,
} from "../../../lib/showfile-loading";
import * as types from "../../../types";

export const RECOVERY_COMMAND_TIMEOUT_MS = 15_000;
const E2E_AUTO_OPEN_STARTUP_SHOWFILE_KEY =
  "nightfall.e2eAutoOpenStartupShowfile";

type StartupDraftLoadOperation = {
  showfileName: string;
  promise: Promise<void>;
};

let startupDraftLoadOperation: StartupDraftLoadOperation | null = null;

/** Waits for the websocket connection required by startup recovery commands. */
export function waitForBackendConnection(timeoutMs: number): Promise<void> {
  if (bypassBackendReadinessForE2E()) return Promise.resolve();
  const startedAt = performance.now();

  return new Promise((resolve, reject) => {
    /** Resolves when connected or rejects after the startup timeout. */
    const checkConnection = () => {
      if (connectionStatus() === EngineRuntimeStatus.Connected) {
        resolve();
        return;
      }
      if (performance.now() - startedAt >= timeoutMs) {
        reject(new Error(`Backend did not reconnect within ${timeoutMs}ms`));
        return;
      }
      requestAnimationFrame(checkConnection);
    };
    checkConnection();
  });
}

/** Waits for connection and the canonical post-world-swap store resync. */
export function waitForBackendReady(
  timeoutMs: number,
  minimumResyncGeneration = -1,
): Promise<void> {
  if (bypassBackendReadinessForE2E()) return Promise.resolve();
  const startedAt = performance.now();

  return new Promise((resolve, reject) => {
    /** Resolves when startup state is usable or rejects after the timeout. */
    const checkReady = () => {
      if (
        connectionStatus() === EngineRuntimeStatus.Connected &&
        resyncComplete() &&
        resyncGeneration() > minimumResyncGeneration
      ) {
        resolve();
        return;
      }
      if (performance.now() - startedAt >= timeoutMs) {
        reject(
          new Error(
            `Backend did not finish startup resync within ${timeoutMs}ms`,
          ),
        );
        return;
      }
      requestAnimationFrame(checkReady);
    };
    checkReady();
  });
}

/** Waits for post-reconnect backend state to confirm the requested showfile. */
function waitForBackendShowfileConfirmation(
  expectedShowfileName: string,
  minimumShowfileRevision: number,
  timeoutMs: number,
): Promise<void> {
  if (bypassBackendReadinessForE2E()) return Promise.resolve();
  const expectedName = normalizedShowfileName(expectedShowfileName);
  const startedAt = performance.now();

  return new Promise((resolve, reject) => {
    /** Resolves after a fresh matching backend notification or rejects on timeout. */
    const checkConfirmation = () => {
      if (
        currentShowfileRevision.get() > minimumShowfileRevision &&
        currentShowfileName.get() === expectedName
      ) {
        resolve();
        return;
      }
      if (performance.now() - startedAt >= timeoutMs) {
        reject(
          new Error(
            `Backend did not confirm startup showfile "${expectedName}" within ${timeoutMs}ms`,
          ),
        );
        return;
      }
      requestAnimationFrame(checkConfirmation);
    };
    checkConfirmation();
  });
}

/** Awaits a world-swap command and its post-swap readiness boundary. */
export async function waitForStartupWorldSwapCommand(
  command: Promise<unknown>,
  timeoutMs: number,
  expectedShowfileName: string,
): Promise<void> {
  const generationBeforeWorldSwap = resyncGeneration();
  const showfileRevisionBeforeWorldSwap = currentShowfileRevision.get();
  let commandDisconnected = false;
  try {
    await command;
  } catch (error) {
    if (!(error instanceof EngineRuntimeCommandDisconnectedError)) throw error;
    commandDisconnected = true;
  }
  await waitForBackendReady(timeoutMs, generationBeforeWorldSwap);
  if (commandDisconnected) {
    await waitForBackendShowfileConfirmation(
      expectedShowfileName,
      showfileRevisionBeforeWorldSwap,
      timeoutMs,
    );
  }
}

/** Loads a startup draft and waits for canonical backend state to resync. */
async function loadStartupDraftAndAwaitResync(
  showfileName: string,
  timeoutMs: number,
): Promise<void> {
  await waitForBackendConnection(timeoutMs);
  markResyncPending();
  await waitForStartupWorldSwapCommand(
    loadDraftShowfileAndAwait(showfileName),
    timeoutMs,
    showfileName,
  );
  persistCurrentShowfileName(showfileName, { bumpRevision: true });
}

/** Reuses an in-flight draft load so preload and user acceptance cannot overlap. */
export function loadStartupDraftOnce(
  showfileName: string,
  timeoutMs: number,
): Promise<void> {
  if (startupDraftLoadOperation?.showfileName === showfileName) {
    return startupDraftLoadOperation.promise;
  }

  const promise = loadStartupDraftAndAwaitResync(showfileName, timeoutMs);
  startupDraftLoadOperation = { showfileName, promise };

  /** Clears the shared operation only when this request still owns it. */
  const clearOperation = () => {
    if (startupDraftLoadOperation?.promise === promise) {
      startupDraftLoadOperation = null;
    }
  };
  promise.then(clearOperation, clearOperation);
  return promise;
}

/** Returns whether explicit recovery tests bypass websocket readiness. */
export function bypassBackendReadinessForE2E(): boolean {
  const params = new URLSearchParams(window.location.search);
  return params.get("startup:bypassBackendReadiness") === "1";
}

/** Returns the e2e-only saved showfile requested for automatic startup opening. */
export function e2eAutoOpenStartupShowfileName(): string | null {
  const params = new URLSearchParams(window.location.search);
  if (
    params.get("e2e") !== "1" ||
    params.get("startup:draftRecovery") === "true"
  ) {
    return null;
  }

  const showfileName = localStorage
    .getItem(E2E_AUTO_OPEN_STARTUP_SHOWFILE_KEY)
    ?.trim();
  if (!showfileName || showfileName === "0" || showfileName === "false") {
    return null;
  }
  return showfileName;
}

/** Returns whether the current document received an e2e auto-open request. */
export function e2eAutoOpenStartupShowfileWasRequested(): boolean {
  return localStorage.getItem(E2E_AUTO_OPEN_STARTUP_SHOWFILE_KEY) !== null;
}

/** Marks the e2e startup showfile request complete for the current document. */
export function clearE2eAutoOpenStartupShowfileRequest(): void {
  localStorage.setItem(E2E_AUTO_OPEN_STARTUP_SHOWFILE_KEY, "0");
}

/** Returns the backend state that should drive startup lifecycle decisions. */
export function effectiveBackendAppState(): ReturnType<typeof backendAppState> {
  return bypassBackendReadinessForE2E()
    ? types.AppState.Initialized
    : backendAppState();
}
