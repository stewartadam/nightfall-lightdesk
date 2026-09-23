// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Maps a normalized zoom value to a rendered cone angle.
 *
 * Visualizer zoom follows fixture operator semantics: 1 is fully zoomed in and
 * focused, while 0 is zoomed out and unfocused.
 */
export function beamConeAngleDegrees(
  beamAngleDegrees: number,
  fieldAngleDegrees: number,
  zoom: number,
  range?: { narrow: number; wide: number },
): number {
  const focusedAngleDegrees =
    range?.narrow ?? Math.min(beamAngleDegrees, fieldAngleDegrees);
  const unfocusedAngleDegrees =
    range?.wide ?? Math.max(beamAngleDegrees, fieldAngleDegrees);
  const normalizedZoom = Math.max(0, Math.min(1, zoom));

  return (
    unfocusedAngleDegrees -
    (unfocusedAngleDegrees - focusedAngleDegrees) * normalizedZoom
  );
}
