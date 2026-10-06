// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

export interface EditableShortcutHandler {
  allowInEditable?: boolean;
}

/**
 * Returns whether an element should be treated as an editable shortcut target.
 */
export function isInputField(element: HTMLElement): boolean {
  return (
    element.tagName === "INPUT" ||
    element.tagName === "TEXTAREA" ||
    element.tagName === "SELECT" ||
    element.isContentEditable
  );
}

/**
 * Returns whether an element belongs to the TanStack data-grid surface.
 */
export function isDataGridElement(element: HTMLElement | null): boolean {
  if (!element) return false;
  return element.closest('[data-grid-kind="tanstack"]') !== null;
}

/** Controls the browser activates natively when they receive Enter or Space. */
const NATIVE_ACTIVATION_SELECTOR = [
  "button",
  "a[href]",
  "summary",
  '[role="button"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="tab"]',
  '[role="checkbox"]',
  '[role="switch"]',
  '[role="radio"]',
  '[role="option"]',
].join(", ");

/**
 * Returns whether Enter or Space aimed at the target activates a control
 * natively, so a shortcut bound to those keys would swallow the activation.
 */
export function targetOwnsActivationKey(
  target: HTMLElement | null,
  event: Pick<KeyboardEvent, "key" | "altKey" | "ctrlKey" | "metaKey">,
): boolean {
  if (!target || (event.key !== "Enter" && event.key !== " ")) return false;
  if (event.altKey || event.ctrlKey || event.metaKey) return false;
  return target.closest(NATIVE_ACTIVATION_SELECTOR) !== null;
}

/**
 * Filters shortcut handlers so editable controls keep native editing behavior
 * unless a matching shortcut explicitly opts into editable targets.
 */
export function shortcutHandlersForTarget<
  Handler extends EditableShortcutHandler,
>(
  handlers: readonly Handler[],
  shortcutTarget: HTMLElement | null,
  event: Pick<KeyboardEvent, "key">,
): Handler[] {
  const targetIsEditable =
    shortcutTarget !== null && isInputField(shortcutTarget);
  const isEnterOnDataGridInput =
    event.key === "Enter" && isDataGridElement(shortcutTarget);

  if (!targetIsEditable || isEnterOnDataGridInput) {
    return [...handlers];
  }

  return handlers.filter((handler) => handler.allowInEditable);
}
