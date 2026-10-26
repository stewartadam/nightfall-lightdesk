// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { bestEffortPersistentAtom } from "../lib/best-effort-persistent-atom";
import { getLogger } from "../lib/logger";
import { setStoreAction } from "../lib/nanostore-action";

const log = getLogger(import.meta.url);

/**
 * Prompts that offer "Don't show this again". Each id names one kind of prompt, so turning it
 * off hides every later prompt of that kind, whatever it is about.
 */
const DISMISSABLE_PROMPTS = ["midi-device-detected"] as const;

/** One kind of prompt that offers "Don't show this again". */
export type DismissablePromptId = (typeof DISMISSABLE_PROMPTS)[number];

/** Returns whether `value` names a prompt this build offers "Don't show this again" on. */
function isDismissablePromptId(value: unknown): value is DismissablePromptId {
  return (DISMISSABLE_PROMPTS as readonly unknown[]).includes(value);
}

/** Reads stored ids, keeping only prompts this build knows so stale ids never count as hidden. */
function decodeDismissedPrompts(value: string): readonly DismissablePromptId[] {
  try {
    const stored: unknown = JSON.parse(value);
    return Array.isArray(stored) ? stored.filter(isDismissablePromptId) : [];
  } catch {
    return [];
  }
}

/**
 * The prompts the operator turned off on this device. Kept per device, like other presentation
 * preferences, so one operator's choice does not hide prompts on another screen. A choice still
 * applies in memory when storage refuses to save it.
 */
export const dismissedPrompts = bestEffortPersistentAtom<
  readonly DismissablePromptId[]
>("nightfall-dismissed-prompts", [], {
  decode: decodeDismissedPrompts,
  encode: JSON.stringify,
  onSetError: (error) =>
    log.warn("Could not save which prompts are hidden", { error }),
});

/** Returns whether the operator turned off the `id` prompt on this device. */
export function isPromptDismissed(id: DismissablePromptId): boolean {
  return dismissedPrompts.get().includes(id);
}

/**
 * Turns the `id` prompt off when `dismissed`, or back on otherwise. Later prompts of that kind
 * are not shown while it is off; one already showing stays until it closes.
 */
export function setPromptDismissed(
  id: DismissablePromptId,
  dismissed: boolean,
): void {
  const others = dismissedPrompts.get().filter((entry) => entry !== id);
  setStoreAction(
    dismissedPrompts,
    dismissed ? "Dismiss Prompt" : "Restore Prompt",
    dismissed ? [...others, id] : others,
  );
}

/** Shows every prompt the operator turned off again. */
export function resetDismissedPrompts(): void {
  setStoreAction(dismissedPrompts, "Reset Dismissed Prompts", []);
}
