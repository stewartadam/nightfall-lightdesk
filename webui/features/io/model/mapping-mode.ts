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
export type ArmedSource = (
  | {
      /** MIDI control identified from the last received message. */
      kind: "midi";
      /** Message that armed the source. */
      event: types.MidiLastEvent;
    }
  | ({
      /** OSC address identified from the touch in progress. */
      kind: "osc";
    } & OscGesture)
) & {
  /** Distinct numeric levels the control sent during this touch, oldest first. */
  levels?: number[];
};

/** Most distinct levels remembered per touch: enough to tell a fader from a button. */
const MAX_TOUCH_LEVELS = 4;

/** Returns the levels a touch sent with one more, ignoring repeats. */
function withLevel(
  levels: readonly number[] | undefined,
  level: number | undefined,
): number[] | undefined {
  if (level === undefined || !Number.isFinite(level)) return levels?.slice();
  const known = levels ?? [];
  if (known.includes(level) || known.length >= MAX_TOUCH_LEVELS) {
    return known.slice();
  }
  return [...known, level];
}

/** Returns the numeric level carried by an OSC message's first argument, if any. */
function oscLevel(event: types.OscLastEvent): number | undefined {
  const [arg] = event.args;
  switch (arg?.type) {
    case "Int":
    case "Float":
    case "Double":
      return arg.data;
    case "Long":
      return Number(arg.data);
    default:
      return undefined;
  }
}

/**
 * Returns whether the armed control behaves like a fader rather than a button, judged from
 * what it sent during the touch.
 *
 * MIDI notes are buttons and pitch bends are faders. Otherwise a control is a fader when it
 * sent more than two levels, or a level strictly between off and full (0 and 127 for MIDI,
 * 0 and 1 for OSC), since buttons jump between the two.
 */
export function armedSourceIsContinuous(armed: ArmedSource): boolean {
  if (armed.kind === "midi") {
    if (armed.event.source?.type === "Note") return false;
    if (armed.event.source?.type === "PitchBend") return true;
  }
  const full = armed.kind === "midi" ? 127 : 1;
  const levels = armed.levels ?? [];
  return levels.length > 2 || levels.some((level) => level > 0 && level < full);
}

/** Controller mapping mode state shared by the toolbar, banner, and mappable controls. */
export interface MappingModeState {
  /** Whether clicks on mappable controls bind actions instead of operating them. */
  active: boolean;
  /** Control that the next click binds, once one has been touched. */
  armed?: ArmedSource;
  /**
   * Show generation the backend reported while this client was mapping. A different
   * generation means a show load ended this client's mapping mode.
   */
  showGeneration?: string;
  /** Why the last touched MIDI message could not arm, until a control arms. */
  unmappable?: string;
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

/**
 * Records the backend's show generation while mapping, and leaves mapping mode when it
 * changed since this client entered, because a show load ended the backend's hold.
 *
 * Returns whether mapping mode was left. An empty generation means the backend has not
 * reported one yet and is ignored.
 */
export function observeShowGeneration(generation: string): boolean {
  const state = $mappingMode.get();
  if (!state.active || !generation) return false;
  if (state.showGeneration === undefined) {
    $mappingMode.set({ ...state, showGeneration: generation });
    return false;
  }
  if (state.showGeneration === generation) return false;
  exitMappingMode();
  return true;
}

/** Toggles mapping mode on or off. */
export function toggleMappingMode(): void {
  if ($mappingMode.get().active) {
    exitMappingMode();
  } else {
    enterMappingMode();
  }
}

/**
 * How often this client renews its mapping mode hold.
 *
 * The backend ends a hold that is not renewed within 15 seconds, so an unresponsive window
 * never leaves controllers paused; renewing every 5 seconds tolerates a missed renewal.
 */
export const MAPPING_MODE_RENEW_INTERVAL_MS = 5000;

/** Failure code the backend returns when renewing a hold it already ended. */
export const MAPPING_MODE_ENDED_CODE = "action.mapping_mode_ended";

/** Mapping mode change this client asks the backend to apply to its own hold. */
export type MappingModeRequest = "enter" | "renew" | "leave";

/**
 * Builds the backend command that enters, renews, or leaves controller mapping mode.
 *
 * The backend pauses MIDI and OSC actions while any client holds mapping mode. A hold ends
 * when this client leaves, disconnects, stops renewing, or a show is loaded. Entering again
 * is harmless, so the command is re-sent after reconnecting.
 */
export function mappingModeCommand(request: MappingModeRequest): {
  module: "ActionCommand";
  command: types.ActionCommand;
} {
  const type = {
    enter: "EnterControllerMappingMode",
    renew: "RenewControllerMappingMode",
    leave: "LeaveControllerMappingMode",
  } as const;
  return { module: "ActionCommand", command: { type: type[request] } };
}

/**
 * Describes why controller actions are paused, or `undefined` when they are not.
 *
 * `mappingClients` counts every client in mapping mode, including this one once the backend
 * confirms it, so the text names only the other clients. Until the backend confirms, this
 * client's touches neither arm nor pause, which the text says.
 */
export function describeMappingPause(
  mappingClients: number,
  localActive: boolean,
): string | undefined {
  const others = mappingClients - (localActive ? 1 : 0);
  if (localActive) {
    if (mappingClients <= 0) return "Pausing MIDI and OSC actions…";
    if (others <= 0) return "MIDI and OSC actions are paused.";
    return `MIDI and OSC actions are paused; ${others} other ${others === 1 ? "client is" : "clients are"} also mapping.`;
  }
  if (mappingClients <= 0) return undefined;
  return `Controller actions paused while ${mappingClients} ${mappingClients === 1 ? "client is" : "clients are"} mapping MIDI and OSC controls.`;
}

/** Records a MIDI control that the next mappable click binds, when mapping mode is active. */
export function armMidiSource(event: types.MidiLastEvent): void {
  const state = $mappingMode.get();
  const armed: ArmedSource = { kind: "midi", event };
  if (!state.active || isJustBound(armed)) return;
  const sameControl =
    state.armed?.kind === "midi" && sourceKey(state.armed) === sourceKey(armed);
  armed.levels = withLevel(
    sameControl ? state.armed?.levels : undefined,
    event.velocity,
  );
  $mappingMode.set({ ...withoutUnmappable(state), armed });
}

/** Returns mapping state without an unmappable-message notice, once a control armed. */
function withoutUnmappable(state: MappingModeState): MappingModeState {
  const { unmappable, ...rest } = state;
  return rest;
}

/** MIDI channel message kinds that cannot drive actions, by status nibble. */
const UNMAPPABLE_MIDI_KINDS: Record<number, string> = {
  160: "polyphonic aftertouch",
  192: "program change",
  208: "channel pressure",
};

/**
 * Explains why a touched MIDI message cannot be mapped, naming what was sent.
 *
 * Only notes, controllers, and pitch bends drive actions.
 */
export function describeUnmappableMidi(event: types.MidiLastEvent): string {
  const kind = UNMAPPABLE_MIDI_KINDS[event.channel & 0xf0] ?? "message";
  const channel = (event.channel & 0x0f) + 1;
  return `${event.device} sent a MIDI ${kind} on channel ${channel}, which can't be mapped. Move a key, pad, fader, or knob instead.`;
}

/**
 * Notes that a touched MIDI message cannot be mapped, unless a control is already armed.
 *
 * Keeping an armed control means stray aftertouch while pressing a pad does not replace it.
 */
function noteUnmappableMidi(event: types.MidiLastEvent): void {
  const state = $mappingMode.get();
  if (!state.active || state.armed) return;
  $mappingMode.set({ ...state, unmappable: describeUnmappableMidi(event) });
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
  const sameControl = current?.event.address === event.address;
  $mappingMode.set({
    ...withoutUnmappable(state),
    armed: {
      kind: "osc",
      ...trackOscGesture(current, event),
      levels: withLevel(
        sameControl ? current?.levels : undefined,
        oscLevel(event),
      ),
    },
  });
}

/**
 * Arms from one frame of MIDI controls the backend reported touched in mapping mode.
 *
 * Touches arrive reliably and in order, so the last mappable control touched wins. Messages
 * without a mappable source, such as program changes, explain why nothing armed.
 */
export function armMidiTouches(events: readonly types.MidiLastEvent[]): void {
  for (const event of events) {
    if (event.source) {
      armMidiSource(event);
    } else {
      noteUnmappableMidi(event);
    }
  }
}

/**
 * Folds one frame of OSC messages the backend reported in mapping mode into the armed touch.
 *
 * Messages are applied in order, so a press and its release in the same frame still record
 * both values of the gesture.
 */
export function armOscTouches(events: readonly types.OscLastEvent[]): void {
  for (const event of events) armOscSource(event);
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
  const { armed, ...unarmed } = state;
  if (armed) lastBound = { key: sourceKey(armed), at: Date.now() };
  $mappingMode.set(unarmed);
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
