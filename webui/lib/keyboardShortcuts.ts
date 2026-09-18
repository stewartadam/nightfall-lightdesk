// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createEffect, createSignal, onCleanup, untrack } from "solid-js";
import { matchKeybindingPress, parseKeybinding, tinykeys } from "tinykeys";
import {
  getFocusedComponentId,
  suppressDockFallbackAfterEditableBlur,
  updateFocusedComponent,
} from "./componentFocusContext";
import { engineRuntime } from "./engine-runtime";
import {
  isDataGridElement,
  isInputField,
  shortcutHandlersForTarget,
} from "./keyboard-shortcut-targets";
import { getLogger } from "./logger";

import { useWorkspaceActivity } from "./workspace-activity";

const log = getLogger(import.meta.url);

// Define a type for keyboard shortcuts
export interface KeyboardShortcut {
  key: string;
  handler: (event?: KeyboardEvent) => unknown;
  description: string;
  componentId?: string;
  group?: string; // Human-readable group name for organizing shortcuts in help
  capture?: boolean;
  allowInEditable?: boolean;
}

/**
 * Returns whether a keyboard target should recover focus from the active DockView panel.
 */
function allowsDockFocusFallback(target: HTMLElement | null): boolean {
  if (!target) return true;
  return !isInputField(target) && !isDataGridElement(target);
}

// Store for tracking registered shortcuts
const [shortcuts, setShortcuts] = createSignal<KeyboardShortcut[]>([]);

// Export the shortcuts signal for reactive access
export const allShortcuts = shortcuts;

// Track tinykeys unregister function
let unregisterTinykeys: (() => void) | null = null;
let unregisterSequenceCaptureTinykeys: (() => void) | null = null;

// Track the current keymap to avoid recreating handlers
// Each key can have multiple handlers, one per panel context
interface ShortcutHandler {
  componentId?: string; // Component context for this handler, undefined means global
  handler: (event?: KeyboardEvent) => unknown;
  description: string;
  allowInEditable?: boolean;
}

/**
 * Detects if a shortcut would collide with existing shortcuts
 * A collision occurs when the same key is registered:
 * 1. For the same specific component, or
 * 2. Both globally (no componentId specified)
 *
 * @param shortcut The shortcut to check
 * @param existingShortcuts List of existing shortcuts
 * @returns The colliding shortcut or undefined if no collision
 */
function findCollision(
  shortcut: KeyboardShortcut,
  existingShortcuts: KeyboardShortcut[],
): KeyboardShortcut | undefined {
  const normalizedKey = normalizeKeyString(shortcut.key);

  return existingShortcuts.find((existing) => {
    const existingNormalizedKey = normalizeKeyString(existing.key);
    if (existingNormalizedKey !== normalizedKey) {
      return false;
    }

    // Both shortcuts are for the same specific component
    if (
      existing.componentId &&
      shortcut.componentId &&
      existing.componentId === shortcut.componentId
    ) {
      return true;
    }

    // Both shortcuts are global (no component specified)
    if (!existing.componentId && !shortcut.componentId) {
      return true;
    }

    return false;
  });
}

// Map of key to array of handlers (to support multiple panels using same key)
const keyMap: Record<string, (event: KeyboardEvent) => void> = {};
const sequenceCaptureKeyMap: Record<string, (event: KeyboardEvent) => void> =
  {};

// Internal tracking of shortcuts by key for panel-specific handling
const shortcutsByKey: Record<string, ShortcutHandler[]> = {};
const captureDispatchedEvents = new WeakSet<KeyboardEvent>();
const ARROW_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);
const PAGE_KEYS = new Set(["PageUp", "PageDown"]);

/**
 * Returns whether a keyboard event matches the registered shortcut key.
 */
function shortcutMatchesEvent(key: string, event: KeyboardEvent): boolean {
  const normalizedKey = normalizeKeyString(key);
  if (
    (normalizedKey === "Shift+?" || normalizedKey === "Shift+/") &&
    event.shiftKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.metaKey &&
    (event.key === "?" || event.code === "Slash")
  ) {
    return true;
  }

  return parseKeybinding(normalizedKey).some((binding) =>
    matchKeybindingPress(event, binding),
  );
}

/**
 * Returns whether tinykeys should ignore an event before matching shortcuts.
 */
function shouldIgnoreTinykeysEvent(event: KeyboardEvent): boolean {
  if (event.repeat || event.isComposing) {
    return true;
  }

  const eventTarget = event.target instanceof HTMLElement ? event.target : null;
  const activeElement =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  const shortcutTarget = eventTarget ?? activeElement;

  if (
    !shortcutTarget ||
    shortcutTarget === event.currentTarget ||
    !isInputField(shortcutTarget)
  ) {
    return false;
  }

  const isModifierKeyPressed = event.ctrlKey || event.altKey || event.metaKey;
  const isEnterOnDataGridInput =
    event.key === "Enter" && isDataGridElement(shortcutTarget);

  return !isModifierKeyPressed && !isEnterOnDataGridInput;
}

/**
 * Dispatches capture-phase shortcuts before focused widgets can consume them.
 */
function dispatchCapturedShortcut(
  event: KeyboardEvent,
  target: HTMLElement | null,
): boolean {
  const activeElement = document.activeElement as HTMLElement | null;
  const shortcutTarget = target ?? activeElement;
  const targetIsEditable =
    shortcutTarget !== null && isInputField(shortcutTarget);

  for (const shortcut of shortcuts()) {
    if (!shortcut.capture) {
      continue;
    }
    if (targetIsEditable && !shortcut.allowInEditable) {
      continue;
    }
    if (!shortcutMatchesEvent(shortcut.key, event)) {
      continue;
    }

    const handled = dispatchShortcutForKey(
      normalizeKeyString(shortcut.key),
      event,
      shortcutTarget,
    );
    if (handled) {
      captureDispatchedEvents.add(event);
      event.stopImmediatePropagation();
      return true;
    }
  }

  return false;
}

/**
 * Returns the normalized shortcut key for events that must be handled during
 * the capture phase instead of waiting for tinykeys' bubble-phase listener.
 *
 * Data grids and embedded editors can consume navigation keys before they
 * bubble to tinykeys. Capturing modified arrows keeps panel shortcuts like cue
 * preview transport reliable while still leaving plain arrows available for
 * grid navigation, capturing Control+PageUp/PageDown keeps panel traversal
 * reliable, and capturing bare Enter keeps data-grid Enter shortcuts working
 * when the grid owns focus.
 */
function captureShortcutKey(
  event: KeyboardEvent,
  target: HTMLElement | null,
): string | undefined {
  if (
    event.key === "Enter" &&
    !event.shiftKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.metaKey &&
    isDataGridElement(target)
  ) {
    return "Enter";
  }

  if (
    PAGE_KEYS.has(event.key) &&
    event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    !event.metaKey
  ) {
    return `Control+${event.key}`;
  }

  if (!ARROW_KEYS.has(event.key) || event.shiftKey || event.metaKey) {
    return undefined;
  }

  if (event.altKey && !event.ctrlKey) {
    return `Alt+${event.key}`;
  }

  if (event.ctrlKey && !event.altKey) {
    return `Control+${event.key}`;
  }

  return undefined;
}

/**
 * Dispatches the best matching shortcut handler while preserving native editing
 * behavior for editable targets unless a shortcut explicitly opts in.
 */
function dispatchShortcutForKey(
  key: string,
  event: KeyboardEvent,
  target?: HTMLElement | null,
): boolean {
  // Capture-phase shortcuts run before the connection overlay's document listener.
  if (document.querySelector('[data-overlay-kind="connection"]')) {
    return false;
  }

  let handlers = shortcutsByKey[key];
  if (!handlers || handlers.length === 0) {
    return false;
  }

  const activeElement = document.activeElement as HTMLElement | null;
  const eventTarget = event.target instanceof HTMLElement ? event.target : null;
  const shortcutTarget = target ?? eventTarget ?? activeElement;
  handlers = shortcutHandlersForTarget(handlers, shortcutTarget, event);
  if (handlers.length === 0) {
    return false;
  }

  const currentComponentId = getFocusedComponentId();
  log.debug(`Shortcut detected: ${key} in component ${currentComponentId}`);

  // First try to find a component-specific handler that matches the current component
  const componentSpecificHandler = handlers.find(
    (h) => h.componentId === currentComponentId,
  );
  if (componentSpecificHandler) {
    const handled = componentSpecificHandler.handler(event);
    if (handled !== false) {
      event.preventDefault();
      return true;
    }
  }

  // If no component-specific handler matches, try global handlers
  const globalHandler = handlers.find((h) => !h.componentId);
  if (globalHandler) {
    const handled = globalHandler.handler(event);
    if (handled !== false) {
      event.preventDefault();
      return true;
    }
  }

  return false;
}

// Handle to the unregister function created by initKeyboardShortcuts
let unregisterListeners: () => void = () => {};
let unregisterGlobalShortcuts: () => void = () => {};
let shortcutRootGeneration = 0;

/**
 * Removes the root keyboard listeners and global shortcuts owned by this module.
 */
function cleanupKeyboardShortcutRoot() {
  shortcutRootGeneration += 1;
  unregisterGlobalShortcuts();
  unregisterGlobalShortcuts = () => {};
  unregisterListeners();
  unregisterListeners = () => {};
}

/**
 * Initialize keyboard shortcuts system
 * This should be called once when the app starts
 */
export function initKeyboardShortcuts() {
  cleanupKeyboardShortcutRoot();
  const rootGeneration = shortcutRootGeneration;

  // Additional logging for development
  log.debug("Initializing keyboard shortcuts system");

  /** Create a more direct DOM event handler to catch all keys that the browser may not bubble up to tinykeys */
  const handleKeyDown = (event: KeyboardEvent) => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    const allowDockFallback = allowsDockFocusFallback(target);
    // Update focused component immediately from the key event target.
    updateFocusedComponent(target, { allowDockFallback });
    const targetIsInputField = target ? isInputField(target) : false;
    const isEnterOnDataGridInput =
      event.key === "Enter" && isDataGridElement(target);
    if (dispatchCapturedShortcut(event, target)) {
      return;
    }
    if (targetIsInputField && !isEnterOnDataGridInput) {
      // If we're in an input field, don't interfere with typing
      return;
    }

    // For browser-wide shortcuts like Space, prevent default browser behavior immediately
    if (event.key === " " || event.key === "Space" || event.code === "Space") {
      // Find any Space shortcuts that apply to the current component
      const spaceShortcuts = shortcuts().filter((shortcut) => {
        const shortcutApplies =
          shortcut.key === "Space" || shortcut.key === " ";
        const componentMatches =
          !shortcut.componentId ||
          shortcut.componentId === getFocusedComponentId();
        return shortcutApplies && componentMatches;
      });

      if (spaceShortcuts.length > 0) {
        // If we have a matching shortcut, prevent default to avoid page scrolling
        event.preventDefault();
      }
    }

    const capturedShortcutKey = captureShortcutKey(event, target);
    if (capturedShortcutKey) {
      const handled = dispatchShortcutForKey(capturedShortcutKey, event);
      if (handled) {
        captureDispatchedEvents.add(event);
      }
    }
  };

  // Capture key events in the capture phase to get them before other handlers
  // Add at the window level to catch all keys, including those not bubbling from the active element
  window.addEventListener("keydown", handleKeyDown, { capture: true });

  // Set up the tinykeys listeners after the focus capture listener so chord
  // dispatch sees the component focus from the current event target.
  updateKeyListeners();

  /** Update focused component on focus change and clicks */
  const handleFocus = (event: Event) => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    const targetIsEditableSurface =
      target !== null && (isInputField(target) || isDataGridElement(target));
    updateFocusedComponent(target, {
      allowDockFallback: !targetIsEditableSurface,
    });
  };

  window.addEventListener("focus", handleFocus, { capture: true });
  window.addEventListener("click", handleFocus, { capture: true });

  /** Clears panel shortcut ownership when editing ends without a new panel target. */
  const handleFocusOut = (event: Event) => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target && (isInputField(target) || isDataGridElement(target))) {
      suppressDockFallbackAfterEditableBlur();
    }
  };

  window.addEventListener("focusout", handleFocusOut, { capture: true });

  // Register global undo/redo shortcuts
  const unregisterUndoShortcut = registerKeyboardShortcut(
    {
      key: "$mod+z",
      handler: () => {
        engineRuntime.sendCommand({
          module: "UndoCommand",
          command: { type: "Undo", data: {} },
        });
      },
      description: "Undo",
    },
    { global: true },
  );
  const unregisterRedoShortcut = registerKeyboardShortcut(
    {
      key: "$mod+Shift+z",
      handler: () => {
        engineRuntime.sendCommand({
          module: "UndoCommand",
          command: { type: "Redo", data: {} },
        });
      },
      description: "Redo",
    },
    { global: true },
  );
  unregisterGlobalShortcuts = () => {
    unregisterUndoShortcut();
    unregisterRedoShortcut();
  };

  // Store cleanup function
  // eslint-disable-next-line solid/reactivity
  unregisterListeners = () => {
    if (unregisterTinykeys) {
      unregisterTinykeys();
    }
    if (unregisterSequenceCaptureTinykeys) {
      unregisterSequenceCaptureTinykeys();
    }
    window.removeEventListener("keydown", handleKeyDown, { capture: true });
    window.removeEventListener("focus", handleFocus, { capture: true });
    window.removeEventListener("click", handleFocus, { capture: true });
    window.removeEventListener("focusout", handleFocusOut, { capture: true });
  };

  return () => {
    if (rootGeneration === shortcutRootGeneration) {
      cleanupKeyboardShortcutRoot();
    }
  };
}

/**
 * Normalizes shortcut strings into the key names expected by tinykeys.
 */
function normalizeKeyString(keyString: string): string {
  // Handle Space key normalization
  if (keyString === " ") return "Space";

  // tinykeys matches either event.key or event.code. For the backquote key,
  // Shift modifies event.key to "~", so normalize to physical code name.
  return keyString
    .trim()
    .split(" ")
    .map((press) => {
      const parts = press.split(/\b\+/);
      const key = parts[parts.length - 1];
      if (key === "`" || key === "~") {
        parts[parts.length - 1] = "Backquote";
        return parts.join("+");
      }
      return press;
    })
    .join(" ");
}

/**
 * Updates tinykeys listeners based on current shortcuts
 * This function modifies the global keyMap and refreshes tinykeys
 */
function updateKeyListeners() {
  // Clear existing keymap and shortcut tracking
  for (const key of Object.keys(keyMap)) {
    delete keyMap[key];
  }
  for (const key of Object.keys(sequenceCaptureKeyMap)) {
    delete sequenceCaptureKeyMap[key];
  }
  for (const key of Object.keys(shortcutsByKey)) {
    delete shortcutsByKey[key];
  }

  // First, organize shortcuts by key for efficient lookup
  const allShortcuts = shortcuts();
  for (const shortcut of allShortcuts) {
    const normalizedKey = normalizeKeyString(shortcut.key);

    // Create an entry for this key if it doesn't exist
    if (!shortcutsByKey[normalizedKey]) {
      shortcutsByKey[normalizedKey] = [];
    }

    // Add this handler to the key's handler list
    shortcutsByKey[normalizedKey].push({
      componentId: shortcut.componentId,
      handler: shortcut.handler,
      description: shortcut.description,
      allowInEditable: shortcut.allowInEditable,
    });
  }

  /** Creates the shared tinykeys callback for a normalized shortcut key. */
  const createKeyHandler =
    (key: string, markCapturedEvent = false) =>
    (event: KeyboardEvent) => {
      if (captureDispatchedEvents.has(event)) {
        captureDispatchedEvents.delete(event);
        return;
      }

      // Update focused component based on the key event target.
      const eventTarget =
        event.target instanceof HTMLElement ? event.target : null;
      updateFocusedComponent(eventTarget, {
        allowDockFallback: allowsDockFocusFallback(eventTarget),
      });

      // We do not want to trigger bare key shortcuts if we are in an input field
      const activeElement = document.activeElement as HTMLElement | null;
      const shortcutTarget = eventTarget ?? activeElement;
      const activeInDataGrid = isDataGridElement(shortcutTarget);
      if (
        activeInDataGrid &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey &&
        (event.key === "Delete" || event.key === "Backspace")
      ) {
        return;
      }
      const handled = dispatchShortcutForKey(key, event, shortcutTarget);
      if (handled && markCapturedEvent) {
        captureDispatchedEvents.add(event);
      }
    };

  // Now create a single handler for each unique key
  for (const key of Object.keys(shortcutsByKey)) {
    // eslint-disable-next-line solid/reactivity
    keyMap[key] = createKeyHandler(key);
    if (key.includes(" ")) {
      sequenceCaptureKeyMap[key] = createKeyHandler(key, true);
    }
  }

  // Unregister existing tinykeys listeners if they exist
  if (unregisterTinykeys) {
    unregisterTinykeys();
  }
  if (unregisterSequenceCaptureTinykeys) {
    unregisterSequenceCaptureTinykeys();
  }

  // Register all shortcuts with tinykeys
  unregisterTinykeys = tinykeys(window, keyMap, {
    ignore: shouldIgnoreTinykeysEvent,
  });
  unregisterSequenceCaptureTinykeys = tinykeys(window, sequenceCaptureKeyMap, {
    capture: true,
    ignore: shouldIgnoreTinykeysEvent,
  });
}

/**
 * Registers a new keyboard shortcut
 * @param binding The keyboard binding to register
 * @param options Options for the shortcut registration
 * @returns Unregister function
 */
export interface KeyboardShortcutOptions {
  global?: boolean; // If true, shortcut works globally regardless of component context
  overwrite?: boolean; // If true, will overwrite any existing shortcut with the same key
  capture?: boolean; // If true, dispatches from the shared capture-phase listener
  allowInEditable?: boolean; // If true, shortcuts may run from text inputs
}

/**
 * Error thrown when a keyboard shortcut conflicts with an existing shortcut
 */
class ShortcutCollisionError extends Error {
  existingShortcut: KeyboardShortcut;
  newShortcut: KeyboardShortcut;

  constructor(
    existingShortcut: KeyboardShortcut,
    newShortcut: KeyboardShortcut,
  ) {
    const contextMsg = existingShortcut.componentId
      ? `in component "${existingShortcut.componentId}"`
      : "globally";

    super(
      `Keyboard shortcut collision: "${newShortcut.key}" is already registered ${contextMsg} for "${existingShortcut.description}"`,
    );
    this.name = "ShortcutCollisionError";
    this.existingShortcut = existingShortcut;
    this.newShortcut = newShortcut;
  }
}

export function registerKeyboardShortcut(
  binding: KeyboardShortcut,
  options: KeyboardShortcutOptions = {},
): () => void {
  // Make shortcut global if specified
  const shortcutToAdd = options.global
    ? {
        ...binding,
        allowInEditable: options.allowInEditable ?? binding.allowInEditable,
        capture: options.capture ?? binding.capture,
        componentId: undefined,
      }
    : {
        ...binding,
        allowInEditable: options.allowInEditable ?? binding.allowInEditable,
        capture: options.capture ?? binding.capture,
      };

  // Check for collisions before registering
  const existingShortcuts = shortcuts();
  const collision = findCollision(shortcutToAdd, existingShortcuts);

  if (collision) {
    if (options.overwrite) {
      // Remove the existing shortcut if overwrite is enabled
      log.warn(
        `Overwriting existing keyboard shortcut: "${collision.key}" ${collision.componentId ? `in component "${collision.componentId}"` : "globally"} ` +
          `from "${collision.description}" to "${shortcutToAdd.description}"`,
      );
      setShortcuts(
        existingShortcuts.filter(
          (s) =>
            s.key !== collision.key || s.componentId !== collision.componentId,
        ),
      );
    } else {
      throw new ShortcutCollisionError(collision, shortcutToAdd);
    }
  }

  // Add to our store
  setShortcuts([...shortcuts(), shortcutToAdd]);

  // Update tinykeys listeners
  updateKeyListeners();

  // Return function to unregister this shortcut
  // eslint-disable-next-line solid/reactivity
  return () => {
    setShortcuts(
      shortcuts().filter(
        (s) => s.key !== binding.key || s.componentId !== binding.componentId,
      ),
    );
    updateKeyListeners();
  };
}

/**
 * React/SolidJS hook for registering keyboard shortcuts in components
 * @param binding The keyboard binding to register
 * @param options Options for the shortcut registration
 */
export function useKeyboardShortcut(
  binding: KeyboardShortcut,
  options: KeyboardShortcutOptions = {},
) {
  const workspaceActive = useWorkspaceActivity();
  /** Registers shortcuts only while their owning workspace can receive input. */
  createEffect(() => {
    if (!workspaceActive()) return;
    // Register the keyboard shortcut when component mounts
    let unregister: (() => void) | null = null;

    try {
      unregister = untrack(() => registerKeyboardShortcut(binding, options));
    } catch (error) {
      if (error instanceof ShortcutCollisionError) {
        log.error(
          `Failed to register keyboard shortcut in component: ${error.message}\n` +
            "To override this, pass { overwrite: true } in the options.",
        );
        // Re-throw to allow component-level handling if needed
        throw error;
      }
      // For other errors, just re-throw
      throw error;
    }

    // Cleanup function to unregister when component unmounts
    onCleanup(() => {
      if (unregister) {
        unregister();
      }
    });
  });
}

/**
 * Export component focus utilities for use by components
 */
export {
  focusTrackedComponent,
  getFocusedComponentId,
  registerComponentFocus,
  setDockApiGetter,
} from "./componentFocusContext";

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    cleanupKeyboardShortcutRoot();
  });
}
