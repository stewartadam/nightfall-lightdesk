// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { debounce } from "@solid-primitives/scheduled";
import {
  type Accessor,
  createEffect,
  createSignal,
  on,
  onCleanup,
  untrack,
} from "solid-js";
import { commandClient } from "../../../lib/engine-commands";
import { getLogger } from "../../../lib/logger";
import { showTempo } from "../../../state/appStores";
import type { TempoCommand, TempoSnapshot } from "../../../types";
import {
  beatInBar,
  extrapolateBeatPosition,
  FIELD_COMMIT_DELAY_MS,
} from "../model";

const log = getLogger(import.meta.url);

/** Sends one command to the show tempo engine. */
export function sendTempoCommand(command: TempoCommand) {
  log.debug("Sending tempo command", { command });
  commandClient.emit("TempoCommand", command);
}

/**
 * Sends one tap stamped with the input event's own time, so the engine fits the
 * tempo on this device's clock and neither network delay nor engine frame timing
 * skews the spacing between taps.
 */
export function sendTap(event: Event) {
  sendTempoCommand({ type: "Tap", data: event.timeStamp });
}

/**
 * Tracks the zero-based beat within the current bar, re-derived from the last
 * engine snapshot on every animation frame so the indicator moves smoothly
 * between engine messages. Stops animating while no tempo has been received.
 */
export function createBeatInBar(): Accessor<number> {
  const tempo = useStore(showTempo);
  const [beat, setBeat] = createSignal(0);

  /** Re-derives the current beat each animation frame while tempo data exists. */
  createEffect(() => {
    const state = tempo();
    if (!state) return;
    let frame = 0;
    const tick = () => {
      const position = extrapolateBeatPosition(
        state.snapshot,
        state.receivedAtMs,
        performance.now(),
      );
      setBeat(beatInBar(state.snapshot, position));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    onCleanup(() => cancelAnimationFrame(frame));
  });

  return beat;
}

/** What a tempo field reads from the engine and how it applies an edit. */
interface TempoFieldOptions {
  /** Formats the engine's current value for the field. */
  read: (snapshot: TempoSnapshot) => string;
  /**
   * Sends the drafted value and returns `true`, or returns `false` without
   * sending when it is out of range or partly typed.
   */
  apply: (draft: string) => boolean;
}

/** A tempo field's draft text and the handlers that keep it in step with the engine. */
export interface TempoField {
  /** Text the field shows. */
  draft: Accessor<string>;
  /** Records an edit and applies it once the operator pauses. */
  change: (value: string) => void;
  /** Applies the pending edit straight away, such as on Enter. */
  commit: () => void;
  /** Applies the pending edit and shows the engine's value again. */
  blur: () => void;
}

/**
 * Creates the draft for one editable tempo value. The draft follows the engine
 * except while it holds an edit the engine has not received yet: one waiting
 * for the operator to pause, or a partly typed value such as the "1" of "128".
 * Incoming tempo updates therefore never overwrite what the operator types or
 * steps to, and the field shows taps and tempo commands as soon as it is idle.
 */
export function createTempoField(options: TempoFieldOptions): TempoField {
  const tempo = useStore(showTempo);
  const [draft, setDraft] = createSignal("");
  let unapplied = false;

  /** Copies the engine's value into the draft unless it holds an unapplied edit. */
  const follow = () => {
    const value = untrack(engineValue);
    if (value !== undefined && !unapplied) setDraft(value);
  };

  /** Formats the engine's current value, tracking only the fields it reads. */
  const engineValue = () => {
    const state = tempo();
    return state ? options.read(state.snapshot) : undefined;
  };

  /** Shows the engine's value whenever it changes. */
  createEffect(on(engineValue, follow));

  /** Applies the drafted value now, keeping it held if the engine would reject it. */
  const commit = () => {
    schedule.clear();
    if (unapplied) unapplied = !options.apply(draft());
  };
  /** Applies the draft once the operator pauses editing. */
  const schedule = debounce(commit, FIELD_COMMIT_DELAY_MS);

  return {
    draft,
    /** Stores an edit and holds the draft until it is applied. */
    change: (value) => {
      setDraft(value);
      unapplied = true;
      schedule();
    },
    commit,
    /**
     * Applies a valid pending edit, or swaps an unusable one for the engine's value. A sent
     * edit stays in the field until the engine echoes it, so a stepper press that blurs the
     * field steps from the typed value rather than the old one.
     */
    blur: () => {
      commit();
      if (!unapplied) return;
      unapplied = false;
      follow();
    },
  };
}
