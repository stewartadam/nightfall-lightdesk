// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { InfoIcon } from "@squidlab/phosphor-solid/info";
import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { matchKeybindingPress, parseKeybinding } from "tinykeys";
import { getWebSocketUrl } from "../../../lib/api";
import {
  connectionStatus,
  EngineRuntimeStatus,
} from "../../../lib/engine-runtime";
import { allShortcuts } from "../../../lib/keyboardShortcuts";
import { getLogger } from "../../../lib/logger";
import { appLifecycle } from "../../../state/app-lifecycle";
import { DialogBackdrop, DialogSurface } from "../../ui/dialog";
import Tooltip from "../../ui/tooltip";
import { shouldBlockDisconnectedOverlayKey } from "./key-filter";

const log = getLogger(import.meta.url);

/** Returns whether a keyboard event matches a registered app shortcut. */
function hasMatchingAppShortcut(event: KeyboardEvent): boolean {
  const shortcuts = allShortcuts();
  return shortcuts.some((shortcut) => {
    const keybinding = parseKeybinding(shortcut.key)[0];
    return keybinding && matchKeybindingPress(event, keybinding);
  });
}

/** Returns whether connection overlay UI should be hidden for integration tests. */
function isOverlaySuppressedForE2E(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  const params = new URLSearchParams(window.location.search);
  return params.get("e2e") === "1";
}

/** Blocks disconnected interactive sessions while startup owns its own connection UI. */
const ConnectionOverlay = () => {
  if (isOverlaySuppressedForE2E()) {
    return null;
  }

  onMount(() => {
    log.trace("mounting");
  });
  const lifecycle = useStore(appLifecycle);
  const initialConnected = connectionStatus() === EngineRuntimeStatus.Connected;
  const initiallyBlocked =
    lifecycle().phase === "interactive" && !initialConnected;
  const [isPopupVisible, setIsPopupVisible] = createSignal(initiallyBlocked);
  const [isConnected, setIsConnected] = createSignal(initialConnected);
  const [hasStateChanged, setHasStateChanged] = createSignal(false); // to avoid CSS transitions on initial load
  const [hasPresentedDisconnect, setHasPresentedDisconnect] =
    createSignal(initiallyBlocked);
  const showDelay = 1000; // how long to wait while disconnected before showing popup
  const animationLength = 500; // how long to fade in/out
  const hideDelay = 1000; // how long to show success message for
  /** Describes the endpoint using the same URL resolver as the connection. */
  const expectedBackendTooltip = createMemo(
    () => `Connecting to ${getWebSocketUrl()}`,
  );
  let showOverlayTimeoutId: number | undefined;
  let hideOverlayTimeoutId: number | undefined;

  /** Clear overlay state for websocket transitions that happen during startup. */
  const suppressStartupTransition = (connected: boolean) => {
    clearTimeout(showOverlayTimeoutId);
    clearTimeout(hideOverlayTimeoutId);
    setIsConnected(connected);
    setHasPresentedDisconnect(false);
    setIsPopupVisible(false);
  };

  /** Shows connection loss once startup has handed control to the interactive session. */
  const handleDisconnected = () => {
    // Don't hide the overlay if we disconnected again before it had a chance to trigger
    clearTimeout(hideOverlayTimeoutId);

    // Show the overlay after a small delay
    showOverlayTimeoutId = window.setTimeout(() => {
      setHasStateChanged(true);
      setHasPresentedDisconnect(true);
      setIsPopupVisible(true);
    }, showDelay);
  };

  /** Hide the overlay after showing recovery only when a disconnect was presented. */
  const handleReconnected = () => {
    // Don't show the overlay if we re-connected before it had a chance to appear
    clearTimeout(showOverlayTimeoutId);

    if (!hasPresentedDisconnect()) {
      setIsPopupVisible(false);
      return;
    }

    // Hide the overlay after a small delay to allow the connection message to appear
    setHasStateChanged(true);
    hideOverlayTimeoutId = window.setTimeout(() => {
      setIsPopupVisible(false);
      setHasPresentedDisconnect(false);
    }, hideDelay + animationLength);
  };

  /** Sync overlay presentation with websocket status after startup mode ends. */
  createEffect(() => {
    const status = connectionStatus();
    const connected = status === EngineRuntimeStatus.Connected;
    const startupActive = lifecycle().phase !== "interactive";

    if (startupActive) {
      suppressStartupTransition(connected);
      return;
    }

    setIsConnected(connected);
    if (connected) {
      handleReconnected();
    } else {
      handleDisconnected();
    }
  });

  // Block keyboard events that would interact with the page, but allow browser shortcuts
  createEffect(() => {
    const blockKeyboard = (e: KeyboardEvent) => {
      if (!shouldBlockDisconnectedOverlayKey(e, hasMatchingAppShortcut)) return;

      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    };

    if (isPopupVisible()) {
      // Capture phase to intercept before other handlers
      document.addEventListener("keydown", blockKeyboard, true);
      document.addEventListener("keyup", blockKeyboard, true);
      document.addEventListener("keypress", blockKeyboard, true);

      onCleanup(() => {
        document.removeEventListener("keydown", blockKeyboard, true);
        document.removeEventListener("keyup", blockKeyboard, true);
        document.removeEventListener("keypress", blockKeyboard, true);
      });
    }
  });

  // Clean up timeouts on unmount
  onCleanup(() => {
    log.trace("unmounting");
    clearTimeout(showOverlayTimeoutId);
    clearTimeout(hideOverlayTimeoutId);
  });

  return (
    <Show when={isPopupVisible()}>
      {/* overlay with background blur */}
      <DialogBackdrop
        class={`pointer-events-auto ${
          hasStateChanged()
            ? "data-[state=show]:animate-in fade-in data-[state=hide]:animate-out fade-out data-[state=hide]:delay-[var(--out-delay)] fill-mode-both"
            : ""
        }`}
        style={{
          "--tw-duration": `${animationLength}ms`,
          "--out-delay": `${hideDelay}ms`,
        }}
        data-overlay-kind="connection"
        data-state={isConnected() ? "hide" : "show"}
        onKeyDown={(e) => {
          if (shouldBlockDisconnectedOverlayKey(e, hasMatchingAppShortcut))
            e.preventDefault();
        }}
        onKeyUp={(e) => {
          if (shouldBlockDisconnectedOverlayKey(e, hasMatchingAppShortcut))
            e.preventDefault();
        }}
        onKeyPress={(e) => {
          if (shouldBlockDisconnectedOverlayKey(e, hasMatchingAppShortcut))
            e.preventDefault();
        }}
        tabIndex={-1}
      >
        {/* card */}
        <DialogSurface
          class="max-w-md p-6"
          role="dialog"
          aria-modal="true"
          aria-label={isConnected() ? "Connected" : "Connection Lost"}
        >
          {/* card content */}
          <div class="flex flex-col items-center space-y-4">
            <Show when={isConnected()}>
              <div class="text-2xl font-semibold flex items-center">
                {/* connected icon */}
                <svg
                  class="w-8 h-8 mr-2 text-green-300"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                  <polyline points="22 4 12 14.01 9 11.01" />
                </svg>
                Connected
              </div>
              <div class="text-gray-100 text-center">
                Connection to engine restored
              </div>
            </Show>

            <Show when={!isConnected()}>
              <div class="flex items-center gap-2 text-2xl font-semibold">
                <span>Connection Lost</span>
                <Tooltip content={expectedBackendTooltip} position="right">
                  <button
                    type="button"
                    class="inline-flex items-center justify-center rounded-full text-gray-300 transition-colors hover:text-white focus:outline-hidden focus:ring-2 focus:ring-gray-400"
                    aria-label="Show connection address"
                  >
                    <InfoIcon class="size-5" aria-hidden />
                  </button>
                </Tooltip>
              </div>
              <div class="text-gray-300 text-center">
                Attempting to re-establish connection to nightfall session.
              </div>
              <div
                class="flex h-10 w-7 items-center justify-between"
                aria-hidden="true"
              >
                <span class="startup-status-dot" />
                <span class="startup-status-dot" />
                <span class="startup-status-dot" />
              </div>
            </Show>
          </div>
        </DialogSurface>
      </DialogBackdrop>
    </Show>
  );
};

export default ConnectionOverlay;
