// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  cieChromaticityToFullBrightnessRgb,
  rgbToCieChromaticity,
  rgbToHex,
} from "../../../lib/color-path-preview";
import * as types from "../../../types";

/** Channel resolutions the editor offers, in bytes per value. */
export const RESOLUTIONS = [1, 2, 3, 4] as const;

/** Names a resolution the way fixture manuals do, e.g. "16-bit". */
export function resolutionLabel(bytes: number): string {
  return `${bytes * 8}-bit`;
}

/** Highest DMX value a channel of `bytes` bytes can output. */
export function maxDmxValue(bytes: number): number {
  return 2 ** (8 * bytes) - 1;
}

/** Shows a channel's DMX addresses, e.g. "3" or "3–4", or "Virtual" when it has none. */
export function addressLabel(offset: readonly number[]): string {
  if (offset.length === 0) return "Virtual";
  const first = Math.min(...offset);
  const last = Math.max(...offset);
  return first === last ? String(first) : `${first}–${last}`;
}

/** One function of a channel with the index edits address it by. */
export interface IndexedFunction {
  /** Position counted across all of the channel's logical channels. */
  index: number;
  function: types.DraftFunction;
}

/**
 * Lists a channel's functions in file order. Function edits count functions
 * across every logical channel, so the index here is the one to send.
 */
export function channelFunctions(
  channel: types.DraftChannel,
): IndexedFunction[] {
  return channel.logical_channels
    .flatMap((logical) => logical.functions)
    .map((entry, index) => ({ index, function: entry }));
}

/** Finds a function in a draft by the mode, channel and function positions edits address it by. */
export function functionAt(
  draft: types.FixtureDraftView,
  mode: number,
  channel: number,
  index: number,
): types.DraftFunction | undefined {
  const entry = draft.modes[mode]?.channels[channel];
  return entry ? channelFunctions(entry)[index]?.function : undefined;
}

/** Returns a channel's attributes, one per logical channel, for its table row. */
export function channelAttributes(channel: types.DraftChannel): string {
  return channel.logical_channels
    .map((logical) => logical.attribute)
    .join(", ");
}

/** Problems reported for one mode, or for one channel of it. */
export function problemsAt(
  problems: readonly types.DraftProblem[],
  mode: number,
  channel?: number,
): types.DraftProblem[] {
  return problems.filter(
    (problem) =>
      problem.mode === mode &&
      (channel === undefined || problem.channel === channel),
  );
}

/**
 * Names where a problem is, such as "Mode 1 › Dimmer", or none for a
 * problem with the whole fixture. Falls back to positions when the draft
 * has changed since the problem was found.
 */
export function problemLocation(
  draft: types.FixtureDraftView,
  problem: types.DraftProblem,
): string | undefined {
  if (problem.mode === undefined) return undefined;
  const mode = draft.modes[problem.mode];
  const modeName = mode?.name ?? `Mode ${problem.mode + 1}`;
  if (problem.channel === undefined) return modeName;
  const channelName =
    mode?.channels[problem.channel]?.name ?? `Channel ${problem.channel + 1}`;
  return `${modeName} › ${channelName}`;
}

/**
 * Builds the names after a rename: a short or long name still equal to the
 * old name, or empty, takes the new name too, so names the user never set
 * apart stay linked.
 */
export function renamedInfo(
  info: types.DraftInfo,
  name: string,
): types.DraftInfo {
  /** Whether a name was never given a value of its own. */
  const linked = (value: string) => value === "" || value === info.name;
  return {
    ...info,
    name,
    short_name: linked(info.short_name) ? name : info.short_name,
    long_name: linked(info.long_name) ? name : info.long_name,
  };
}

/** Whether a draft has a problem that blocks saving it. */
export function hasErrors(draft: types.FixtureDraftView): boolean {
  return draft.problems.some(
    (problem) => problem.severity === types.ProblemSeverity.Error,
  );
}

/** Builds the editable fields of a function from its current view. */
export function functionFields(
  entry: types.DraftFunction,
): types.DraftFunctionFields {
  return {
    name: entry.name,
    attribute: entry.attribute,
    dmx_from: entry.dmx_from,
    default: entry.default,
    physical_from: entry.physical_from,
    physical_to: entry.physical_to,
    wheel: entry.wheel,
  };
}

/** Builds the editable fields of a function's named ranges from its current view. */
export function setFields(entry: types.DraftFunction): types.DraftSetFields[] {
  return entry.sets.map((set) => ({
    name: set.name,
    dmx_from: set.dmx_from,
    wheel_slot: set.wheel_slot,
  }));
}

/**
 * Builds the editable fields of a wheel's slots. Each slot names itself as
 * the slot it keeps, so its color, filter and image stay; only `changed`
 * gets a new color.
 */
export function slotFields(
  wheel: types.DraftWheel,
  changed?: { index: number; color: [number, number, number] },
): types.DraftSlotFields[] {
  return wheel.slots.map((slot, index) => ({
    name: slot.name,
    from: index,
    color: index === changed?.index ? changed.color : undefined,
  }));
}

/** Builds a wheel's slots with one removed; the others keep their own optics as they move up. */
export function slotFieldsWithout(
  wheel: types.DraftWheel,
  removed: number,
): types.DraftSlotFields[] {
  return slotFields(wheel).filter((_, index) => index !== removed);
}

/** Luminance a slot color gets when its old one is unknown: a fully open filter. */
const DEFAULT_SLOT_LUMINANCE = 100;

/** Shows a slot's CIE color as a CSS hex color at full brightness, or none for a filter slot. */
export function slotHex(
  color: readonly number[] | undefined,
): string | undefined {
  if (!color || color.length < 2) return undefined;
  return rgbToHex(
    cieChromaticityToFullBrightnessRgb({ x: color[0] ?? 0, y: color[1] ?? 0 }),
  );
}

/**
 * Converts a picked CSS hex color into the CIE x, y and Y a slot stores,
 * keeping the slot's luminance since a color swatch carries no brightness.
 */
export function hexToSlotColor(
  hex: string,
  previous?: readonly number[],
): [number, number, number] {
  const value = Number.parseInt(hex.replace("#", ""), 16);
  const chromaticity = rgbToCieChromaticity({
    red: ((value >> 16) & 0xff) / 255,
    green: ((value >> 8) & 0xff) / 255,
    blue: (value & 0xff) / 255,
  });
  return [
    chromaticity.x,
    chromaticity.y,
    previous?.[2] ?? DEFAULT_SLOT_LUMINANCE,
  ];
}

/**
 * Picks where a new function or range starts: halfway into the space after
 * the last existing start, or `first` when there is none. Returns none when
 * no value is left above the last start.
 */
export function nextRangeStart(
  starts: readonly number[],
  first: number,
  end: number,
): number | undefined {
  if (starts.length === 0) return first;
  const last = Math.max(...starts);
  if (last >= end) return undefined;
  return last + Math.ceil((end - last) / 2);
}

/** One attribute offered while typing an attribute name. */
export interface AttributeSuggestion {
  name: string;
  /** Hint shown beside the name, such as "Color · R". */
  label: string;
}

/**
 * Lists the attribute names to suggest: the standard catalog first, then
 * attributes the fixture defines that the catalog lacks, each name once.
 */
export function attributeSuggestions(
  catalog: readonly types.DraftAttributeOption[],
  fixtureAttributes: readonly string[],
): AttributeSuggestion[] {
  const known = new Set(catalog.map((option) => option.name));
  return [
    ...catalog.map((option) => ({
      name: option.name,
      label: `${option.group} · ${option.pretty}`,
    })),
    ...[...new Set(fixtureAttributes)]
      .filter((name) => !known.has(name))
      .map((name) => ({ name, label: "Defined by this fixture" })),
  ];
}

/** Picks a name not used yet, such as "Mode 2", for something new. */
export function nextName(base: string, taken: readonly string[]): string {
  for (let number = taken.length + 1; ; number++) {
    const name = `${base} ${number}`;
    if (!taken.includes(name)) return name;
  }
}
