// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { DockviewApi } from "dockview";
import { createSignal } from "solid-js";

/**
 * Tracks which component (identified by ID) currently has focus.
 * Components register themselves and the system tracks which component's DOM tree
 * was most recently interacted with (clicked, focused, or typed in).
 */

const [focusedComponentId, setFocusedComponentId] = createSignal<string | null>(
  null,
);
const registeredComponents = new Map<string, Set<HTMLElement>>();

// Track the last component that was interacted with
let lastInteractedComponentId: string | null = null;
let suppressShellDockFallback = false;

// Optional getter for DockView API, used as fallback for focus detection
let dockApiGetter: (() => DockviewApi | null) | null = null;

/** Options controlling how focus is resolved for an interaction. */
interface FocusUpdateOptions {
  allowDockFallback?: boolean;
}

/** Returns whether an element should keep ownership of unmodified text keys. */
function isEditableFocusTarget(element: Element | null): boolean {
  const candidate = element as {
    tagName?: string;
    isContentEditable?: boolean;
  } | null;
  if (!candidate?.tagName) return false;
  const tagName = candidate.tagName.toLowerCase();
  return (
    tagName === "input" ||
    tagName === "textarea" ||
    tagName === "select" ||
    candidate.isContentEditable === true
  );
}

/** Returns whether the element is an unfocused document shell target. */
function isDocumentShellElement(element: Element | null): boolean {
  return element === document.body || element === document.documentElement;
}

/** Clears tracked component focus when interaction moves outside registered components. */
function clearTrackedComponentFocus(): void {
  lastInteractedComponentId = null;
  setFocusedComponentId(null);
}

/** Prevents shell-level key events after editable blur from restoring DockView focus. */
export function suppressDockFallbackAfterEditableBlur(): void {
  suppressShellDockFallback = true;
  clearTrackedComponentFocus();
}

/** Marks a registered component as the current keyboard shortcut target. */
export function focusTrackedComponent(componentId: string): void {
  if (!registeredComponents.has(componentId)) return;
  suppressShellDockFallback = false;
  lastInteractedComponentId = componentId;
  setFocusedComponentId(componentId);
}

/**
 * Register a component to participate in focus tracking
 * @param componentId Unique identifier for this component
 * @param element The root DOM element of the component
 * @returns Unregister function
 */
export function registerComponentFocus(
  componentId: string,
  element: HTMLElement,
): () => void {
  const elements =
    registeredComponents.get(componentId) ?? new Set<HTMLElement>();
  elements.add(element);
  registeredComponents.set(componentId, elements);

  /** Set up event listeners to track interactions within this component */
  const handleInteraction = () => {
    lastInteractedComponentId = componentId;
    setFocusedComponentId(componentId);
  };

  // Track various interaction events
  element.addEventListener("click", handleInteraction, { capture: true });
  element.addEventListener("pointerdown", handleInteraction, { capture: true });
  element.addEventListener("focus", handleInteraction, { capture: true });
  element.addEventListener("input", handleInteraction, { capture: true });
  element.addEventListener("keydown", handleInteraction, { capture: true });

  return () => {
    elements.delete(element);
    if (!elements.size) registeredComponents.delete(componentId);
    // Remove event listeners
    element.removeEventListener("click", handleInteraction, { capture: true });
    element.removeEventListener("pointerdown", handleInteraction, {
      capture: true,
    });
    element.removeEventListener("focus", handleInteraction, { capture: true });
    element.removeEventListener("input", handleInteraction, { capture: true });
    element.removeEventListener("keydown", handleInteraction, {
      capture: true,
    });
    // If this was the focused component, clear focus
    if (!elements.size && focusedComponentId() === componentId) {
      setFocusedComponentId(null);
      lastInteractedComponentId = null;
    }
  };
}

/**
 * Register a getter function for the DockView API
 * Used as a fallback when DOM-based focus detection fails (e.g., clicking on dv-content-container)
 */
export function setDockApiGetter(getter: () => DockviewApi | null): void {
  dockApiGetter = getter;
}

/**
 * Update focused component based on current DOM focus and interaction history
 * Called by the keyboard shortcuts system when a key is pressed
 */
export function updateFocusedComponent(
  target?: Element | null,
  options: FocusUpdateOptions = {},
): void {
  const activeElement = target ?? document.activeElement;
  if (activeElement && !isDocumentShellElement(activeElement)) {
    suppressShellDockFallback = false;
  }
  // First, try to find which registered component contains the active element.
  // Editable targets own bare text keys, but stale non-editable focus should not
  // override a newer pointer/click interaction in another registered component.
  if (activeElement) {
    for (const [componentId, elements] of registeredComponents.entries()) {
      if (
        [...elements].some((element) => element.contains(activeElement as Node))
      ) {
        if (!isEditableFocusTarget(activeElement)) {
          const dockActivePanelId = dockApiGetter?.()?.activePanel?.id ?? null;
          if (
            dockActivePanelId &&
            dockActivePanelId !== componentId &&
            registeredComponents.has(dockActivePanelId)
          ) {
            lastInteractedComponentId = dockActivePanelId;
            setFocusedComponentId(dockActivePanelId);
            return;
          }
          if (
            lastInteractedComponentId &&
            lastInteractedComponentId !== componentId
          ) {
            setFocusedComponentId(lastInteractedComponentId);
            return;
          }
        }
        lastInteractedComponentId = componentId;
        setFocusedComponentId(componentId);
        return;
      }
    }
  }

  const allowDockFallback = options.allowDockFallback ?? true;
  if (!allowDockFallback && isDocumentShellElement(activeElement)) {
    if (lastInteractedComponentId) {
      setFocusedComponentId(lastInteractedComponentId);
      return;
    }
    setFocusedComponentId(null);
    return;
  }
  if (!allowDockFallback) {
    clearTrackedComponentFocus();
    return;
  }

  if (suppressShellDockFallback && isDocumentShellElement(activeElement)) {
    setFocusedComponentId(null);
    return;
  }

  // Fallback: Check if we're in a DockView panel that isn't in our component tree
  // This handles clicks on dv-content-container or other non-registered DockView elements
  if (dockApiGetter) {
    const dockApi = dockApiGetter();
    if (dockApi?.activePanel?.id) {
      lastInteractedComponentId = dockApi.activePanel.id;
      setFocusedComponentId(dockApi.activePanel.id);
      return;
    }
  }

  // If no component contains the active element, use the last interacted component
  // This handles divs and other non-focusable elements
  if (lastInteractedComponentId) {
    setFocusedComponentId(lastInteractedComponentId);
    return;
  }

  // No registered component found
  setFocusedComponentId(null);
}

/**
 * Get the currently focused component ID
 */
export function getFocusedComponentId(): string | null {
  return focusedComponentId();
}
