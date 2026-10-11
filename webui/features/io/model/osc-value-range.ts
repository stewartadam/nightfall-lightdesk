// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type * as types from "../../../types";

/** One end of an OSC mapping's explicit value range. */
export type OscRangeEnd = "min" | "max";

/**
 * Ends assumed for a range whose other end has not been entered yet, matching the
 * normalized `0..1` levels floats are read as when no range is set.
 */
const DEFAULT_RANGE: types.OscValueRange = { min: 0, max: 1 };

/** Result of editing one end of a value range: the new range (unset means auto), or why not. */
export type OscRangeEdit =
  | { ok: true; range: types.OscValueRange | undefined }
  | { ok: false; error: string };

/** Formats one end of a mapping's value range for display; blank means units are inferred. */
export function formatOscRangeEnd(
  range: types.OscValueRange | undefined | null,
  end: OscRangeEnd,
): string {
  return range ? String(range[end]) : "";
}

/**
 * Checks that a value range has finite, distinct ends, mirroring the backend's
 * `OscValueRange::validate`. Returns the error message, or undefined for a valid range.
 */
export function oscRangeError(range: types.OscValueRange): string | undefined {
  if (!Number.isFinite(range.min) || !Number.isFinite(range.max)) {
    return "OSC value range must use finite numbers";
  }
  if (range.min === range.max) {
    return `OSC value range minimum and maximum must differ (both are ${range.min})`;
  }
  return undefined;
}

/**
 * Applies text typed into a range end's cell.
 *
 * Blank text clears the whole range so the argument's units are inferred again. A number
 * replaces that end; when no range was set, the other end starts at its `0..1` default, so
 * entering only Max = 127 reads a 0..127 fader. Minimum may exceed maximum to reverse a
 * control's travel, but both ends must be finite and distinct.
 */
export function editOscRange(
  range: types.OscValueRange | undefined | null,
  end: OscRangeEnd,
  text: string,
): OscRangeEdit {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: true, range: undefined };
  const value = Number(trimmed);
  if (!Number.isFinite(value)) {
    return { ok: false, error: `"${trimmed}" is not a number` };
  }
  const edited = { ...(range ?? DEFAULT_RANGE), [end]: value };
  const error = oscRangeError(edited);
  return error === undefined
    ? { ok: true, range: edited }
    : { ok: false, error };
}
