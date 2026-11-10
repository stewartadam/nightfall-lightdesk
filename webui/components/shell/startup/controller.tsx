// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { createEffect } from "solid-js";
import type { AvailableShowfilesResponse } from "../../../features/showfile";
import { getBackendUrl } from "../../../lib/api";
import {
  connectionStatus,
  EngineRuntimeStatus,
  markResyncPending,
} from "../../../lib/engine-runtime";
import { getLogger } from "../../../lib/logger";
import { expectedStartupShowfileName } from "../../../lib/showfile-loading";
import { selectStartupDraftRecovery } from "../../../lib/showfile-startup";
import {
  appLifecycle,
  beginAppLifecycleStartup,
  restartAppLifecycleForBackendSessionReset,
  transitionAppLifecycle,
} from "../../../state/app-lifecycle";
import { $backupState } from "../../../state/settings";
import * as types from "../../../types";
import {
  bypassBackendReadinessForE2E,
  effectiveBackendAppState,
  waitForBackendReady,
} from "./readiness";

const log = getLogger(import.meta.url);

/** Longest startup waits for a followed primary's show to copy and load. */
const BACKUP_SHOW_COPY_TIMEOUT_MS = 60_000;

/**
 * Shows the loading splash while this computer, as a backup, copies and loads its primary's show,
 * then opens the app. When the show does not arrive in time, falls back to the showfile prompt,
 * where opening a show stops following.
 */
export async function awaitPrimaryShowAtStartup(): Promise<void> {
  transitionAppLifecycle({ type: "loading-saved" });
  try {
    markResyncPending();
    await waitForBackendReady(BACKUP_SHOW_COPY_TIMEOUT_MS);
    transitionAppLifecycle({ type: "interactive" });
  } catch (error) {
    log.warn("the primary's show did not load at startup", error);
    transitionAppLifecycle({
      type: "showfile-prompt",
      recoveryError:
        "Following the primary, but its show has not loaded yet. Open a show to stop following.",
    });
  }
}

interface StartupControllerProps {
  enabled: boolean;
  bypassShowfilePrompt?: boolean;
}

/** Advances app startup through backend readiness and draft discovery. */
export function StartupController(props: StartupControllerProps) {
  const lifecycle = useStore(appLifecycle);
  const backup = useStore($backupState);
  let draftCheckInFlight = false;

  beginAppLifecycleStartup(props.enabled);

  /** Checks saved and draft availability for the last-used showfile after initialization. */
  const checkStartupDraftRecovery = async () => {
    draftCheckInFlight = true;
    transitionAppLifecycle({ type: "checking-drafts" });
    try {
      const expectedShowfileName = expectedStartupShowfileName();
      const response = await fetch(`${getBackendUrl()}/api/showfiles`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const body = (await response.json()) as AvailableShowfilesResponse;
      const recovery = selectStartupDraftRecovery(
        body.showfiles,
        expectedShowfileName,
      );
      if (!recovery) {
        transitionAppLifecycle({ type: "showfile-prompt" });
        return;
      }
      transitionAppLifecycle({ type: "draft-prompt", draftRecovery: recovery });
    } catch (error) {
      log.warn("failed to check startup showfile drafts", error);
      transitionAppLifecycle({
        type: "showfile-prompt",
        recoveryError: "Could not check startup showfile drafts.",
      });
    } finally {
      draftCheckInFlight = false;
    }
  };

  /** Advances startup UI from backend state without implicitly loading showfiles. */
  createEffect(() => {
    const state = lifecycle();
    const backendState = effectiveBackendAppState();

    if (
      state.phase === "interactive" &&
      backendState === types.AppState.Initialized &&
      !props.bypassShowfilePrompt &&
      !bypassBackendReadinessForE2E() &&
      connectionStatus() === EngineRuntimeStatus.Connected
    ) {
      restartAppLifecycleForBackendSessionReset();
      return;
    }
    // A backup restored at startup loads its primary's show on its own; once it has, the
    // prompt to pick a show no longer applies.
    if (
      (state.phase === "startup-showfile-prompt" ||
        state.phase === "startup-draft-prompt") &&
      backendState === types.AppState.Ready &&
      backup().primary_address &&
      backup().link === types.BackupLinkStatus.Synced
    ) {
      transitionAppLifecycle({ type: "interactive" });
      return;
    }
    // Prompt and world-swap phases are owned by the user's recovery choice.
    // The old world's Ready state can remain visible while a swap is in
    // flight or after it fails back to a prompt.
    if (
      state.phase !== "backend-connecting" &&
      state.phase !== "startup-checking-draft"
    )
      return;
    if (backendState === types.AppState.Ready) {
      transitionAppLifecycle({ type: "interactive" });
      return;
    }
    if (
      draftCheckInFlight ||
      backendState !== types.AppState.Initialized ||
      (!bypassBackendReadinessForE2E() &&
        connectionStatus() !== EngineRuntimeStatus.Connected)
    ) {
      return;
    }
    // A backup takes its show from its primary, so it skips the prompt and waits for the copy.
    if (props.enabled && backup().primary_address) {
      draftCheckInFlight = true;
      void awaitPrimaryShowAtStartup().finally(() => {
        draftCheckInFlight = false;
      });
      return;
    }
    if (!props.enabled || state.startupDraftRecoveryChecked) {
      transitionAppLifecycle({
        type: props.bypassShowfilePrompt ? "interactive" : "showfile-prompt",
      });
      return;
    }
    void checkStartupDraftRecovery();
  });

  return null;
}
