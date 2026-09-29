// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  EMITTER_RADIANCE,
  UNBLOOMED_EMITTER_RADIANCE,
} from "./emitter-radiance";
import { resolveQualityProfile } from "./quality-profile";

const PRESETS = ["low", "medium", "high"] as const;

/** Masks, prism splits and shadows are only sampled by the ray-marched volume, so cone presets must not request them. */
test("only volumetric beams project gobos, prisms and shadows", () => {
  for (const preset of PRESETS) {
    const profile = resolveQualityProfile(preset);
    const volumetric = profile.beamStyle.kind === "volumetric";
    assert.equal(profile.preset, preset);
    assert.equal(profile.gobos, volumetric, preset);
    assert.equal(profile.prismFacets, volumetric, preset);
    assert.equal(profile.shadows, volumetric, preset);
  }
});

/** Without bloom, faces driven at full HDR radiance would clip, so their exposure drops to the unbloomed level. */
test("emitter display gain compensates for a missing bloom pass", () => {
  for (const preset of PRESETS) {
    const profile = resolveQualityProfile(preset);
    assert.equal(
      EMITTER_RADIANCE * profile.emitterDisplayGain,
      profile.bloom ? EMITTER_RADIANCE : UNBLOOMED_EMITTER_RADIANCE,
      preset,
    );
  }
});
