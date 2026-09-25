// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/** Display exposure for luminous faces, independent of source photometry used by beam optics. */
export const EMITTER_RADIANCE = 16;

/**
 * Luminous-face exposure for presets rendered without bloom, where an HDR face would
 * clip to flat white instead of spreading its excess energy into glow.
 */
export const UNBLOOMED_EMITTER_RADIANCE = 2;

/** Normalized emitter intensity at or below which a source is treated as dark. */
export const VISIBLE_INTENSITY_THRESHOLD = 0.01;
