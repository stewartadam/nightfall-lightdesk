// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Reads the text of a numeric input as typed: null when it is blank, otherwise the number it
 * spells, which may be fractional, out of range or NaN. Forms keep this value instead of the last
 * valid one, so the field never jumps while typing and validation sees what the user entered.
 */
export function parseNumberDraft(text: string): number | null {
  return text.trim() === "" ? null : Number(text);
}

/** The parts of a numeric `<input>` that {@link readNumberField} reads. */
export interface NumberFieldState {
  value: string;
  validity: Pick<ValidityState, "badInput">;
}

/**
 * Reads a `type="number"` input as typed. The browser reports an empty value both for a blank
 * field and for unfinished text such as "1e" or "-"; the latter is NaN here (typed but invalid),
 * so it isn't mistaken for a cleared field.
 */
export function readNumberField(input: NumberFieldState): number | null {
  return input.validity.badInput ? Number.NaN : parseNumberDraft(input.value);
}

/** Formats a stored draft number for a field: blank for null or NaN, else the number's text. */
export function formatNumberDraft(value: number | null): string {
  return value === null || Number.isNaN(value) ? "" : String(value);
}

/** Whether a typed number is a whole number from `min` to `max`, inclusive. */
export function isWholeNumberInRange(
  value: number | null,
  min: number,
  max = Number.POSITIVE_INFINITY,
): value is number {
  return (
    value !== null && Number.isInteger(value) && value >= min && value <= max
  );
}
