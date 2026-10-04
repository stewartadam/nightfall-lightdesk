// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createEffect, createSignal, onCleanup } from "solid-js";
import {
  Dialog,
  DialogBody,
  DialogCancelButton,
  DialogFooter,
} from "../ui/dialog";
import { Button } from "../ui/visual-language/button";

interface DeleteConfirmModalProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  onCancel: () => void;
  onConfirm: () => void;
}

/** Tags the backdrop for tests and keeps legacy overlay keyboard handling off it. */
const backdropAttributes = {
  "data-modal-kind": "delete-confirm",
  tabIndex: -1,
  "data-hs-overlay-keyboard": "false",
};

/** Asks the user to confirm a destructive action, focusing the confirm button once the dialog fades in. */
export default function DeleteConfirmModal(props: DeleteConfirmModalProps) {
  const [isEntered, setIsEntered] = createSignal(false);
  let enterAnimationFrame: number | null = null;
  let confirmButtonRef: HTMLButtonElement | undefined;

  createEffect(() => {
    if (!props.isOpen) {
      setIsEntered(false);
      if (enterAnimationFrame !== null) {
        cancelAnimationFrame(enterAnimationFrame);
        enterAnimationFrame = null;
      }
      return;
    }

    setIsEntered(false);
    enterAnimationFrame = requestAnimationFrame(() => {
      setIsEntered(true);
      confirmButtonRef?.focus();
      enterAnimationFrame = null;
    });
  });

  onCleanup(() => {
    if (enterAnimationFrame !== null) {
      cancelAnimationFrame(enterAnimationFrame);
    }
  });

  return (
    <Dialog
      kind="task"
      isOpen={props.isOpen}
      title={props.title}
      onDismiss={props.onCancel}
      class={`max-w-lg transition-opacity duration-150 ${isEntered() ? "opacity-100" : "opacity-0"}`}
      backdropProps={backdropAttributes}
      blockBackgroundKeys
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          props.onConfirm();
        }}
      >
        <DialogBody class="overflow-y-auto">
          <p class="text-neutral-200">{props.message}</p>
        </DialogBody>
        <DialogFooter>
          <DialogCancelButton />
          <Button variant="danger" ref={confirmButtonRef} type="submit">
            {props.confirmLabel ?? "Delete"}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
