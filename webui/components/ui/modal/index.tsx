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
  createRenderEffect,
  type JSX,
  onCleanup,
  Show,
  useContext,
} from "solid-js";
import { Portal } from "solid-js/web";
import { registerDialog } from "./dialog-stack";
import { focusDialogOnOpen } from "./focus-scope";
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
  /** Holds back every key aimed outside the dialog while it is visible, for blocking confirmations. */
  blockBackgroundKeys?: boolean;
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
  let opener: HTMLElement | undefined;

  /**
   * Remembers what had focus before the dialog appeared. Runs ahead of the
   * dialog content rendering, so a field that focuses itself on mount is not
   * mistaken for the opener.
   */
  createRenderEffect(() => {
    if (!visible()) return;
    const active = document.activeElement;
    opener =
      active instanceof HTMLElement && active !== document.body
        ? active
        : undefined;
  });

  /**
   * Holds a place on the dialog stack for as long as the dialog is visible,
   * moves focus into the dialog once its content has mounted, and hands focus
   * back to the opener when the dialog closes, unless something else took it.
   */
  createEffect(() => {
    if (!visible()) return;
    const root = rootRef;
    const returnTo = opener;
    queueMicrotask(() => {
      if (root?.isConnected && visible()) focusDialogOnOpen(root);
    });
    onCleanup(() => {
      queueMicrotask(() => {
        const active = document.activeElement;
        const focusLeftWithDialog =
          active === null ||
          active === document.body ||
          root?.contains(active) === true;
        if (focusLeftWithDialog && returnTo?.isConnected) {
          returnTo.focus({ preventScroll: true });
        }
      });
    });
    onCleanup(
      registerDialog({
        element: () => rootRef,
        escapeAction: () =>
          props.closeOnEscape === false ? undefined : props.onEscape,
        enterAction: () => props.onEnter,
        blocksBackgroundKeys: () => props.blockBackgroundKeys === true,
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
