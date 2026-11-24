// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/** The portrait viewport, in CSS pixels, every take records. */
export const VIEWPORT = { width: 720, height: 1280 };

/**
 * Reads the capture's device pixels per CSS pixel from `PROMO_CAPTURE_SCALE`.
 * The default of 3 records at 2160x3840, twice the reel's 1080x1920, so a 2x
 * zoom in the edit still shows one recorded pixel per reel pixel instead of
 * upscaling. Software rendering without a GPU is slow at that size; set 1.5
 * there to record at the reel's own size.
 */
function captureScale(): number {
  const raw = process.env.PROMO_CAPTURE_SCALE;
  if (!raw) return 3;
  const scale = Number(raw);
  if (!Number.isFinite(scale) || scale < 1) {
    throw new Error(`PROMO_CAPTURE_SCALE needs a number of at least 1, got "${raw}"`);
  }
  return scale;
}

/** Device pixels per CSS pixel for the take. */
export const CAPTURE_SCALE = captureScale();

/** The recording's size in pixels. */
export const CAPTURE_SIZE = {
  width: Math.round(VIEWPORT.width * CAPTURE_SCALE),
  height: Math.round(VIEWPORT.height * CAPTURE_SCALE),
};
