// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { uniform } from "three/tsl";
import { Vector3, Vector4 } from "three/webgpu";
import type { ResolvedEmitterOptics } from "../../features/visualizer/rendering/effects/emitter-optics";
import { createEmitterVolumeMaterial } from "../../features/visualizer/rendering/effects/emitter-volume-material";

/**
 * Drives the production volume integrator from uniforms, so a browser fixture can light one
 * ordinary mesh without assembling an instanced emitter batch.
 */
export function createUniformEmitterVolume(
  options: Omit<
    NonNullable<Parameters<typeof createEmitterVolumeMaterial>[0]>,
    "inputs"
  > = {},
) {
  const inputs = {
    origin: uniform(new Vector3()),
    right: uniform(new Vector3(1, 0, 0)),
    up: uniform(new Vector3(0, 1, 0)),
    forward: uniform(new Vector3(0, 0, -1)),
    optics: uniform(new Vector4(0.1, 0.1, 0.01, 4)),
    radiance: uniform(new Vector3()),
    secondary: uniform(new Vector4()),
    rectangular: uniform(0),
    beamLength: uniform(30),
    sourceId: uniform(0),
    pattern: uniform(new Vector4()),
  };
  const { material } = createEmitterVolumeMaterial({ ...options, inputs });
  return {
    material,
    ...inputs,
    /** Uploads one resolved distribution without recompiling the material. */
    setOptics(optics: ResolvedEmitterOptics): void {
      inputs.optics.value.set(
        optics.slopeX,
        optics.slopeY,
        optics.radius,
        optics.distributionPower,
      );
      inputs.rectangular.value = optics.shape === "rectangle" ? 1 : 0;
    },
  };
}
