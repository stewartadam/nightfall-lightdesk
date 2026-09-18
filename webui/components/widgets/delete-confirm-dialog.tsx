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
  Show,
} from "solid-js";
import { Portal } from "solid-js/web";
import {
  DialogBackdrop,
  DialogBody,
  DialogCloseButton,
  DialogFooter,
  DialogHeader,
  DialogSurface,
  DialogTitle,
} from "../ui/dialog";
import { createModalScrollLock } from "../ui/modal/scroll-lock";
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

  createModalScrollLock(() => props.isOpen);

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

  createEffect(() => {
    if (!props.isOpen) {
      return;
    }

    const blockKeyboard = (event: KeyboardEvent) => {
      if (event.type === "keydown" && event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        props.onCancel();
        return;
      }

      event.stopPropagation();
      event.stopImmediatePropagation();
    };

    document.addEventListener("keydown", blockKeyboard, true);
    document.addEventListener("keyup", blockKeyboard, true);
    document.addEventListener("keypress", blockKeyboard, true);

    onCleanup(() => {
      document.removeEventListener("keydown", blockKeyboard, true);
      document.removeEventListener("keyup", blockKeyboard, true);
      document.removeEventListener("keypress", blockKeyboard, true);
    });
  });

  onCleanup(() => {
    if (enterAnimationFrame !== null) {
      cancelAnimationFrame(enterAnimationFrame);
    }
  });

  return (
    <Show when={props.isOpen}>
      <Portal>
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
      </Portal>
    </Show>
  );
}
