// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  type Accessor,
  createEffect,
  onCleanup,
  onMount,
  type Setter,
} from "solid-js";
import {
  isAsciiTapKey,
  isClearTapKey,
  isEditableKeyTarget,
  isModifierOnlyKey,
} from "../model/panel-model";

interface TapPatternKeyboardOptions {
  clearTaps: () => void;
  focusTapsTimeline: () => void;
  isCaptureArmed: Accessor<boolean>;
  isPanelKeyboardActive: Accessor<boolean>;
  panelElement: () => HTMLDivElement | undefined;
  recordTap: (key?: string) => void;
  setIsCaptureArmed: Setter<boolean>;
  setIsPanelKeyboardActive: Setter<boolean>;
  timelineElement: () => HTMLButtonElement | undefined;
}

/** Owns document-level focus and key routing for one mounted tap-pattern panel. */
export function useTapPatternKeyboard(options: TapPatternKeyboardOptions) {
  /** Gives the panel a keyboard capture context after its opener event. */
  onMount(() => {
    const activationTimer = window.setTimeout(() => {
      options.setIsPanelKeyboardActive(true);
      options.timelineElement()?.focus();
    }, 0);
    onCleanup(() => window.clearTimeout(activationTimer));
  });

  /** Keeps the taps timeline active whenever capture is armed. */
  createEffect(() => {
    if (options.isCaptureArmed()) {
      options.focusTapsTimeline();
    }
  });

  /** Deactivates capture when pointer interaction moves outside the panel. */
  createEffect(() => {
    const handleDocumentPointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        (options.panelElement()?.contains(event.target) ?? false)
      ) {
        return;
      }
      options.setIsPanelKeyboardActive(false);
    };
    document.addEventListener("pointerdown", handleDocumentPointerDown, true);
    onCleanup(() =>
      document.removeEventListener(
        "pointerdown",
        handleDocumentPointerDown,
        true,
      ),
    );
  });

  /** Registers document-level key tapping while this panel is mounted. */
  createEffect(() => {
    const handleDocumentKeyDown = (event: KeyboardEvent) => {
      /** Claims shortcuts that belong to the active tap panel. */
      const consumePanelKey = () => {
        event.preventDefault();
        event.stopPropagation();
      };
      const isTargetInsidePanel =
        event.target instanceof Node &&
        (options.panelElement()?.contains(event.target) ?? false);
      if (
        event.repeat ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        !options.isPanelKeyboardActive() ||
        !isTargetInsidePanel ||
        isEditableKeyTarget(event.target)
      ) {
        return;
      }
      if (isClearTapKey(event.key)) {
        consumePanelKey();
        options.clearTaps();
        return;
      }
      if (event.key === "Enter") {
        consumePanelKey();
        options.setIsCaptureArmed(true);
        return;
      }
      if (event.key === "Escape" && options.isCaptureArmed()) {
        consumePanelKey();
        options.setIsCaptureArmed(false);
        return;
      }
      if (
        !options.isCaptureArmed() ||
        isModifierOnlyKey(event.key) ||
        !isAsciiTapKey(event.key)
      ) {
        return;
      }
      consumePanelKey();
      options.recordTap(event.key);
    };
    window.addEventListener("keydown", handleDocumentKeyDown, true);
    onCleanup(() =>
      window.removeEventListener("keydown", handleDocumentKeyDown, true),
    );
  });
}
