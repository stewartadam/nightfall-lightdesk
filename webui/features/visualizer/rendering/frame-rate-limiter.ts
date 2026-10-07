// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/** Target frame time in milliseconds for the visualizer's 60 FPS cap. */
export const TARGET_FRAME_TIME = 1000 / 60;

/**
 * Consumes all complete frame intervals from an accumulated duration.
 *
 * A non-null result means one frame should render. Missed intervals are
 * discarded so a delayed animation callback cannot trigger a burst of
 * catch-up renders above the configured frame-rate cap.
 */
export function consumeDueFrame(
  accumulatorMs: number,
  frameTimeMs = TARGET_FRAME_TIME,
): number | null {
  // Browser timestamps can be rounded to tenths of a millisecond. Treat that
  // boundary as due instead of alternately skipping and consuming two frames.
  const toleranceMs = 0.1;
  if (accumulatorMs + toleranceMs < frameTimeMs) return null;
  const elapsedFrames = Math.floor((accumulatorMs + toleranceMs) / frameTimeMs);
  return Math.max(0, accumulatorMs - elapsedFrames * frameTimeMs);
}
