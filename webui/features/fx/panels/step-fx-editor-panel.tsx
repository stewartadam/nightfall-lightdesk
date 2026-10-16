// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { DockviewPanelApi } from "dockview-core";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import DeleteConfirmModal from "../../../components/widgets/delete-confirm-dialog";
import { registerComponentFocus } from "../../../lib/keyboardShortcuts";
import { getLogger } from "../../../lib/logger";
import type { BasePanelComponentProps } from "../../../lib/panel-registry";
import { usePanelTabStatus } from "../../../lib/panel-tab-status";
import type * as types from "../../../types";
import { usePropertiesInspector } from "../../property-inspector";
import { StepFxAttributeSidebar } from "../components/step-fx-editor/step-fx-attribute-sidebar";
import { StepFxEditorNotices } from "../components/step-fx-editor/step-fx-editor-notices";
import { StepFxEditorToolbar } from "../components/step-fx-editor/step-fx-editor-toolbar";
import { StepFxProperties } from "../components/step-fx-editor/step-fx-properties";
import { StepFxTrackStage } from "../components/step-fx-editor/step-fx-track-stage";
import { createStepFxEditorController } from "../controllers/step-fx-editor-controller";
import { createStepFxEditorViewController } from "../controllers/step-fx-editor-view-controller";
import { loadStepFxEditorViewportState } from "../model/step-fx-editor-viewport";

const log = getLogger(import.meta.url);

export interface StepFxEditorPanelProps extends BasePanelComponentProps {
  initialPanelId: string;
  initialStepFxUid?: string;
  initialDraft?: types.StepFx;
  panelApi?: DockviewPanelApi;
}

/** Composes the Step FX editor and integrates its session with docking, focus, and Properties. */
export default function StepFxEditorPanel(props: StepFxEditorPanelProps) {
  log.trace("mounting");
  const initialDraft = props.initialDraft;
  const initialUid = (
    props.initialStepFxUid ??
    initialDraft?.identifiers.uid ??
    ""
  )
    .replace(/-/g, "")
    .toLowerCase();
  const initialViewport = loadStepFxEditorViewportState(initialUid);
  const session = createStepFxEditorController({
    initialUid,
    initialDraft,
    initialPreviewActive: initialViewport.previewActive,
    onCleanDeletion: props.panelApi ? () => props.panelApi?.close() : undefined,
  });
  const { draft, saving, isDirty, issues } = session;
  const panelId = props.initialPanelId ?? props.id;
  const [isCloseConfirmOpen, setIsCloseConfirmOpen] = createSignal(false);
  let bypassCloseGuard = false;
  let editorRootElement: HTMLDivElement | undefined;

  usePanelTabStatus(panelId, () => (saving() ? "saving" : undefined));

  const editor = createStepFxEditorViewController({
    panelId,
    initialUid,
    initialViewport,
    session,
  });

  /** Returns the operator-facing label used by the panel and Properties heading. */
  const propertiesLabel = createMemo(
    () => draft()?.identifiers.label ?? "Step FX",
  );

  /** Returns the editor tab title for the current draft identity. */
  const panelTitle = createMemo(() => {
    const current = draft();
    return current
      ? `Step FX ${current.identifiers.id}: ${current.identifiers.label}`
      : "Step FX Editor";
  });

  onMount(() => {
    if (editorRootElement) {
      const unregisterFocus = registerComponentFocus(
        panelId,
        editorRootElement,
      );
      onCleanup(unregisterFocus);
    }
    const panelApi = props.panelApi;
    if (!panelApi) return;
    const originalClose = panelApi.close.bind(panelApi);
    panelApi.close = () => {
      if (bypassCloseGuard || !isDirty()) originalClose();
      else setIsCloseConfirmOpen(true);
    };
    onCleanup(() => {
      panelApi.close = originalClose;
    });
  });

  onCleanup(() => {
    log.trace("unmounting");
  });

  /** Keeps the retained panel title aligned with its Step FX draft label. */
  createEffect(() => {
    props.panelApi?.setTitle(panelTitle());
  });

  usePropertiesInspector(
    panelId,
    propertiesLabel,
    () => (
      <StepFxProperties
        stepFx={draft()}
        onLabelCommit={editor.edit.renameStepFx}
        onSelectionChange={editor.edit.setSpatialSelection}
      />
    ),
    { priority: 10 },
  );

  /** Closes after the operator explicitly confirms discarding the local draft. */
  const confirmClose = (): void => {
    setIsCloseConfirmOpen(false);
    if (!props.panelApi) return;
    bypassCloseGuard = true;
    try {
      props.panelApi.close();
    } finally {
      bypassCloseGuard = false;
    }
  };

  return (
    <div
      ref={editorRootElement}
      class="flex h-full min-h-0 flex-col bg-neutral-950 text-neutral-100"
      data-step-fx-editor
      onKeyDown={editor.edit.handleEditorClipboardKeyDown}
    >
      <Show
        when={draft()}
        fallback={
          <div class="flex h-full items-center justify-center text-neutral-500">
            Step FX not found
          </div>
        }
      >
        {(current) => (
          <>
            <StepFxEditorToolbar editor={editor} stepFx={current()} />
            <StepFxEditorNotices
              session={session}
              onCloseEditor={() => props.panelApi?.close()}
            />
            <main class="grid min-h-0 flex-1 grid-cols-[11rem_minmax(0,1fr)] overflow-hidden">
              <StepFxAttributeSidebar editor={editor} stepFx={current()} />

              <StepFxTrackStage editor={editor} stepFx={current()} />
            </main>

            <Show when={issues().length > 0}>
              <div
                class="max-h-24 shrink-0 overflow-y-auto border-t border-red-800 bg-red-950/40 px-3 py-2 text-xs text-red-100"
                role="alert"
              >
                <For each={issues()}>
                  {(issue) => <div>{issue.message}</div>}
                </For>
              </div>
            </Show>
          </>
        )}
      </Show>

      <DeleteConfirmModal
        isOpen={isCloseConfirmOpen()}
        title="Discard unsaved Step FX changes?"
        message="You have unsaved changes. Close without saving?"
        confirmLabel="Discard"
        onCancel={() => setIsCloseConfirmOpen(false)}
        onConfirm={confirmClose}
      />
    </div>
  );
}
