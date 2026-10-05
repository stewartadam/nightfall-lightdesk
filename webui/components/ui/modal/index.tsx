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
  createSignal,
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

/**
 * Clears the browser's default `<dialog>` box (centered card, border,
 * padding, canvas colors) so the dialog element can serve as a full-viewport
 * layer.
 */
const DIALOG_RESET_CLASS =
  "fixed inset-0 m-0 h-full max-h-none w-full max-w-none border-0 text-inherit outline-none";

/** Transparent full-viewport layer for modal content that draws its own backdrop. */
const DIALOG_SHELL_CLASS =
  "overflow-visible bg-transparent p-0 backdrop:bg-transparent";

interface ModalProps {
  isOpen: boolean;
  children: JSX.Element;
  onEscape?: () => void;
  closeOnEscape?: boolean;
  /** Default action for Enter pressed on content that has no Enter behavior of its own. */
  onEnter?: () => void;
  /** Holds back every key aimed outside the dialog while it is visible, for blocking confirmations. */
  blockBackgroundKeys?: boolean;
  /**
   * Attributes for the `<dialog>` element. Its `class` replaces the default
   * transparent full-viewport layer.
   */
  dialogProps?: JSX.DialogHtmlAttributes<HTMLDialogElement> & {
    [attribute: `data-${string}`]: string | undefined;
  };
  usePortal?: boolean;
}

/**
 * Shared modal wrapper built on the native modal `<dialog>`. While visible it
 * is shown with `showModal()`, so the browser draws it above everything else
 * and makes the rest of the page inert: Tab, clicks and assistive technology
 * only reach the frontmost dialog. It also joins the dialog stack, which
 * routes Escape and Enter to the frontmost dialog only.
 */
export default function Modal(props: ModalProps) {
  const regionVisible = useContext(ModalVisibilityContext);
  /** Suspends the dialog without clearing its owner's open state. */
  const visible = () => props.isOpen && regionVisible();
  createModalScrollLock(visible);
  const [dialogElement, setDialogElement] = createSignal<HTMLDialogElement>();
  let opener: HTMLElement | undefined;
  let closingOnPurpose = false;
  let lastFocusedInside: HTMLElement | undefined;

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
   * Shows the dialog modally and holds a place on the dialog stack for as long
   * as it is visible. Focus starts inside the dialog and returns to the opener
   * when the dialog closes, unless something else took it meanwhile.
   */
  createEffect(() => {
    if (!visible()) return;
    const dialog = dialogElement();
    if (!dialog) return;
    const returnTo = opener;
    let disposed = false;
    closingOnPurpose = false;
    let microtaskRetries = 3;
    /**
     * Shows the dialog modally once it is in the document. A portal attaches
     * its content right after this effect, so the first retries run as
     * microtasks, ahead of any frame callback in which dialog content focuses
     * a control (a closed dialog cannot take focus); later retries wait a frame.
     */
    const show = () => {
      if (disposed || dialog.open) return;
      if (!dialog.isConnected) {
        if (microtaskRetries-- > 0) queueMicrotask(show);
        else requestAnimationFrame(show);
        return;
      }
      const focusedBeforeShow = document.activeElement;
      dialog.showModal();
      focusDialogOnOpen(
        dialog,
        focusedBeforeShow instanceof HTMLElement &&
          dialog.contains(focusedBeforeShow)
          ? focusedBeforeShow
          : undefined,
      );
    };
    show();

    onCleanup(() => {
      disposed = true;
      closingOnPurpose = true;
      if (dialog.open) dialog.close();
      queueMicrotask(() => {
        const active = document.activeElement;
        const focusLeftWithDialog =
          active === null ||
          active === document.body ||
          dialog.contains(active);
        if (focusLeftWithDialog && returnTo?.isConnected) {
          returnTo.focus({ preventScroll: true });
        }
      });
    });
    onCleanup(
      registerDialog({
        element: dialogElement,
        escapeAction: () =>
          props.closeOnEscape === false ? undefined : props.onEscape,
        enterAction: () => props.onEnter,
        blocksBackgroundKeys: () => props.blockBackgroundKeys === true,
      }),
    );
  });

  const content = (
    <Show when={visible()}>
      <dialog
        {...props.dialogProps}
        ref={setDialogElement}
        tabIndex={-1}
        class={`${DIALOG_RESET_CLASS} ${props.dialogProps?.class ?? DIALOG_SHELL_CLASS}`}
        data-modal-root=""
        onCancel={(event) => {
          // Escape is routed through the dialog stack; the browser must not close the dialog itself.
          event.preventDefault();
        }}
        onFocusIn={(event) => {
          if (event.target instanceof HTMLElement)
            lastFocusedInside = event.target;
        }}
        onClose={(event) => {
          // Reopens a dialog the browser closed on its own while its owner still shows it.
          if (closingOnPurpose || !visible()) return;
          const dialog = event.currentTarget;
          dialog.showModal();
          focusDialogOnOpen(
            dialog,
            lastFocusedInside && dialog.contains(lastFocusedInside)
              ? lastFocusedInside
              : undefined,
          );
        }}
      >
        {props.children}
      </dialog>
    </Show>
  );
  return props.usePortal === false ? content : <Portal>{content}</Portal>;
}
