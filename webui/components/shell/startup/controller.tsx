// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { createEffect, createSignal, onCleanup, untrack } from "solid-js";
import type { AvailableShowfilesResponse } from "../../../features/showfile";
import { getBackendUrl } from "../../../lib/api";
import {
  connectionStatus,
  EngineRuntimeStatus,
  resyncComplete,
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
} from "./readiness";

const log = getLogger(import.meta.url);

/** Longest startup waits for the backend's backup role before prompting for a show. */
const BACKUP_ROLE_WAIT_MS = 5_000;

/** Whether the operator chose to continue as the primary of a backup pair at this startup. */
const [continuedAsPrimary, setContinuedAsPrimary] = createSignal(false);

/**
 * Leaves the backup pair dialog to open a show as the primary, then runs the usual draft check
 * and showfile prompt. The dialog stays away for this startup unless this computer becomes a
 * backup again.
 */
export function continueStartupAsPrimary(): void {
  setContinuedAsPrimary(true);
  restartAppLifecycleForBackendSessionReset();
}

/**
 * Returns whether startup should show the backup pair dialog instead of the showfile prompt:
 * this computer follows a primary, or remembers a backup and has not chosen to continue as its
 * primary.
 */
function needsBackupPairPrompt(state: types.BackupState): boolean {
  return !!state.primary_address || (!!state.backup && !continuedAsPrimary());
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
  const [backupRoleWaitOver, setBackupRoleWaitOver] = createSignal(false);
  let backupRoleTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(backupRoleTimer));

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
    // Choosing to continue as primary lasts until this computer becomes a backup again.
    if (backup().primary_address && untrack(continuedAsPrimary)) {
      setContinuedAsPrimary(false);
    }
    if (state.phase === "startup-backup-prompt") {
      // A show is open and, unless this computer follows a primary, sent from here, as after a
      // takeover; a backup opens once it holds its primary's show.
      if (
        backendState === types.AppState.Ready &&
        resyncComplete() &&
        (!backup().primary_address ||
          backup().link === types.BackupLinkStatus.Synced)
      ) {
        transitionAppLifecycle({ type: "interactive" });
        return;
      }
      // After leaving the pair, or continuing as its primary, startup goes on as usual.
      if (!needsBackupPairPrompt(backup())) {
        restartAppLifecycleForBackendSessionReset();
      }
      return;
    }
    // A computer that joins a pair while picking a show, such as a primary that steps down for
    // a backup that took over, gets the pair dialog instead.
    if (
      !props.bypassShowfilePrompt &&
      (state.phase === "startup-showfile-prompt" ||
        state.phase === "startup-draft-prompt") &&
      needsBackupPairPrompt(backup())
    ) {
      transitionAppLifecycle({ type: "backup-prompt" });
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
    // The backup role decides which prompt comes next, so wait for it, but not forever, in case
    // this backend has no backup support. The embedded demo has none and skips every prompt.
    if (
      !props.bypassShowfilePrompt &&
      !backup().available &&
      !backupRoleWaitOver()
    ) {
      backupRoleTimer ??= setTimeout(
        () => setBackupRoleWaitOver(true),
        BACKUP_ROLE_WAIT_MS,
      );
      return;
    }
    // A computer in a backup pair picks its role before any show: a backup takes its show
    // from its primary, and a primary may need to follow a backup that took over.
    if (!props.bypassShowfilePrompt && needsBackupPairPrompt(backup())) {
      transitionAppLifecycle({ type: "backup-prompt" });
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
