// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/** Controls that can take keyboard focus, used when a dialog cannot take focus itself. */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not(:disabled)",
  'input:not([type="hidden"]):not(:disabled)',
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable=""]',
  '[contenteditable="true"]',
].join(", ");

/** Dialog containers that accept programmatic focus when no field should take it on open. */
const DIALOG_CONTAINER_SELECTOR =
  '[role="dialog"][tabindex], [role="alertdialog"][tabindex]';

/** Elements left inert by `inertOutside`, so only those are released again. */
const inertedByDialogs = new Set<HTMLElement>();

/**
 * Makes everything on the page except `keep` inert, the way a native modal
 * dialog blocks the document: neither Tab, clicks nor assistive technology can
 * reach it. Walks from `keep` up to `<body>` and marks every sibling along the
 * way, so overlays added later (menus, tooltips, toasts) stay usable. Calling
 * it again, or with no element, first releases what an earlier call marked.
 */
export function inertOutside(keep: HTMLElement | undefined): void {
  for (const element of inertedByDialogs) element.inert = false;
  inertedByDialogs.clear();
  if (!keep?.isConnected) return;

  for (
    let node: HTMLElement = keep;
    node.parentElement && node !== document.body;
    node = node.parentElement
  ) {
    for (const sibling of node.parentElement.children) {
      if (
        sibling === node ||
        !(sibling instanceof HTMLElement) ||
        sibling.inert ||
        sibling instanceof HTMLScriptElement ||
        sibling instanceof HTMLStyleElement ||
        sibling instanceof HTMLTemplateElement
      ) {
        continue;
      }
      sibling.inert = true;
      inertedByDialogs.add(sibling);
    }
  }
}

/**
 * Moves focus into a newly visible dialog unless its content already took it.
 * An `autofocus` element wins; otherwise the dialog container itself takes
 * focus, so Enter still runs the default action instead of activating the
 * first button. Containers that cannot take focus fall back to their first
 * focusable control.
 */
export function focusDialogOnOpen(container: HTMLElement): void {
  const active = document.activeElement;
  if (active && container.contains(active)) return;
  const target =
    container.querySelector<HTMLElement>("[autofocus]") ??
    (container.matches(DIALOG_CONTAINER_SELECTOR)
      ? container
      : container.querySelector<HTMLElement>(DIALOG_CONTAINER_SELECTOR)) ??
    container.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
  target?.focus({ preventScroll: true });
}
