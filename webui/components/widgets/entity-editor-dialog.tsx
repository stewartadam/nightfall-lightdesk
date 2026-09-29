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
  createUniqueId,
  onCleanup,
  Show,
} from "solid-js";
import {
  DialogBackdrop,
  DialogBody,
  DialogCloseButton,
  DialogFooter,
  DialogHeader,
  DialogSurface,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/form-controls";
import Modal from "../ui/modal";
import Tooltip from "../ui/tooltip";
import { Button } from "../ui/visual-language/button";

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
  const titleId = createUniqueId();
  const [idValue, setIdValue] = createSignal(1);
  const [labelValue, setLabelValue] = createSignal("");
  let labelInputRef: HTMLInputElement | undefined;
  const [armedKey, setArmedKey] = createSignal<string>();
  /** Resolves the current owner of the sanitized numeric ID. */
  const conflict = createMemo(() =>
    props.overwriteConflict?.(Math.max(1, Math.round(idValue()))),
  );
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
    setIdValue(props.initialId);
    setLabelValue(props.initialLabel);
    requestAnimationFrame(() => labelInputRef?.focus());
  });

  /** Submits sanitized id and label values, falling back to an item label when blank. */
  const handleSubmit = (event: Event) => {
    event.preventDefault();
    const owner = conflict();
    if (owner && armedKey() !== owner.key) return;
    const trimmedLabel = labelValue().trim();
    props.onSubmit({
      id: Math.max(1, Math.round(idValue())),
      label: trimmedLabel.length > 0 ? trimmedLabel : `Item ${idValue()}`,
      overwriteKey: owner?.key,
    });
  };

  return (
    <Modal isOpen={props.isOpen} onEscape={props.onCancel}>
      <DialogBackdrop role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div class="w-full max-w-lg">
          <DialogSurface>
            <DialogHeader>
              <DialogTitle id={titleId}>{props.title}</DialogTitle>
              <DialogCloseButton
                type="button"
                aria-label="Close"
                onClick={props.onCancel}
              />
            </DialogHeader>

            <form onSubmit={handleSubmit}>
              <DialogBody class="space-y-4">
                <label class="flex flex-col gap-1">
                  <span class="text-sm text-neutral-300">
                    {props.idLabel ?? "ID"}
                  </span>
                  <Input
                    type="number"
                    min={1}
                    step={1}
                    value={idValue()}
                    onInput={(event) =>
                      setIdValue(
                        Number.parseInt(event.currentTarget.value, 10) || 1,
                      )
                    }
                  />
                </label>
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
                    type="text"
                    value={labelValue()}
                    onInput={(event) =>
                      setLabelValue(event.currentTarget.value)
                    }
                  />
                </label>
              </DialogBody>

              <DialogFooter>
                <Button type="button" onClick={props.onCancel}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  disabled={!!conflict() && armedKey() !== conflict()?.key}
                >
                  {conflict() ? "Overwrite" : props.submitLabel}
                </Button>
              </DialogFooter>
            </form>
          </DialogSurface>
        </div>
      </DialogBackdrop>
    </Modal>
  );
}
