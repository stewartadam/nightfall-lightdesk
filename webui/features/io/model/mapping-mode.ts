// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { atom } from "nanostores";
import type * as types from "../../../types";
import {
  type OscGesture,
  trackOscGesture,
} from "./controller-mapping-builders";

/** A hardware or network control captured while mapping mode waits for a UI target. */
export type ArmedSource =
  | {
      /** MIDI control identified from the last received message. */
      kind: "midi";
      /** Message that armed the source. */
      event: types.MidiLastEvent;
    }
  | ({
      /** OSC address identified from the touch in progress. */
      kind: "osc";
    } & OscGesture);

/** Controller mapping mode state shared by the toolbar, banner, and mappable controls. */
export interface MappingModeState {
  /** Whether clicks on mappable controls bind actions instead of operating them. */
  active: boolean;
  /** Control that the next click binds, once one has been touched. */
  armed?: ArmedSource;
}

/** Current controller mapping mode state. */
export const $mappingMode = atom<MappingModeState>({ active: false });

/** How long messages from a just-bound control are ignored, so its release does not re-arm it. */
const REARM_DELAY_MS = 1000;

/** The control most recently bound and when, used to ignore its trailing messages. */
let lastBound: { key: string; at: number } | undefined;

/** Enters mapping mode and waits for the next control to be touched. */
export function enterMappingMode(): void {
  lastBound = undefined;
  $mappingMode.set({ active: true });
}

/** Leaves mapping mode, restoring normal control behavior. */
export function exitMappingMode(): void {
  $mappingMode.set({ active: false });
}

/** Toggles mapping mode on or off. */
export function toggleMappingMode(): void {
  if ($mappingMode.get().active) {
    exitMappingMode();
  } else {
    enterMappingMode();
  }
}

/** Records a MIDI control that the next mappable click binds, when mapping mode is active. */
export function armMidiSource(event: types.MidiLastEvent): void {
  const state = $mappingMode.get();
  const armed: ArmedSource = { kind: "midi", event };
  if (!state.active || isJustBound(armed)) return;
  $mappingMode.set({ ...state, armed });
}

/**
 * Folds an OSC message into the armed touch, when mapping mode is active.
 *
 * Messages on the armed address extend the touch with its release value; other addresses
 * arm a new control.
 */
export function armOscSource(event: types.OscLastEvent): void {
  const state = $mappingMode.get();
  if (!state.active || isJustBound({ kind: "osc", event })) return;
  const current = state.armed?.kind === "osc" ? state.armed : undefined;
  $mappingMode.set({
    ...state,
    armed: { kind: "osc", ...trackOscGesture(current, event) },
  });
}

/** Identifies the physical control behind an armed source. */
function sourceKey(source: ArmedSource): string {
  return source.kind === "osc"
    ? `osc:${source.event.address}`
    : `midi:${source.event.device}:${JSON.stringify(source.event.source)}`;
}

/** Returns whether a source is the control just bound, still sending its trailing messages. */
function isJustBound(source: ArmedSource): boolean {
  return (
    lastBound !== undefined &&
    lastBound.key === sourceKey(source) &&
    Date.now() - lastBound.at < REARM_DELAY_MS
  );
}

/**
 * Clears the armed control after it was bound, keeping mapping mode active.
 *
 * Messages from the same control are ignored briefly, so the release that follows a touch
 * does not arm it again.
 */
export function disarmMappingSource(): void {
  const state = $mappingMode.get();
  if (state.armed) lastBound = { key: sourceKey(state.armed), at: Date.now() };
  $mappingMode.set({ active: state.active });
}

/** Describes an armed source for status text. */
export function describeArmedSource(
  source: ArmedSource,
  describeMidi: (source: types.MidiSource) => string,
): string {
  if (source.kind === "osc") {
    return `OSC ${source.event.address}`;
  }
  const control = source.event.source
    ? describeMidi(source.event.source)
    : `status ${source.event.channel}`;
  return `MIDI ${control} (${source.event.device})`;
}
