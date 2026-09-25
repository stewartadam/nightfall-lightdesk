// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { atom } from "nanostores";
import * as types from "../../../types";
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
  /** Edge of the armed control that the next click binds. */
  edge: types.SourceEdge;
}

/** Current controller mapping mode state. */
export const $mappingMode = atom<MappingModeState>({
  active: false,
  edge: types.SourceEdge.Press,
});

/** Enters mapping mode and waits for the next control to be touched. */
export function enterMappingMode(): void {
  $mappingMode.set({ active: true, edge: types.SourceEdge.Press });
}

/** Leaves mapping mode, restoring normal control behavior. */
export function exitMappingMode(): void {
  $mappingMode.set({ active: false, edge: types.SourceEdge.Press });
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
  if (!state.active) return;
  $mappingMode.set({ ...state, armed: { kind: "midi", event } });
}

/**
 * Folds an OSC message into the armed touch, when mapping mode is active.
 *
 * Messages on the armed address extend the touch with its release value; other addresses
 * arm a new control.
 */
export function armOscSource(event: types.OscLastEvent): void {
  const state = $mappingMode.get();
  if (!state.active) return;
  const current = state.armed?.kind === "osc" ? state.armed : undefined;
  $mappingMode.set({
    ...state,
    armed: { kind: "osc", ...trackOscGesture(current, event) },
  });
}

/** Chooses which edge of the armed control the next mappable click binds. */
export function setMappingEdge(edge: types.SourceEdge): void {
  $mappingMode.set({ ...$mappingMode.get(), edge });
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
