// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { type GridCell, GridCellKind } from "../../../lib/data-grid-types";
import {
  type DropdownGridCell,
  isDropdownCell,
} from "../../../lib/tanstack-dropdown-cell";
import type { MidiDeviceProfile, MidiLedValues } from "../../../types";

/** Which of a mapping's LED values a cell edits. */
export type LedValueKey = keyof MidiLedValues;

/** Placeholder shown in an LED value cell the mapping leaves at the desk's default. */
const LED_DEFAULT_LABEL = "Default";

/**
 * Builds an editable LED value cell. A device with a controller profile offers the
 * profile's named colors with swatches, plus "Default" naming the profile's choice; a raw
 * value matching no color is listed by number. Devices without a profile take a typed
 * number, and an unset value shows a placeholder since the desk decides the default.
 */
export function ledValueCell(
  led: MidiLedValues | undefined,
  key: LedValueKey,
  profile: MidiDeviceProfile | undefined | null,
): GridCell {
  const value = led?.[key];
  if (profile) return profileLedCell(led, key, profile);
  if (value === undefined || value === null) {
    return {
      kind: GridCellKind.Text,
      data: "",
      displayData: LED_DEFAULT_LABEL,
      allowOverlay: true,
    };
  }
  return {
    kind: GridCellKind.Number,
    data: value,
    displayData: String(value),
    allowOverlay: true,
  };
}

/**
 * Returns the value the desk shows for an LED value the mapping leaves unset: the profile's
 * default, except that an unset held value follows the mapping's own on value when it sets
 * one, matching how the engine fills it.
 */
function defaultLedValue(
  led: MidiLedValues | undefined,
  key: LedValueKey,
  profile: MidiDeviceProfile,
): number | undefined | null {
  if (key === "held") {
    return led?.on ?? profile.defaultLed.held ?? profile.defaultLed.on;
  }
  return profile.defaultLed[key];
}

/** Builds the color dropdown cell for an LED value on a device with a profile. */
function profileLedCell(
  led: MidiLedValues | undefined,
  key: LedValueKey,
  profile: MidiDeviceProfile,
): DropdownGridCell {
  const value = led?.[key];
  const colorFor = (raw: number | undefined | null) =>
    profile.colors.find((color) => color.value === raw);
  const fallback = colorFor(defaultLedValue(led, key, profile));
  const named = profile.colors.map((color) => ({
    value: String(color.value),
    label: color.name,
    swatch: color.swatch,
  }));
  const unnamed =
    value !== undefined && value !== null && !colorFor(value)
      ? [{ value: String(value), label: `Value ${value}` }]
      : [];
  return {
    kind: GridCellKind.Custom,
    data: {
      kind: "dropdown-cell",
      value: value === undefined || value === null ? "" : String(value),
      allowedValues: [
        {
          value: "",
          label: fallback
            ? `${LED_DEFAULT_LABEL} (${fallback.name})`
            : LED_DEFAULT_LABEL,
          swatch: fallback?.swatch,
        },
        ...named,
        ...unnamed,
      ],
    },
    copyData: value === undefined || value === null ? "" : String(value),
    allowOverlay: true,
  };
}

/**
 * Reads an edited LED value cell: a MIDI data byte, `null` when set back to the default,
 * or undefined for invalid input.
 */
export function editedLedValue(cell: GridCell): number | null | undefined {
  let text: string;
  if (isDropdownCell(cell)) {
    text = String(cell.data.value ?? "");
  } else if (
    cell.kind === GridCellKind.Number ||
    cell.kind === GridCellKind.Text
  ) {
    text = String(cell.data ?? "");
  } else {
    return undefined;
  }
  text = text.trim();
  if (text === "" || text === "NaN") return null;
  const value = Number(text);
  return Number.isInteger(value) && value >= 0 && value <= 127
    ? value
    : undefined;
}
