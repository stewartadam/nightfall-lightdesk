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
 * Fields that give Enter and Escape a meaning of their own while focused, such as an inline rename
 * that saves on Enter and discards on Escape, so neither key reaches the dialog behind them.
 */
const KEY_OWNING_CONTROL_SELECTOR = "[data-owns-dialog-keys]";

/**
 * Controls that already give Enter a meaning of their own (activation, newline,
 * selection), so the dialog default action must not run on top of them.
 */
const ENTER_OWNING_CONTROL_SELECTOR = [
  KEY_OWNING_CONTROL_SELECTOR,
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

/**
 * A transient floating layer (popover, menu, picker) above the page or a
 * dialog. It takes Escape ahead of everything beneath it but never counts as
 * an open dialog, so it neither defers workspace changes nor holds back
 * background keys.
 */
export interface DismissableLayerEntry {
  /** Reports whether a node belongs to the layer (its surface or anchor). */
  contains: (target: Node) => boolean;
  /** Dismisses the layer; omitted or returning undefined passes Escape to what lies beneath. */
  escapeAction: () => (() => void) | undefined;
}

/** One entry of the shared keyboard stack, in the order the layers became visible. */
type StackedLayer =
  | { kind: "dialog"; entry: DialogStackEntry }
  | { kind: "dismissable"; entry: DismissableLayerEntry };

const stackedLayers: StackedLayer[] = [];

/** Pushes a layer onto the shared stack and returns the function that removes it. */
function pushLayer(layer: StackedLayer): () => void {
  stackedLayers.push(layer);
  return () => {
    const index = stackedLayers.indexOf(layer);
    if (index !== -1) stackedLayers.splice(index, 1);
  };
}

/** Lists the visible dialogs, oldest first, leaving out transient layers. */
function openDialogs(): DialogStackEntry[] {
  return stackedLayers.flatMap((layer) =>
    layer.kind === "dialog" ? [layer.entry] : [],
  );
}

/** Adds a visible dialog to the top of the stack and returns its removal function. */
export function registerDialog(entry: DialogStackEntry): () => void {
  return pushLayer({ kind: "dialog", entry });
}

/**
 * Adds an open popover, menu or picker to the top of the stack and returns its
 * removal function. Use `createDismissable` rather than calling this directly.
 */
export function registerDismissableLayer(
  entry: DismissableLayerEntry,
): () => void {
  return pushLayer({ kind: "dismissable", entry });
}

/** Returns the dialog that currently owns the keyboard, if any dialog is open. */
export function frontmostDialog(): DialogStackEntry | undefined {
  const dialogs = openDialogs();
  return dialogs[dialogs.length - 1];
}

/**
 * Returns the Escape handler of the topmost transient layer that sits above
 * every dialog, or undefined when Escape belongs to the frontmost dialog (or
 * to nothing). Layers whose Escape is switched off pass it further down.
 */
export function dismissableEscapeAction(): (() => void) | undefined {
  for (let index = stackedLayers.length - 1; index >= 0; index -= 1) {
    const layer = stackedLayers[index];
    if (layer.kind === "dialog") return undefined;
    const action = layer.entry.escapeAction();
    if (action) return action;
  }
  return undefined;
}

/**
 * Reports whether a node belongs to a layer or dialog stacked above `entry`,
 * so a press inside a nested popover (or a dialog it opened) is not an outside
 * press for the layer beneath.
 */
export function isInsideLayerAbove(
  entry: DismissableLayerEntry,
  target: Node,
): boolean {
  const index = stackedLayers.findIndex((layer) => layer.entry === entry);
  if (index === -1) return false;
  return stackedLayers
    .slice(index + 1)
    .some((layer) =>
      layer.kind === "dialog"
        ? layer.entry.element()?.contains(target) === true
        : layer.entry.contains(target),
    );
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
  const dialogs = openDialogs();
  for (let index = dialogs.length - 1; index >= 0; index -= 1) {
    const element = dialogs[index].element();
    if (element instanceof HTMLDialogElement && element.open) return element;
  }
  return document.body;
}

/** Reports whether any dialog is visible, so user-initiated workspace changes can wait. */
export function hasOpenDialog(): boolean {
  return stackedLayers.some((layer) => layer.kind === "dialog");
}

/** Reports whether any visible dialog asks to hold back background keys and shortcuts. */
export function dialogBlocksBackgroundKeys(): boolean {
  return openDialogs().some((entry) => entry.blocksBackgroundKeys());
}

/** Reports whether an event target sits inside any open dialog. */
export function isInsideOpenDialog(target: EventTarget | null): boolean {
  if (!(target instanceof Node)) return false;
  return openDialogs().some((entry) => entry.element()?.contains(target));
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
 * Gives Escape to the topmost open popover or menu above every dialog, then
 * Enter and Escape to the frontmost dialog. Keys aimed outside it (a
 * background dialog, a panel, or nothing focused) never reach other listeners.
 * Inside it, focused controls keep their own Enter handling; the default action
 * runs after dispatch only when no handler prevented the key's default. Other
 * keys aimed outside it are held back too while any open dialog asks for it.
 */
function routeDialogKey(event: KeyboardEvent): void {
  if (event.type === "keydown" && event.key === "Escape") {
    const dismissLayer = dismissableEscapeAction();
    if (dismissLayer) {
      claimKey(event);
      dismissLayer();
      return;
    }
  }

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
    if (targetInside && target.closest(KEY_OWNING_CONTROL_SELECTOR)) {
      return;
    }
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
