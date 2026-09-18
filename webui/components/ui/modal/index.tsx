// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  type Accessor,
  createContext,
  createEffect,
  type JSX,
  onCleanup,
  Show,
  useContext,
} from "solid-js";
import { Portal } from "solid-js/web";
import { createModalScrollLock } from "./scroll-lock";

/** Allows an owning UI region to suspend its dialogs without clearing their open state. */
export const ModalVisibilityContext = createContext<Accessor<boolean>>(
  () => true,
);

interface ModalProps {
  isOpen: boolean;
  children: JSX.Element;
  onEscape?: () => void;
  closeOnEscape?: boolean;
  usePortal?: boolean;
}

/**
 * Shared modal wrapper that centralizes Escape handling so modal UIs can
 * keep Escape scoped to the modal that currently owns it.
 */
export default function Modal(props: ModalProps) {
  const regionVisible = useContext(ModalVisibilityContext);
  /** Suspends the dialog without clearing its owner's open state. */
  const visible = () => props.isOpen && regionVisible();
  createModalScrollLock(visible);

  /** Only a visible dialog may capture Escape. */
  createEffect(() => {
    if (!visible() || !props.onEscape || props.closeOnEscape === false) {
      return;
    }

    /** Prevents the active dialog escape key from reaching background handlers. */
    const handleEscapeKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      props.onEscape?.();
    };

    document.addEventListener("keydown", handleEscapeKeyDown, true);

    onCleanup(() => {
      document.removeEventListener("keydown", handleEscapeKeyDown, true);
    });
  });

  const content = <Show when={visible()}>{props.children}</Show>;
  return props.usePortal === false ? content : <Portal>{content}</Portal>;
}
