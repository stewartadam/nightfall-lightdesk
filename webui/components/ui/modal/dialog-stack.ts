// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/** One visible dialog's keyboard contract, ordered by when it became visible. */
export interface DialogStackEntry {
  /** Root element containing everything the dialog renders. */
  element: () => HTMLElement | undefined;
  /** Dismisses the dialog; omitted or returning undefined leaves Escape alone. */
  escapeAction: () => (() => void) | undefined;
  /** Runs the dialog's default action when Enter is not claimed by a focused control. */
  enterAction: () => (() => void) | undefined;
  /** Keeps every key aimed outside the frontmost dialog away from background shortcuts. */
  blocksBackgroundKeys: () => boolean;
}

/**
 * Controls that already give Enter a meaning of their own (activation, newline,
 * selection), so the dialog default action must not run on top of them.
 */
const ENTER_OWNING_CONTROL_SELECTOR = [
  "button",
  "a[href]",
  "textarea",
  "select",
  "summary",
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[role="button"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="combobox"]',
  '[role="tab"]',
  '[role="checkbox"]',
  '[role="switch"]',
  '[role="radio"]',
  'input[type="button"]',
  'input[type="submit"]',
  'input[type="reset"]',
  'input[type="file"]',
  'input[type="color"]',
].join(", ");

const openDialogs: DialogStackEntry[] = [];

/** Adds a visible dialog to the top of the stack and returns its removal function. */
export function registerDialog(entry: DialogStackEntry): () => void {
  openDialogs.push(entry);
  return () => {
    const index = openDialogs.indexOf(entry);
    if (index !== -1) openDialogs.splice(index, 1);
  };
}

/** Returns the dialog that currently owns the keyboard, if any dialog is open. */
export function frontmostDialog(): DialogStackEntry | undefined {
  return openDialogs[openDialogs.length - 1];
}

/**
 * Returns where a floating overlay (menu, tooltip, list) should mount so it
 * stays visible and interactive. An open modal `<dialog>` sits in the
 * browser's top layer and makes everything outside it inert, so overlays
 * mount inside the dialog that contains their anchor (even one still about
 * to open, since content mounts just before `showModal()`), else inside the
 * frontmost modal dialog, else on `<body>`.
 */
export function overlayHost(anchor?: Element | null): HTMLElement {
  const anchorDialog = anchor?.closest("dialog");
  if (anchorDialog) return anchorDialog;
  for (let index = openDialogs.length - 1; index >= 0; index -= 1) {
    const element = openDialogs[index].element();
    if (element instanceof HTMLDialogElement && element.open) return element;
  }
  return document.body;
}

/** Reports whether any dialog is visible, so user-initiated workspace changes can wait. */
export function hasOpenDialog(): boolean {
  return openDialogs.length > 0;
}

/** Reports whether any visible dialog asks to hold back background keys and shortcuts. */
export function dialogBlocksBackgroundKeys(): boolean {
  return openDialogs.some((entry) => entry.blocksBackgroundKeys());
}

/** Reports whether an event target sits inside any open dialog. */
export function isInsideOpenDialog(target: EventTarget | null): boolean {
  if (!(target instanceof Node)) return false;
  return openDialogs.some((entry) => entry.element()?.contains(target));
}

/** Reports whether a target inside a dialog handles Enter itself, including implicit form submission. */
function targetOwnsEnter(target: Element): boolean {
  if (target.closest(ENTER_OWNING_CONTROL_SELECTOR)) return true;
  return target instanceof HTMLInputElement && target.form !== null;
}

/** Stops a key from reaching any listener behind the frontmost dialog. */
function claimKey(event: KeyboardEvent): void {
  event.preventDefault();
  event.stopImmediatePropagation();
}

/**
 * Gives Enter and Escape to the frontmost dialog. Keys aimed outside it (a
 * background dialog, a panel, or nothing focused) never reach other listeners.
 * Inside it, focused controls keep their own Enter handling; the default action
 * runs after dispatch only when no handler prevented the key's default. Other
 * keys aimed outside it are held back too while any open dialog asks for it.
 */
function routeDialogKey(event: KeyboardEvent): void {
  const dialog = frontmostDialog();
  if (!dialog) return;

  const root = dialog.element();
  const target = event.target instanceof Element ? event.target : null;
  const targetInside = target !== null && root?.contains(target) === true;

  if (
    event.type !== "keydown" ||
    (event.key !== "Enter" && event.key !== "Escape")
  ) {
    if (!targetInside && dialogBlocksBackgroundKeys()) {
      event.stopImmediatePropagation();
    }
    return;
  }

  if (event.key === "Escape") {
    const dismiss = dialog.escapeAction();
    if (dismiss) {
      claimKey(event);
      dismiss();
    } else if (!targetInside) {
      claimKey(event);
    } else {
      // Keeps the browser from turning Escape into a close request on a native modal dialog.
      event.preventDefault();
    }
    return;
  }

  const plainEnter =
    !event.repeat &&
    !event.isComposing &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey;

  if (!targetInside) {
    claimKey(event);
    const nothingFocused =
      target === null ||
      target === document.body ||
      target === document.documentElement;
    if (plainEnter && nothingFocused) dialog.enterAction()?.();
    return;
  }

  if (!plainEnter || !target || targetOwnsEnter(target)) return;
  if (!dialog.enterAction()) return;
  setTimeout(() => {
    if (event.defaultPrevented || frontmostDialog() !== dialog) return;
    dialog.enterAction()?.();
  }, 0);
}

const LISTENER_KEY = Symbol.for("nightfall.dialogStack.keydown");
type ListenerHost = typeof globalThis & {
  [LISTENER_KEY]?: (event: KeyboardEvent) => void;
};
const ROUTED_KEY_EVENTS = ["keydown", "keyup", "keypress"] as const;

/**
 * Installs the router once per page at module load, ahead of the shortcut and
 * panel listeners that register later on window, so the frontmost dialog sees
 * keys first. A hot reload swaps the previous listener out.
 */
function installDialogKeyRouter(): void {
  if (typeof window === "undefined") return;
  const host = globalThis as ListenerHost;
  const previous = host[LISTENER_KEY];
  for (const type of ROUTED_KEY_EVENTS) {
    if (previous) window.removeEventListener(type, previous, true);
    window.addEventListener(type, routeDialogKey, true);
  }
  host[LISTENER_KEY] = routeDialogKey;
}

installDialogKeyRouter();
