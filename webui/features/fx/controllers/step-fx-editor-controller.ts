// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import {
  connectionStatus,
  EngineRuntimeStatus,
  resyncComplete,
} from "../../../lib/engine-runtime";
import {
  startStepFxPreview,
  stopStepFxPreview,
  storeStepFxAndWait,
  updateStepFxPreview,
} from "../../../lib/fx-service";
import {
  activeInstances as activeInstancesStore,
  pushToast,
  stepFx as stepFxStore,
} from "../../../state/appStores";
import type * as types from "../../../types";
import {
  canRestartStepFxPreview,
  cloneStepFx,
  stepFxEquals,
  validateStepFxDraft,
} from "../model/step-fx-editor-model";
import { findStepFxPreviewStatus } from "../model/step-fx-preview-clock";

const AUTO_SAVE_DELAY_MS = 400;

interface StepFxEditorControllerOptions {
  initialUid: string;
  initialDraft?: types.StepFx;
  initialPreviewActive: boolean;
  /** Requests presentation-layer closure after an unedited definition is deleted. */
  onCleanDeletion?: () => void;
}

/** Owns the local draft, persistence acknowledgements, and preview session for one editor. */
export function createStepFxEditorController(
  options: StepFxEditorControllerOptions,
) {
  const $stepFx = useStore(stepFxStore);
  const $activeInstances = useStore(activeInstancesStore);
  const initialUid = options.initialUid;
  const initialDraft = options.initialDraft
    ? cloneStepFx(options.initialDraft)
    : undefined;
  const previewSessionId = crypto.randomUUID();
  let previewStarted = false;
  let previewTimer: ReturnType<typeof setTimeout> | undefined;
  let autoSaveTimer: ReturnType<typeof setTimeout> | undefined;
  const [draft, setDraft] = createSignal<types.StepFx | undefined>(
    initialDraft,
  );
  const [baseline, setBaseline] = createSignal<types.StepFx | undefined>(
    initialDraft ? cloneStepFx(initialDraft) : undefined,
  );
  const [isNew, setIsNew] = createSignal(Boolean(initialDraft));
  const [saving, setSaving] = createSignal(false);
  const [saveError, setSaveError] = createSignal<string>();
  const [conflict, setConflict] = createSignal(false);
  const [pendingSave, setPendingSave] = createSignal<types.StepFx>();
  const [saveCommandSucceeded, setSaveCommandSucceeded] = createSignal(false);
  const [deletedExternally, setDeletedExternally] = createSignal(false);
  const [previewActive, setPreviewActive] = createSignal(
    options.initialPreviewActive,
  );
  /** Reports whether the complete local definition differs from persisted state. */
  const isDirty = createMemo(() => {
    const current = draft();
    const stored = baseline();
    return Boolean(
      current && (isNew() || !stored || !stepFxEquals(current, stored)),
    );
  });

  /** Computes all backend-compatible structural errors for the current draft. */
  const issues = createMemo(() => {
    const current = draft();
    return current ? validateStepFxDraft(current) : [];
  });

  /** Selects only this editor session's backend-authored preview clock anchor. */
  const previewStatus = createMemo(() =>
    findStepFxPreviewStatus($activeInstances(), previewSessionId),
  );

  /** Loads stored state, acknowledges saves, and detects concurrent replacement. */
  createEffect(() => {
    const stored = $stepFx()[initialUid];
    const current = draft();
    const pending = pendingSave();
    if (!current && stored) {
      setDraft(cloneStepFx(stored));
      setBaseline(cloneStepFx(stored));
      setIsNew(false);
      return;
    }
    if (!stored && current && !isNew() && !deletedExternally()) {
      setDeletedExternally(true);
      setConflict(false);
      setPendingSave(undefined);
      setSaveCommandSucceeded(false);
      setSaving(false);
      if (autoSaveTimer) clearTimeout(autoSaveTimer);
      autoSaveTimer = undefined;
      if (previewTimer) clearTimeout(previewTimer);
      previewTimer = undefined;
      if (previewStarted) stopStepFxPreview(previewSessionId);
      previewStarted = false;
      setPreviewActive(false);
      if (!isDirty()) {
        if (options.onCleanDeletion) options.onCleanDeletion();
        else {
          setDraft(undefined);
          setBaseline(undefined);
        }
      }
      return;
    }
    if (!stored || !current) return;
    if (pending) {
      if (!saveCommandSucceeded()) return;
      const editedDuringSave = !stepFxEquals(current, pending);
      setBaseline(cloneStepFx(stored));
      if (!editedDuringSave && !stepFxEquals(current, stored))
        setDraft(cloneStepFx(stored));
      setPendingSave(undefined);
      setSaveCommandSucceeded(false);
      setSaving(false);
      setIsNew(false);
      setConflict(false);
      return;
    }
    const previous = baseline();
    if (previous && !stepFxEquals(stored, previous)) {
      if (isDirty()) {
        setConflict(true);
      } else {
        setDraft(cloneStepFx(stored));
        setBaseline(cloneStepFx(stored));
      }
    }
  });

  /** Starts or updates only this editor's preview when the draft is valid. */
  createEffect(() => {
    const current = draft();
    const valid = issues().length === 0;
    const enabled = previewActive();
    const connected = connectionStatus() === EngineRuntimeStatus.Connected;
    const synchronized = resyncComplete();
    if (
      !current ||
      !valid ||
      !enabled ||
      deletedExternally() ||
      !connected ||
      !synchronized
    )
      return;
    if (!previewStarted) {
      previewStarted = startStepFxPreview(
        previewSessionId,
        cloneStepFx(current),
      );
      return;
    }
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(
      () => updateStepFxPreview(previewSessionId, cloneStepFx(current)),
      150,
    );
  });

  let wasConnected = connectionStatus() === EngineRuntimeStatus.Connected;
  let restartPreviewAfterResync = false;

  /** Remembers enabled preview ownership across websocket reconnection. */
  createEffect(() => {
    const connected = connectionStatus() === EngineRuntimeStatus.Connected;
    if (connected && !wasConnected && previewActive())
      restartPreviewAfterResync = true;
    wasConnected = connected;
  });

  /** Recreates this editor's session only after the backend resync completes. */
  createEffect(() => {
    if (!resyncComplete() || !restartPreviewAfterResync) return;
    restartPreviewAfterResync = false;
    const current = draft();
    if (
      current &&
      canRestartStepFxPreview({
        previewActive: previewActive(),
        deletedExternally: deletedExternally(),
        hasValidDraft: issues().length === 0,
      })
    ) {
      previewStarted = startStepFxPreview(
        previewSessionId,
        cloneStepFx(current),
      );
    }
  });

  /** Applies an immutable edit to the complete local draft. */
  const mutate = (edit: (next: types.StepFx) => void): void => {
    const current = draft();
    if (!current) return;
    const next = cloneStepFx(current);
    edit(next);
    setDraft(next);
    setSaveError(undefined);
  };

  /** Stores one valid complete draft and waits for backend publication to clear dirty state. */
  const save = async (): Promise<void> => {
    const current = draft();
    if (!current || issues().length > 0 || saving() || deletedExternally())
      return;
    const payload = cloneStepFx(current);
    setSaveError(undefined);
    setPendingSave(payload);
    setSaveCommandSucceeded(false);
    setSaving(true);
    try {
      await storeStepFxAndWait(payload);
      setSaveCommandSucceeded(true);
    } catch (error) {
      setPendingSave(undefined);
      setSaveCommandSucceeded(false);
      setSaving(false);
      const message = error instanceof Error ? error.message : String(error);
      setSaveError(message);
      pushToast("error", `Could not save Step FX: ${message}`);
    }
  };

  /** Debounces valid dirty drafts into the existing store-and-ack save pipeline. */
  createEffect(() => {
    const current = draft();
    const shouldSave =
      Boolean(current) &&
      isDirty() &&
      issues().length === 0 &&
      !saving() &&
      !conflict() &&
      !deletedExternally() &&
      !saveError() &&
      connectionStatus() === EngineRuntimeStatus.Connected &&
      resyncComplete();
    if (autoSaveTimer) clearTimeout(autoSaveTimer);
    autoSaveTimer = undefined;
    if (!shouldSave || !current) return;
    const expected = cloneStepFx(current);
    autoSaveTimer = setTimeout(() => {
      autoSaveTimer = undefined;
      const latest = draft();
      if (latest && stepFxEquals(latest, expected)) void save();
    }, AUTO_SAVE_DELAY_MS);
  });

  /** Starts or stops this panel's session without affecting stored playbacks. */
  const togglePreview = (): void => {
    if (deletedExternally()) return;
    if (previewActive()) {
      if (previewStarted) stopStepFxPreview(previewSessionId);
      previewStarted = false;
      setPreviewActive(false);
      return;
    }
    setPreviewActive(true);
  };

  /** Discards local changes in favor of the latest published definition. */
  const reloadStored = (): void => {
    const stored = $stepFx()[initialUid];
    if (!stored) return;
    setDraft(cloneStepFx(stored));
    setBaseline(cloneStepFx(stored));
    setConflict(false);
    setSaveError(undefined);
    setIsNew(false);
  };

  /** Stops the owned preview and releases pending save and preview timers on disposal. */
  onCleanup(() => {
    if (previewTimer) clearTimeout(previewTimer);
    if (autoSaveTimer) clearTimeout(autoSaveTimer);
    if (previewStarted) stopStepFxPreview(previewSessionId);
  });
  /** Allows the current local draft to replace a concurrently changed stored definition. */
  const overwriteConflict = (): void => {
    setConflict(false);
  };

  /** Allows stopping an existing preview even when the edited draft is invalid. */
  const canTogglePreview = () =>
    !deletedExternally() && (issues().length === 0 || previewStarted);

  return {
    draft,
    saving,
    conflict,
    deletedExternally,
    previewActive,
    previewSessionId,
    previewStatus,
    isDirty,
    issues,
    mutate,
    canTogglePreview,
    togglePreview,
    reloadStored,
    overwriteConflict,
  };
}
