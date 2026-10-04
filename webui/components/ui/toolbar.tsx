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

  /** Lists the toolbar's own enabled controls in DOM order. */
  const items = (): HTMLElement[] =>
    Array.from(
      root.querySelectorAll<HTMLElement>(TOOLBAR_ITEM_SELECTOR),
    ).filter(
      (element) =>
        element.closest('[role="toolbar"]') === root &&
        !element.matches(":disabled") &&
        element.closest("[inert]") === null &&
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
   * Keeps exactly one tabbable control as controls mount, unmount, or toggle
   * disabled. A vanished active control hands its Tab stop to whichever
   * control now occupies its position.
   */
  const sync = () => {
    const all = items();
    const next =
      active && all.includes(active)
        ? active
        : all[Math.min(activeIndex, all.length - 1)];
    setActive(next, all);
  };

  /** Remembers the control that received focus so Tab returns to it. */
  const handleFocusIn = (event: FocusEvent) => {
    const all = items();
    const target = event.target;
    if (target instanceof HTMLElement && all.includes(target))
      setActive(target, all);
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
    if (!(target instanceof HTMLElement) || isInputField(target)) return;
    const all = items();
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
      onKeyDown={handleKeyDown}
    />
  );
}
