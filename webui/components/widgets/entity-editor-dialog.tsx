// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { WarningIcon } from "@squidlab/phosphor-solid/warning";
import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  Show,
} from "solid-js";
import { isWholeNumberInRange } from "../../lib/number-draft";
import {
  Dialog,
  DialogBody,
  DialogCancelButton,
  DialogFooter,
} from "../ui/dialog";
import { Input } from "../ui/form-controls";
import Tooltip from "../ui/tooltip";
import { Button } from "../ui/visual-language/button";
import { NumberField } from "./number-field";

interface EntityEditorModalProps {
  isOpen: boolean;
  title: string;
  submitLabel: string;
  initialId: number;
  initialLabel: string;
  idLabel?: string;
  labelLabel?: string;
  onCancel: () => void;
  overwriteConflict?: (
    id: number,
  ) => { key: string; message: string } | undefined;
  onSubmit: (payload: {
    id: number;
    label: string;
    overwriteKey?: string;
  }) => void;
}

/** Renders a two-field editor dialog for creating or renaming numbered entities. */
export default function EntityEditorModal(props: EntityEditorModalProps) {
  const [idDraft, setIdDraft] = createSignal<number | null>(1);
  const [labelValue, setLabelValue] = createSignal("");
  let labelInputRef: HTMLInputElement | undefined;
  const [armedKey, setArmedKey] = createSignal<string>();
  /**
   * The typed ID when it is a whole number from 1, else undefined. The field keeps what was
   * typed, so clearing it to type a new ID doesn't snap it back to a default.
   */
  const idValue = createMemo(() => {
    const id = idDraft();
    return isWholeNumberInRange(id, 1) ? id : undefined;
  });
  /** Resolves the current owner of the typed ID, once it is a valid ID. */
  const conflict = createMemo(() => {
    const id = idValue();
    return id === undefined ? undefined : props.overwriteConflict?.(id);
  });
  /** Keeps unrelated clip updates from resetting authorization for the same owner. */
  const conflictKey = createMemo(() => conflict()?.key);
  /** Requires a fresh Alt press whenever the dialog or conflicting owner changes. */
  createEffect(() => {
    const key = conflictKey();
    setArmedKey(undefined);
    if (!props.isOpen || !key) return;
    /** Arms only this owner, without accepting repeated keydown events. */
    const press = (event: KeyboardEvent) => {
      if (event.key === "Alt" && !event.repeat) setArmedKey(key);
    };
    /** Disarms on modifier release or loss of window focus. */
    const release = () => setArmedKey(undefined);
    /** Clears authorization when Alt is released. */
    const keyup = (event: KeyboardEvent) => {
      if (event.key === "Alt" || !event.altKey) release();
    };
    window.addEventListener("keydown", press, true);
    window.addEventListener("keyup", keyup, true);
    window.addEventListener("blur", release);
    onCleanup(() => {
      window.removeEventListener("keydown", press, true);
      window.removeEventListener("keyup", keyup, true);
      window.removeEventListener("blur", release);
    });
  });

  /** Refreshes dialog field values and focuses the operator-facing label field on open. */
  createEffect(() => {
    if (!props.isOpen) {
      return;
    }
    setIdDraft(props.initialId);
    setLabelValue(props.initialLabel);
    requestAnimationFrame(() => labelInputRef?.focus());
  });

  /**
   * Submits the typed ID and label, falling back to an item label when the label is blank. Does
   * nothing while the ID is invalid or an unarmed overwrite is pending.
   */
  const handleSubmit = (event: Event) => {
    event.preventDefault();
    const id = idValue();
    if (id === undefined) return;
    const owner = conflict();
    if (owner && armedKey() !== owner.key) return;
    const trimmedLabel = labelValue().trim();
    props.onSubmit({
      id,
      label: trimmedLabel.length > 0 ? trimmedLabel : `Item ${id}`,
      overwriteKey: owner?.key,
    });
  };

  return (
    <Dialog
      kind="task"
      isOpen={props.isOpen}
      title={props.title}
      onDismiss={props.onCancel}
    >
      <form onSubmit={handleSubmit}>
        <DialogBody class="space-y-4">
          <label class="flex flex-col gap-1">
            <span class="text-sm text-neutral-300">
              {props.idLabel ?? "ID"}
            </span>
            <NumberField
              min={1}
              step={1}
              data-entity-field="id"
              data-value={idValue() ?? ""}
              value={idDraft()}
              onValueChange={setIdDraft}
              aria-invalid={idValue() === undefined}
            />
          </label>
          <Show when={idValue() === undefined}>
            <p class="text-sm text-red-400">IDs are whole numbers from 1.</p>
          </Show>
          <Show when={conflict()}>
            {(owner) => (
              <Tooltip
                content={() => (
                  <span class="block max-w-xs whitespace-normal">
                    {owner().message}
                  </span>
                )}
              >
                <button
                  type="button"
                  class="inline-flex items-center gap-2 text-amber-400"
                  aria-label="ID already exists"
                >
                  <WarningIcon class="size-5" aria-hidden />
                  <span>Hold Alt to overwrite</span>
                </button>
              </Tooltip>
            )}
          </Show>

          <label class="flex flex-col gap-1">
            <span class="text-sm text-neutral-300">
              {props.labelLabel ?? "Label"}
            </span>
            <Input
              ref={labelInputRef}
              data-entity-field="label"
              type="text"
              value={labelValue()}
              onInput={(event) => setLabelValue(event.currentTarget.value)}
            />
          </label>
        </DialogBody>

        <DialogFooter>
          <DialogCancelButton />
          <Button
            type="submit"
            variant="primary"
            disabled={
              idValue() === undefined ||
              (!!conflict() && armedKey() !== conflict()?.key)
            }
          >
            {conflict() ? "Overwrite" : props.submitLabel}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
