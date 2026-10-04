// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { type JSX, onCleanup, onMount, splitProps } from "solid-js";
import { isInputField } from "../../lib/keyboard-shortcut-targets";

/** Controls a toolbar can hold; `[tabindex]` admits custom focusable widgets. */
const TOOLBAR_ITEM_SELECTOR = [
  "button",
  "a[href]",
  "input:not([type='hidden'])",
  "select",
  "textarea",
  "[tabindex]",
].join(",");

/** Marks controls whose `tabindex` the toolbar owns, distinguishing them from author-demoted ones. */
const ROVING_ATTRIBUTE = "data-toolbar-roving";

/** Input types whose arrow keys move the toolbar rather than edit a value. */
const BUTTON_LIKE_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "image",
  "reset",
  "submit",
]);

/** Returns whether a control uses arrow keys itself (text editing, choices, ranges). */
function claimsArrowKeys(element: HTMLElement): boolean {
  if (element instanceof HTMLInputElement)
    return !BUTTON_LIKE_INPUT_TYPES.has(element.type);
  return isInputField(element);
}

interface ToolbarProps
  extends Omit<
    JSX.HTMLAttributes<HTMLDivElement>,
    "role" | "onKeyDown" | "onFocusIn"
  > {
  /** Accessible name announced when focus enters the toolbar. */
  label: string;
  orientation?: "horizontal" | "vertical";
}

/**
 * Groups related controls into a single Tab stop following the WAI-ARIA
 * toolbar pattern. Only one control is tabbable at a time; arrow keys move
 * focus between controls (wrapping at either end) and Home/End jump to the
 * first or last control. Tabbing back in returns to the control used last.
 *
 * Disabled, inert and nested-toolbar controls are skipped. Arrow keys typed
 * into text fields, and keys a descendant already handled
 * (`event.preventDefault()`), keep their own behavior, so composite children
 * such as a selectable step strip can claim arrows for themselves.
 */
export function Toolbar(props: ToolbarProps) {
  const [local, rest] = splitProps(props, ["label", "orientation", "ref"]);
  let root!: HTMLDivElement;
  let active: HTMLElement | undefined;
  let activeIndex = 0;

  /** Whether keyboard focus was last inside the toolbar, rather than moved elsewhere. */
  let holdsFocus = false;

  /** Returns whether a control sits in an inert subtree of the toolbar's own content. */
  const inertWithinToolbar = (element: HTMLElement): boolean => {
    const inertRoot = element.closest("[inert]");
    return inertRoot !== null && inertRoot !== root && root.contains(inertRoot);
  };

  /** Lists the controls arrow keys can reach: enabled and currently rendered. */
  const reachableItems = (): HTMLElement[] =>
    items().filter(
      (element) =>
        element.checkVisibility?.({ visibilityProperty: true }) ??
        element.getClientRects().length > 0,
    );

  /**
   * Lists the toolbar's own enabled controls in DOM order. Only `inert`
   * inside the toolbar counts: an inert or hidden ancestor (such as an
   * inactive workspace) disables the whole toolbar without notifying it, so
   * the Tab stop assignment must not depend on it.
   */
  const items = (): HTMLElement[] =>
    Array.from(
      root.querySelectorAll<HTMLElement>(TOOLBAR_ITEM_SELECTOR),
    ).filter(
      (element) =>
        element.closest('[role="toolbar"]') === root &&
        !element.matches(":disabled") &&
        !inertWithinToolbar(element) &&
        (element.getAttribute("tabindex") !== "-1" ||
          element.hasAttribute(ROVING_ATTRIBUTE)),
    );

  /** Makes `next` the toolbar's only tabbable control and demotes the rest. */
  const setActive = (next: HTMLElement | undefined, all = items()) => {
    active = next;
    if (next) activeIndex = all.indexOf(next);
    for (const item of all) {
      item.setAttribute(ROVING_ATTRIBUTE, "");
      item.tabIndex = item === next ? 0 : -1;
    }
  };

  /**
   * Picks the control that inherits the Tab stop from a disabled or removed
   * one: the next control after it in the document, else the last control.
   */
  const successor = (previous: HTMLElement, all: HTMLElement[]) => {
    if (!previous.isConnected)
      return all[Math.min(activeIndex, all.length - 1)];
    return (
      all.find(
        (item) =>
          previous.compareDocumentPosition(item) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ) ?? all[all.length - 1]
    );
  };

  /**
   * Keeps exactly one tabbable control as controls mount, unmount, or toggle
   * disabled. When the focused control is disabled or removed (for example a
   * Delete button that disables itself), focus follows its Tab stop to the
   * successor instead of dropping to the page body.
   */
  const sync = () => {
    const all = items();
    if (active && all.includes(active)) {
      setActive(active, all);
      return;
    }
    const next = active ? successor(active, all) : all[0];
    // Browsers blur a disabled control lazily, so it may still hold focus here.
    const focused = root.ownerDocument.activeElement;
    const focusLost =
      holdsFocus && (focused === active || focused === root.ownerDocument.body);
    setActive(next, all);
    if (focusLost) next?.focus();
  };

  /** Remembers the control that received focus so Tab returns to it. */
  const handleFocusIn = (event: FocusEvent) => {
    holdsFocus = true;
    const all = items();
    const target = event.target;
    if (target instanceof HTMLElement && all.includes(target))
      setActive(target, all);
  };

  /**
   * Notes focus leaving for another element. A blur with no destination is
   * what a disabled control produces, so it keeps the toolbar's claim.
   */
  const handleFocusOut = (event: FocusEvent) => {
    const destination = event.relatedTarget;
    if (destination instanceof Node && !root.contains(destination))
      holdsFocus = false;
  };

  /**
   * Moves focus between controls with arrow, Home and End keys. Bound as a
   * delegated Solid handler so descendants' own handlers run first and can
   * claim a key with `preventDefault()`.
   */
  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey) return;
    if (event.metaKey || event.shiftKey) return;
    const target = event.target;
    if (!(target instanceof HTMLElement) || claimsArrowKeys(target)) return;
    const all = reachableItems();
    const index = all.indexOf(target);
    if (index < 0) return;
    const vertical = local.orientation === "vertical";
    const forward = vertical ? "ArrowDown" : "ArrowRight";
    const backward = vertical ? "ArrowUp" : "ArrowLeft";
    let next: number;
    switch (event.key) {
      case forward:
        next = (index + 1) % all.length;
        break;
      case backward:
        next = (index + all.length - 1) % all.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = all.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    all[next].focus();
    all[next].scrollIntoView({ block: "nearest", inline: "nearest" });
  };

  onMount(() => {
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["disabled", "inert"],
    });
    onCleanup(() => observer.disconnect());
  });

  return (
    <div
      {...rest}
      ref={(element) => {
        root = element;
        if (typeof local.ref === "function") local.ref(element);
      }}
      role="toolbar"
      aria-label={local.label}
      aria-orientation={local.orientation ?? "horizontal"}
      data-component="Toolbar"
      onFocusIn={handleFocusIn}
      onFocusOut={handleFocusOut}
      onKeyDown={handleKeyDown}
    />
  );
}
