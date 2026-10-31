// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { CaretLeftIcon } from "@squidlab/phosphor-solid/caret-left";
import { XIcon } from "@squidlab/phosphor-solid/x";
import {
  createContext,
  createSignal,
  createUniqueId,
  type JSX,
  Show,
  splitProps,
  useContext,
} from "solid-js";
import Modal from "../modal";
import { ScrollArea } from "../scroll-area";
import { Button, type ButtonProps } from "../visual-language/button";

/**
 * How a dialog may be dismissed.
 * - `task` commits work: header close plus a footer `DialogCancelButton`; outside clicks are ignored.
 * - `info` has nothing to commit: header close only; Escape and outside clicks also dismiss.
 * - `required` needs a choice: no header close, and Escape and outside clicks are ignored.
 */
export type DialogKind = "task" | "info" | "required";

/** A page a dialog has drilled into, which the header shows with a back button. */
export interface DialogPage {
  /** Heading shown in place of the dialog title while the page is open. */
  title: string;
  /** Accessible name for the back button. */
  backLabel: string;
  /** Returns to the previous level. */
  onBack: () => void;
}

interface DialogContextValue {
  dismiss: () => void;
  busy: () => boolean;
  /** Shows a page's title and back button in the header, or clears it with `undefined`. */
  setPage: (page: DialogPage | undefined) => void;
  /** Moves focus to the header back button, if one is showing. */
  focusBack: () => void;
}

const DialogContext = createContext<DialogContextValue>();

/**
 * Lays out the native `<dialog>` as the full-viewport backdrop that centers
 * the surface, with the dim and blur drawn by its `::backdrop`.
 */
const DIALOG_BACKDROP_CLASS =
  "nf-dialog-backdrop items-center justify-center overflow-x-hidden overflow-y-auto bg-transparent p-4 open:flex backdrop:bg-black/60 backdrop:backdrop-blur-[4px]";

export interface DialogProps {
  kind: DialogKind;
  isOpen: boolean;
  title: JSX.Element;
  /** Accessible name when it differs from the visible title. */
  label?: string;
  /** Secondary line under the title. */
  subtitle?: JSX.Element;
  /** Controls placed before the header close button. */
  headerActions?: JSX.Element;
  /** Shared handler for the header close, Cancel, Escape and (info only) outside clicks. */
  onDismiss?: () => void;
  /** Default action run by Enter when focus has no Enter behavior of its own. */
  onSubmit?: () => void;
  /**
   * Lets Escape dismiss a `required` dialog without adding a close button or
   * outside-click dismissal, for blocking notices that may hide content the
   * user needs to read underneath.
   */
  dismissOnEscape?: boolean;
  /** Locks every dismissal path and the default action while work cannot be cancelled. */
  busy?: boolean;
  /** Accessible name for the header close button. */
  closeLabel?: string;
  /** Holds back every key aimed outside the dialog while it is visible, for blocking confirmations. */
  blockBackgroundKeys?: boolean;
  usePortal?: boolean;
  /** `sheet` docks the surface to the bottom edge at full width, for compact screens. */
  placement?: "center" | "sheet";
  /** Width and height constraints for the surface. */
  class?: string;
  style?: JSX.CSSProperties;
  surfaceRef?: HTMLDivElement | ((element: HTMLDivElement) => void);
  /** Extra attributes for the `<dialog>` element, which is the backdrop and carries the dialog role. */
  backdropProps?: JSX.DialogHtmlAttributes<HTMLDialogElement>;
  /** Body and footer content; wrap them in a form when fields submit. */
  children: JSX.Element;
}

/**
 * Standard modal dialog that derives every close affordance from `kind`, so
 * dialogs inherit one dismissal pattern instead of wiring their own.
 */
export function Dialog(props: DialogProps) {
  const titleId = createUniqueId();
  const [page, setPage] = createSignal<DialogPage>();
  let backButton: HTMLButtonElement | undefined;
  /** Reports whether any dismissal path may close the dialog right now. */
  const canDismiss = () => props.kind !== "required" && !props.busy;
  /** Closes through the caller's handler unless the dialog is required or busy. */
  const dismiss = () => {
    if (canDismiss()) props.onDismiss?.();
  };
  /** Reports whether Escape may close the dialog, which `dismissOnEscape` extends to required dialogs. */
  const canEscape = () =>
    canDismiss() || (!!props.dismissOnEscape && !props.busy);
  /**
   * Steps back out of a drilled-in page when one is open, otherwise closes through the caller's
   * handler when Escape is allowed to dismiss.
   */
  const dismissFromEscape = () => {
    const current = page();
    if (current) {
      if (!props.busy) current.onBack();
      return;
    }
    if (canEscape()) props.onDismiss?.();
  };
  return (
    <Modal
      isOpen={props.isOpen}
      usePortal={props.usePortal}
      onEscape={dismissFromEscape}
      closeOnEscape={canEscape() || page() !== undefined}
      blockBackgroundKeys={props.blockBackgroundKeys}
      onEnter={
        props.onSubmit
          ? () => {
              if (!props.busy) props.onSubmit?.();
            }
          : undefined
      }
      dialogProps={{
        ...props.backdropProps,
        class: DIALOG_BACKDROP_CLASS,
        "data-placement": props.placement ?? "center",
        role: "dialog",
        "aria-modal": "true",
        "aria-label": props.label,
        "aria-labelledby": props.label ? undefined : titleId,
        "aria-busy": props.busy || undefined,
        onMouseDown: (event) => {
          if (props.kind === "info" && event.target === event.currentTarget)
            dismiss();
        },
      }}
    >
      <DialogContext.Provider
        value={{
          dismiss,
          busy: () => !!props.busy,
          setPage,
          focusBack: () => backButton?.focus(),
        }}
      >
        <DialogSurface
          ref={props.surfaceRef}
          role="document"
          class={props.class ?? "max-w-lg"}
          style={props.style}
        >
          <DialogHeader>
            <Show
              when={page()}
              fallback={
                <Show
                  when={props.subtitle}
                  fallback={
                    <DialogTitle id={titleId}>{props.title}</DialogTitle>
                  }
                >
                  <div class="min-w-0">
                    <DialogTitle id={titleId}>{props.title}</DialogTitle>
                    <p class="m-0 text-sm text-neutral-400">{props.subtitle}</p>
                  </div>
                </Show>
              }
            >
              {(current) => (
                <div class="-ml-2 flex min-w-0 items-center gap-1">
                  <DialogBackButton
                    ref={(element) => {
                      backButton = element;
                    }}
                    aria-label={current().backLabel}
                    disabled={props.busy}
                    onClick={() => current().onBack()}
                  />
                  <DialogTitle id={titleId}>{current().title}</DialogTitle>
                </div>
              )}
            </Show>
            <div class="flex shrink-0 items-center gap-2 empty:hidden">
              {props.headerActions}
              <Show when={props.kind !== "required"}>
                <DialogCloseButton
                  type="button"
                  aria-label={props.closeLabel ?? "Close"}
                  disabled={props.busy}
                  onClick={dismiss}
                />
              </Show>
            </div>
          </DialogHeader>
          {props.children}
        </DialogSurface>
      </DialogContext.Provider>
    </Modal>
  );
}

/**
 * Gives content drilled into a page of the enclosing `Dialog` its header title and back
 * button. Returns `undefined` outside a dialog, where the content shows its own back control.
 */
export function useDialogPage():
  | Pick<DialogContextValue, "setPage" | "focusBack">
  | undefined {
  const dialog = useContext(DialogContext);
  return dialog && { setPage: dialog.setPage, focusBack: dialog.focusBack };
}

/** Footer action that dismisses the enclosing `Dialog` through its shared handler and busy lock. */
export function DialogCancelButton(
  props: Omit<ButtonProps, "onClick" | "type">,
) {
  const dialog = useContext(DialogContext);
  const [local, rest] = splitProps(props, ["children", "disabled"]);
  return (
    <Button
      {...rest}
      type="button"
      disabled={local.disabled || dialog?.busy()}
      onClick={() => dialog?.dismiss()}
    >
      {local.children ?? "Cancel"}
    </Button>
  );
}

/** Provides the shared modal backdrop; the caller owns dismissal and modal lifecycle. */
export function DialogBackdrop(props: JSX.HTMLAttributes<HTMLDivElement>) {
  const [local, rest] = splitProps(props, ["class"]);
  return (
    <div
      class={`nf-dialog-backdrop fixed inset-0 flex items-center justify-center overflow-x-hidden overflow-y-auto p-4 bg-black/60 backdrop-blur-[4px] nightfall-top-layer ${local.class ?? ""}`}
      {...rest}
    />
  );
}

/** Frames dialog content with shared colors, borders and elevation while accepting a width constraint. */
export function DialogSurface(props: JSX.HTMLAttributes<HTMLDivElement>) {
  const [local, rest] = splitProps(props, ["class"]);
  return (
    <div
      class={`nf-dialog-surface flex w-full min-w-0 max-h-[calc(100dvh-32px)] flex-col overflow-hidden border border-[var(--line)] rounded-[var(--nf-corner-radius)] bg-[var(--panel)] text-neutral-100 [&>form]:flex [&>form]:min-h-0 [&>form]:flex-col [&>form]:overflow-hidden nightfall-modal-surface ${local.class ?? ""}`}
      {...rest}
    />
  );
}

/** Aligns a dialog title, optional actions and close control above the content. */
export function DialogHeader(props: JSX.HTMLAttributes<HTMLDivElement>) {
  const [local, rest] = splitProps(props, ["class"]);
  return (
    <div
      class={`nf-dialog-header flex shrink-0 items-center justify-between gap-3 border-b border-[var(--line)] px-4 py-3 ${local.class ?? ""}`}
      {...rest}
    />
  );
}

/** Supplies consistent dialog heading typography and an accessible labeling target. */
export function DialogTitle(props: JSX.HTMLAttributes<HTMLHeadingElement>) {
  const [local, rest] = splitProps(props, ["class"]);
  return (
    <h2
      class={`nf-dialog-title m-0 flex items-center gap-2 text-sm leading-5 font-semibold text-neutral-100 ${local.class ?? ""}`}
      {...rest}
    />
  );
}

interface DialogBodyProps extends JSX.HTMLAttributes<HTMLDivElement> {
  /** Disables body scrolling when a child owns the dialog's scroll viewport. */
  scrollable?: boolean;
}

/** Pads dialog content and marks overflowing edges, unless a child owns scrolling. */
export function DialogBody(props: DialogBodyProps) {
  const [local, rest] = splitProps(props, [
    "class",
    "style",
    "children",
    "scrollable",
  ]);
  if (local.scrollable !== false) {
    return (
      <ScrollArea
        class="nf-dialog-body min-h-0 min-w-0 flex-1"
        style={local.style}
        viewportClass={`p-4 ${local.class ?? ""}`}
        viewportProps={{ tabIndex: 0, ...rest }}
      >
        {local.children}
      </ScrollArea>
    );
  }
  return (
    <div
      class={`nf-dialog-body min-h-0 min-w-0 flex-1 overflow-hidden p-4 ${local.class ?? ""}`}
      style={local.style}
      {...rest}
    >
      {local.children}
    </div>
  );
}

/** Places dialog actions in a wrapping trailing row below a shared separator. */
export function DialogFooter(props: JSX.HTMLAttributes<HTMLDivElement>) {
  const [local, rest] = splitProps(props, ["class"]);
  return (
    <div
      class={`nf-dialog-footer flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-[var(--line)] px-4 py-3 ${local.class ?? ""}`}
      {...rest}
    />
  );
}

/** Returns from a drilled-in page to the level above it, shown at the leading edge of a header. */
export function DialogBackButton(
  props: Omit<ButtonProps, "children" | "size" | "variant">,
) {
  return (
    <Button aria-label="Back" {...props} size="icon" variant="subtle">
      <CaretLeftIcon class="size-4" aria-hidden />
    </Button>
  );
}

/** Renders the shared close action with a caller-supplied accessible label when needed. */
export function DialogCloseButton(
  props: Omit<ButtonProps, "children" | "size" | "variant">,
) {
  return (
    <Button aria-label="Close" {...props} size="icon" variant="subtle">
      <XIcon class="size-4" aria-hidden />
    </Button>
  );
}
