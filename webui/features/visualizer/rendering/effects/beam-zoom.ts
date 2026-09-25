// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/** Narrowest cone angle rendered, in degrees, so a beam never collapses to a line. */
export const MIN_CONE_ANGLE_DEGREES = 0.5;

/**
 * Picks the cone angle a beam renders at before iris is applied.
 *
 * A profile-stated zoom angle wins over normalized zoom. Profiles may author
 * a zero or negative angle at one end of a zoom range, which would give the
 * beam no radius and its light no cone, so the result is floored at
 * {@link MIN_CONE_ANGLE_DEGREES}. A non-finite stated angle is ignored in
 * favor of the beam spec's normalized zoom range.
 */
export function renderableConeAngleDegrees(
  beamAngleDegrees: number,
  fieldAngleDegrees: number,
  zoom: number,
  zoomDegrees?: number,
): number {
  const angle =
    zoomDegrees !== undefined && Number.isFinite(zoomDegrees)
      ? zoomDegrees
      : beamConeAngleDegrees(beamAngleDegrees, fieldAngleDegrees, zoom);
  return Math.max(MIN_CONE_ANGLE_DEGREES, angle);
}

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
): number {
  const focusedAngleDegrees = Math.min(beamAngleDegrees, fieldAngleDegrees);
  const unfocusedAngleDegrees = Math.max(beamAngleDegrees, fieldAngleDegrees);
  const normalizedZoom = Math.max(0, Math.min(1, zoom));

  return (
    unfocusedAngleDegrees -
    (unfocusedAngleDegrees - focusedAngleDegrees) * normalizedZoom
  );
}
