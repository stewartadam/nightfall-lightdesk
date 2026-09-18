// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createEffect, createSignal, createUniqueId } from "solid-js";
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
  onSubmit: (payload: { id: number; label: string }) => void;
}

/** Renders a two-field editor dialog for creating or renaming numbered entities. */
export default function EntityEditorModal(props: EntityEditorModalProps) {
  const titleId = createUniqueId();
  const [idValue, setIdValue] = createSignal(1);
  const [labelValue, setLabelValue] = createSignal("");
  let labelInputRef: HTMLInputElement | undefined;

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
    const trimmedLabel = labelValue().trim();
    props.onSubmit({
      id: Math.max(1, Math.round(idValue())),
      label: trimmedLabel.length > 0 ? trimmedLabel : `Item ${idValue()}`,
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
                <Button type="submit" variant="primary">
                  {props.submitLabel}
                </Button>
              </DialogFooter>
            </form>
          </DialogSurface>
        </div>
      </DialogBackdrop>
    </Modal>
  );
}
