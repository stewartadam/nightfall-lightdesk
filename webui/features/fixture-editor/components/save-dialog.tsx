// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { WarningIcon } from "@squidlab/phosphor-solid/warning";
import { createEffect, createSignal, on, Show } from "solid-js";
import {
  Dialog,
  DialogBody,
  DialogCancelButton,
  DialogFooter,
} from "../../../components/ui/dialog";
import { Input } from "../../../components/ui/form-controls";
import { Button } from "../../../components/ui/visual-language/button";
import type * as types from "../../../types";
import { hasErrors } from "../model/draft-editing";
import {
  FILE_EXISTS_CODE,
  FixtureEditorError,
  type SaveOptions,
} from "../services/fixture-editor-client";

interface SaveDialogProps {
  isOpen: boolean;
  draft: types.FixtureDraftView;
  /** Saves the draft; rejects with the backend's error when the save fails. */
  onSave: (options: SaveOptions) => Promise<void>;
  onClose: () => void;
}

/**
 * Saves a draft into the fixture library under a file name, with a note for
 * the file's revision history. A save that would replace a library file this
 * draft has not written yet asks before replacing it.
 */
export default function SaveDialog(props: SaveDialogProps) {
  const [fileName, setFileName] = createSignal("");
  const [note, setNote] = createSignal("");
  const [conflict, setConflict] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [saving, setSaving] = createSignal(false);

  /** Starts each opening from the draft's own file name, with no note and no pending question. */
  createEffect(
    on(
      () => props.isOpen,
      (isOpen) => {
        if (!isOpen) return;
        setFileName(props.draft.file_name ?? "");
        setNote("");
        setConflict(null);
        setError(null);
      },
    ),
  );

  /** Saves, turning a refusal to replace a file into a question for the user. */
  const save = async () => {
    if (saving() || hasErrors(props.draft)) return;
    const overwrite = conflict() !== null;
    setSaving(true);
    setError(null);
    try {
      await props.onSave({
        fileName: fileName().trim(),
        overwrite,
        note: note().trim(),
      });
      props.onClose();
    } catch (cause) {
      if (
        cause instanceof FixtureEditorError &&
        cause.code === FILE_EXISTS_CODE
      ) {
        setConflict(cause.message);
      } else {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      kind="task"
      isOpen={props.isOpen}
      title="Save to fixture library"
      onDismiss={props.onClose}
      busy={saving()}
      class="max-w-lg"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <DialogBody class="flex flex-col gap-4">
          <label class="flex flex-col gap-1 text-sm">
            <span class="text-neutral-300">File name</span>
            <Input
              value={fileName()}
              placeholder="Named after the manufacturer and fixture"
              autocomplete="off"
              spellcheck={false}
              onInput={(event) => {
                setFileName(event.currentTarget.value);
                setConflict(null);
              }}
            />
          </label>
          <label class="flex flex-col gap-1 text-sm">
            <span class="text-neutral-300">Revision note</span>
            <Input
              value={note()}
              placeholder="What changed, for the file's history"
              onInput={(event) => setNote(event.currentTarget.value)}
            />
          </label>
          <Show when={hasErrors(props.draft)}>
            <p class="text-sm text-red-300">
              Fix the errors listed on the page before saving.
            </p>
          </Show>
          <Show when={conflict()}>
            {(message) => (
              <p
                class="flex items-start gap-2 text-sm text-amber-300"
                data-testid="fixture-save-conflict"
              >
                <WarningIcon class="mt-0.5 size-4 shrink-0" aria-hidden />
                <span>
                  {message().replace(/\.?$/, ".")} Saving again replaces it.
                </span>
              </p>
            )}
          </Show>
          <Show when={error()}>
            {(message) => <p class="text-sm text-red-300">{message()}</p>}
          </Show>
        </DialogBody>
        <DialogFooter>
          <DialogCancelButton />
          <Button
            type="submit"
            variant={conflict() ? "danger" : "primary"}
            disabled={saving() || hasErrors(props.draft)}
          >
            {conflict() ? "Replace file" : "Save"}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
