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
import { registerDialog } from "./dialog-stack";
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
  /** Default action for Enter pressed on content that has no Enter behavior of its own. */
  onEnter?: () => void;
  usePortal?: boolean;
}

/**
 * Shared modal wrapper. While visible it joins the dialog stack, so only the
 * frontmost dialog receives Escape and Enter, and keys never leak to dialogs
 * or panels behind it.
 */
export default function Modal(props: ModalProps) {
  const regionVisible = useContext(ModalVisibilityContext);
  /** Suspends the dialog without clearing its owner's open state. */
  const visible = () => props.isOpen && regionVisible();
  createModalScrollLock(visible);
  let rootRef: HTMLDivElement | undefined;

  /** Holds a place on the dialog stack for as long as the dialog is visible. */
  createEffect(() => {
    if (!visible()) return;
    onCleanup(
      registerDialog({
        element: () => rootRef,
        escapeAction: () =>
          props.closeOnEscape === false ? undefined : props.onEscape,
        enterAction: () => props.onEnter,
      }),
    );
  });

  const content = (
    <Show when={visible()}>
      <div ref={rootRef} class="contents" data-modal-root="">
        {props.children}
      </div>
    </Show>
  );
  return props.usePortal === false ? content : <Portal>{content}</Portal>;
}
