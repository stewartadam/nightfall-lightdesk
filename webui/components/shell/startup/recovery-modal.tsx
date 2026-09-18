// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { FilePlusIcon } from "@squidlab/phosphor-solid/file-plus";
import { FolderOpenIcon } from "@squidlab/phosphor-solid/folder-open";
import { createEffect, onCleanup, Show } from "solid-js";
import type { StartupDraftRecovery } from "../../../lib/showfile-startup";
import {
  DialogBackdrop,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogSurface,
  DialogTitle,
} from "../../ui/dialog";
import Modal from "../../ui/modal";
import { Button } from "../../ui/visual-language/button";

const RECOVERY_DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

interface ShowfileDraftRecoveryModalProps {
  draft: StartupDraftRecovery | null;
  error: string | null;
  onLoadDraft: () => void;
  onKeepSaved: () => void;
  onNewShowfile: () => void;
  onOpenOther: () => void;
  disabled: boolean;
}

/** Renders the startup prompt for a recoverable showfile draft. */
export function ShowfileDraftRecoveryModal(
  props: ShowfileDraftRecoveryModalProps,
) {
  let focusFrameId: number | undefined;
  let loadDraftButtonRef: HTMLButtonElement | undefined;
  let keepSavedButtonRef: HTMLButtonElement | undefined;

  /** Submits the default action without allowing page shortcuts to run. */
  const submitDefaultAction = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    if (props.disabled || !props.draft) return;
    if (props.draft.hasDraft) props.onLoadDraft();
    else if (props.draft.hasSavedSnapshot) props.onKeepSaved();
  };

  /** Keeps Enter scoped to the recovery prompt's default action while open. */
  createEffect(() => {
    if (!props.draft) return;

    /** Routes Enter to draft loading while the modal owns keyboard focus. */
    const handleDefaultActionKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || event.repeat || event.isComposing) return;
      submitDefaultAction(event);
    };
    document.addEventListener("keydown", handleDefaultActionKeyDown, true);
    onCleanup(() => {
      document.removeEventListener("keydown", handleDefaultActionKeyDown, true);
    });
  });

  /** Focuses the default action when the recovery prompt becomes visible. */
  createEffect(() => {
    if (!props.draft || props.disabled) return;
    focusFrameId = requestAnimationFrame(() => {
      (props.draft?.hasDraft
        ? loadDraftButtonRef
        : keepSavedButtonRef
      )?.focus();
      focusFrameId = undefined;
    });
    onCleanup(() => {
      if (focusFrameId !== undefined) {
        cancelAnimationFrame(focusFrameId);
        focusFrameId = undefined;
      }
    });
  });

  return (
    <Modal isOpen={props.draft !== null}>
      <Show when={props.draft}>
        {(draft) => (
          <DialogBackdrop
            class="nightfall-top-layer"
            role="dialog"
            aria-modal="true"
            aria-label={`Resume your work on ${draft().showfileName}?`}
          >
            <DialogSurface style={{ "max-width": "512px" }}>
              <DialogHeader>
                <DialogTitle>Resume your work?</DialogTitle>
              </DialogHeader>
              <DialogBody class="space-y-3 text-sm text-neutral-300">
                <p>
                  Continue working on{" "}
                  <span class="font-semibold text-neutral-100 [overflow-wrap:anywhere]">
                    {draft().showfileName}
                  </span>{" "}
                  using the saved version or draft. You can also create a new
                  showfile or open another.
                </p>
                <Show when={props.error}>
                  {(error) => (
                    <p
                      class="rounded-md border border-red-800/70 bg-red-950/50 px-3 py-2 text-xs text-red-200"
                      role="alert"
                    >
                      {error()}
                    </p>
                  )}
                </Show>
                <dl class="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2 text-xs text-neutral-500">
                  <Show when={draft().savedModifiedMs}>
                    {(savedModifiedMs) => (
                      <>
                        <dt>Saved version</dt>
                        <dd class="m-0 tabular-nums">
                          {RECOVERY_DATE_FORMAT.format(
                            new Date(savedModifiedMs()),
                          )}
                        </dd>
                      </>
                    )}
                  </Show>
                  <Show when={draft().modifiedMs}>
                    {(modifiedMs) => (
                      <>
                        <dt>Draft</dt>
                        <dd class="m-0 tabular-nums">
                          {RECOVERY_DATE_FORMAT.format(new Date(modifiedMs()))}
                        </dd>
                      </>
                    )}
                  </Show>
                </dl>
              </DialogBody>
              <form onSubmit={submitDefaultAction}>
                <DialogFooter style={{ "justify-content": "space-between" }}>
                  <div class="flex items-center gap-2">
                    <Button
                      size="compact"
                      type="button"
                      class="items-center gap-1.5"
                      aria-label="New showfile"
                      disabled={props.disabled}
                      onClick={props.onNewShowfile}
                    >
                      <FilePlusIcon class="size-4" aria-hidden />
                      <span>New</span>
                    </Button>
                    <Button
                      size="compact"
                      type="button"
                      class="items-center gap-1.5"
                      aria-label="Open Other..."
                      disabled={props.disabled}
                      onClick={props.onOpenOther}
                    >
                      <FolderOpenIcon class="size-4" aria-hidden />
                      <span>Open</span>
                    </Button>
                  </div>
                  <div class="flex items-center justify-end gap-x-2">
                    <Button
                      size="compact"
                      type="button"
                      variant={draft().hasDraft ? "secondary" : "primary"}
                      ref={keepSavedButtonRef}
                      disabled={props.disabled || !draft().hasSavedSnapshot}
                      onClick={props.onKeepSaved}
                    >
                      Keep Saved
                    </Button>
                    <Button
                      size="compact"
                      variant={draft().hasDraft ? "primary" : "secondary"}
                      ref={loadDraftButtonRef}
                      type="submit"
                      disabled={props.disabled || !draft().hasDraft}
                    >
                      Load Draft
                    </Button>
                  </div>
                </DialogFooter>
              </form>
            </DialogSurface>
          </DialogBackdrop>
        )}
      </Show>
    </Modal>
  );
}
