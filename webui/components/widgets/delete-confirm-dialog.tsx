// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  createEffect,
  createSignal,
  createUniqueId,
  onCleanup,
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
import Modal from "../ui/modal";
import { Button } from "../ui/visual-language/button";

interface DeleteConfirmModalProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  onCancel: () => void;
  onConfirm: () => void;
}

export default function DeleteConfirmModal(props: DeleteConfirmModalProps) {
  const titleId = createUniqueId();
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
    <Modal isOpen={props.isOpen} onEscape={props.onCancel} blockBackgroundKeys>
      <DialogBackdrop
        role="dialog"
        data-modal-kind="delete-confirm"
        tabIndex={-1}
        aria-modal="true"
        aria-labelledby={titleId}
        data-hs-overlay-keyboard="false"
      >
        <div
          class="w-full max-w-lg transition-opacity duration-150"
          classList={{
            "opacity-0": !isEntered(),
            "opacity-100": isEntered(),
          }}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <DialogSurface>
            <DialogHeader>
              <DialogTitle id={titleId}>{props.title}</DialogTitle>
              <DialogCloseButton
                type="button"
                aria-label="Close"
                onClick={props.onCancel}
              />
            </DialogHeader>

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
                <Button type="button" onClick={props.onCancel}>
                  Cancel
                </Button>
                <Button variant="danger" ref={confirmButtonRef} type="submit">
                  {props.confirmLabel ?? "Delete"}
                </Button>
              </DialogFooter>
            </form>
          </DialogSurface>
        </div>
      </DialogBackdrop>
    </Modal>
  );
}
