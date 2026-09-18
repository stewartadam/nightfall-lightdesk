// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { createEffect, createSignal } from "solid-js";
import { OpenShowfileModal } from "../../../features/showfile";
import { markResyncPending } from "../../../lib/engine-runtime";
import { getLogger } from "../../../lib/logger";
import {
  discardDraftShowfileAndAwait,
  loadDraftShowfileAndAwait,
  loadShowfileNameAndAwait,
  loadShowfileRevisionAndAwait,
  newShowfileAndAwait,
  type OpenShowfileSelection,
  promptForNewShowfileName,
} from "../../../lib/showfile-actions";
import {
  appLifecycle,
  transitionAppLifecycle,
} from "../../../state/app-lifecycle";
import { shouldShowStartupSplash, startupPhaseForLifecycle } from "./model";
import {
  clearE2eAutoOpenStartupShowfileRequest,
  e2eAutoOpenStartupShowfileName,
  loadStartupDraftOnce,
  RECOVERY_COMMAND_TIMEOUT_MS,
  waitForBackendConnection,
  waitForBackendReady,
  waitForStartupWorldSwapCommand,
} from "./readiness";
import { ShowfileDraftRecoveryModal } from "./recovery-modal";
import { StartupSplashTransition } from "./splash";

export { StartupController } from "./controller";

const log = getLogger(import.meta.url);

interface StartupOverlapsProps {
  /** Keeps the startup splash visible while the interactive shell finishes loading. */
  hold?: boolean;
}

/** Renders lifecycle-owned startup overlays and recovery prompts. */
export function StartupOverlaps(props: StartupOverlapsProps) {
  const lifecycle = useStore(appLifecycle);
  const [startupShowfilePickerOpen, setStartupShowfilePickerOpen] =
    createSignal(false);
  let e2eAutoOpenStarted = false;

  /** Returns whether startup is waiting for an explicit showfile selection. */
  const isStartupShowfilePrompt = () =>
    lifecycle().phase === "startup-showfile-prompt";

  /** Returns whether the startup-owned picker should be visible. */
  const showStartupShowfilePicker = () =>
    startupShowfilePickerOpen() || isStartupShowfilePrompt();

  /** Loads a recoverable draft and reveals the app after canonical resync. */
  const loadDraft = async () => {
    const draft = appLifecycle.get().draftRecovery;
    if (!draft?.hasDraft) return;

    transitionAppLifecycle({ type: "loading-draft" });
    try {
      await waitForBackendConnection(RECOVERY_COMMAND_TIMEOUT_MS);
      await loadStartupDraftOnce(
        draft.showfileName,
        RECOVERY_COMMAND_TIMEOUT_MS,
      );
      await waitForBackendReady(RECOVERY_COMMAND_TIMEOUT_MS);
      transitionAppLifecycle({ type: "interactive" });
    } catch (error) {
      log.warn("failed to load startup draft showfile", error);
      transitionAppLifecycle({
        type: "draft-prompt",
        draftRecovery: draft,
        recoveryError:
          error instanceof Error
            ? error.message
            : "Failed to load startup draft showfile",
      });
    }
  };

  /** Reloads canonical saved state after discarding the prompted draft. */
  const keepSaved = async () => {
    const draft = appLifecycle.get().draftRecovery;
    if (!draft?.hasSavedSnapshot) return;

    transitionAppLifecycle({ type: "loading-saved" });
    try {
      await waitForBackendConnection(RECOVERY_COMMAND_TIMEOUT_MS);
      if (draft.hasDraft)
        await discardDraftShowfileAndAwait(draft.showfileName);
      await waitForBackendConnection(RECOVERY_COMMAND_TIMEOUT_MS);
      markResyncPending();
      await waitForStartupWorldSwapCommand(
        loadShowfileNameAndAwait(draft.showfileName),
        RECOVERY_COMMAND_TIMEOUT_MS,
        draft.showfileName,
      );
      transitionAppLifecycle({ type: "interactive" });
    } catch (error) {
      log.warn("failed to keep saved startup showfile", error);
      transitionAppLifecycle({
        type: "draft-prompt",
        draftRecovery: draft,
        recoveryError:
          error instanceof Error
            ? error.message
            : "Failed to keep saved startup showfile",
      });
    }
  };

  /** Opens the startup-owned showfile picker without revealing the shell UI. */
  const openOtherShowfile = () => {
    setStartupShowfilePickerOpen(true);
  };

  /** Closes a picker opened from the draft prompt while preserving required prompts. */
  const closeStartupShowfilePicker = () => {
    if (!isStartupShowfilePrompt()) setStartupShowfilePickerOpen(false);
  };

  /** Loads one startup picker selection and waits for backend resync completion. */
  const loadStartupShowfileSelection = async (
    selection: OpenShowfileSelection,
  ) => {
    if (selection.type === "new") {
      await waitForBackendConnection(RECOVERY_COMMAND_TIMEOUT_MS);
      markResyncPending();
      await waitForStartupWorldSwapCommand(
        newShowfileAndAwait(selection.name),
        RECOVERY_COMMAND_TIMEOUT_MS,
        selection.name,
      );
      return;
    }
    if (selection.type === "draft") {
      await waitForBackendConnection(RECOVERY_COMMAND_TIMEOUT_MS);
      markResyncPending();
      await waitForStartupWorldSwapCommand(
        loadDraftShowfileAndAwait(selection.showfileName),
        RECOVERY_COMMAND_TIMEOUT_MS,
        selection.showfileName,
      );
      return;
    }
    if (selection.type === "revision") {
      await waitForBackendConnection(RECOVERY_COMMAND_TIMEOUT_MS);
      markResyncPending();
      await waitForStartupWorldSwapCommand(
        loadShowfileRevisionAndAwait(
          selection.showfileName,
          selection.revisionName,
        ),
        RECOVERY_COMMAND_TIMEOUT_MS,
        selection.showfileName,
      );
      return;
    }

    if (selection.discardDraft) {
      await waitForBackendConnection(RECOVERY_COMMAND_TIMEOUT_MS);
      await discardDraftShowfileAndAwait(selection.name);
    }
    await waitForBackendConnection(RECOVERY_COMMAND_TIMEOUT_MS);
    markResyncPending();
    await waitForStartupWorldSwapCommand(
      loadShowfileNameAndAwait(selection.name),
      RECOVERY_COMMAND_TIMEOUT_MS,
      selection.name,
    );
  };

  /** Opens a selected showfile before revealing the app shell. */
  const openStartupShowfileSelection = async (
    selection: OpenShowfileSelection,
  ) => {
    const draft = appLifecycle.get().draftRecovery;
    setStartupShowfilePickerOpen(false);
    transitionAppLifecycle({ type: "loading-saved" });
    try {
      await loadStartupShowfileSelection(selection);
      transitionAppLifecycle({ type: "interactive" });
    } catch (error) {
      log.warn("failed to open startup showfile selection", error);
      if (!draft) {
        transitionAppLifecycle({
          type: "showfile-prompt",
          recoveryError:
            error instanceof Error
              ? error.message
              : "Failed to open startup showfile selection",
        });
        throw error;
      }
      transitionAppLifecycle({
        type: "draft-prompt",
        draftRecovery: draft,
        recoveryError:
          error instanceof Error
            ? error.message
            : "Failed to open startup showfile selection",
      });
      throw error;
    }
  };

  /** Auto-opens the saved showfile requested by legacy e2e startup flows. */
  createEffect(() => {
    const phase = lifecycle().phase;
    if (
      e2eAutoOpenStarted ||
      (phase !== "startup-showfile-prompt" && phase !== "interactive")
    ) {
      return;
    }

    const showfileName = e2eAutoOpenStartupShowfileName();
    if (!showfileName) return;
    e2eAutoOpenStarted = true;
    void openStartupShowfileSelection({
      type: "showfile",
      name: showfileName,
    }).finally(clearE2eAutoOpenStartupShowfileRequest);
  });

  /** Prompts for and creates a new showfile from startup recovery. */
  const startNewShowfile = () => {
    void (async () => {
      const showfileName = await promptForNewShowfileName();
      if (!showfileName) return;
      void openStartupShowfileSelection({ type: "new", name: showfileName });
    })();
  };

  return (
    <>
      <StartupSplashTransition
        phase={startupPhaseForLifecycle(lifecycle().phase)}
        visible={shouldShowStartupSplash(
          lifecycle().phase,
          props.hold === true,
        )}
      />
      <ShowfileDraftRecoveryModal
        draft={showStartupShowfilePicker() ? null : lifecycle().draftRecovery}
        error={lifecycle().recoveryError}
        disabled={
          lifecycle().phase === "startup-loading-draft" ||
          lifecycle().phase === "startup-loading-saved"
        }
        onKeepSaved={() => void keepSaved()}
        onLoadDraft={() => void loadDraft()}
        onNewShowfile={startNewShowfile}
        onOpenOther={openOtherShowfile}
      />
      <OpenShowfileModal
        open={showStartupShowfilePicker()}
        onClose={closeStartupShowfilePicker}
        onOpen={openStartupShowfileSelection}
      />
    </>
  );
}
