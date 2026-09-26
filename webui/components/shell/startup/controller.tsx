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
import * as types from "../../../types";
import {
  bypassBackendReadinessForE2E,
  effectiveBackendAppState,
} from "./readiness";

const log = getLogger(import.meta.url);

interface StartupControllerProps {
  enabled: boolean;
  bypassShowfilePrompt?: boolean;
}

/** Advances app startup through backend readiness and draft discovery. */
export function StartupController(props: StartupControllerProps) {
  const lifecycle = useStore(appLifecycle);
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
