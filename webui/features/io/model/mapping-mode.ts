// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { atom } from "nanostores";
import type * as types from "../../../types";

/** A hardware or network control captured while mapping mode waits for a UI target. */
export type ArmedSource =
  | {
      /** MIDI control identified from the last received message. */
      kind: "midi";
      /** Message that armed the source. */
      event: types.MidiLastEvent;
    }
  | {
      /** OSC address identified from the last received message. */
      kind: "osc";
      /** Message that armed the source. */
      event: types.OscLastEvent;
    };

/** Controller mapping mode state shared by the toolbar, banner, and mappable controls. */
export interface MappingModeState {
  /** Whether clicks on mappable controls bind actions instead of operating them. */
  active: boolean;
  /** Control that the next click binds, once one has been touched. */
  armed?: ArmedSource;
}

/** Current controller mapping mode state. */
export const $mappingMode = atom<MappingModeState>({ active: false });

/** Enters mapping mode and waits for the next control to be touched. */
export function enterMappingMode(): void {
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

/** Records the control that the next mappable click binds, when mapping mode is active. */
export function armSource(source: ArmedSource): void {
  const state = $mappingMode.get();
  if (!state.active) return;
  $mappingMode.set({ active: true, armed: source });
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
