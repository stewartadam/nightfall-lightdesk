// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { XIcon } from "@squidlab/phosphor-solid/x";
import { type JSX, splitProps } from "solid-js";
import { ScrollArea } from "../scroll-area";
import { Button, type ButtonProps } from "../visual-language/button";

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
