// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Specialized fixture renderers for Visualizer.
 *
 * This module provides optimized renderers for specific fixture types:
 * - LED bars: InstancedMesh for efficient pixel rendering
 * - Strobe panels: Multi-element grid with tilt support
 * - Moving heads: Pan/tilt fixtures with volumetric beams
 * - GDTF fallback: Generic GDTF geometry rendering
 */

export {
  buildFixtureWithoutGeometry,
  buildFixtureWithRenderer,
  disposeFixtureWithRenderer,
  type ExtendedFixtureInstance,
  updateFixtureColors,
} from "./renderer-registry";
