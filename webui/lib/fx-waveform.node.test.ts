// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { WaveformKind } from "../types";
import {
  flowWaveformToFxWaveform,
  fxWaveformToFlowWaveform,
} from "./fx-waveform";

/**
 * Verifies the editor's waveform bounds reach the backend as fractions of the parameter range
 * at the 32-bit precision the backend stores and echoes, so a saved FX compares equal to
 * the one the editor sent and editing an FX never shifts its range.
 */
test("FX waveform bounds round-trip as fractions of the parameter range", () => {
  const flow = {
    kind: WaveformKind.Sin,
    cycle_length_secs: 2,
    amplitude: 0.3,
    phase: 0,
    base: 0.125,
    duty_cycle: 1,
  };

  const fx = flowWaveformToFxWaveform(flow, true);
  assert.equal(fx.params.min, 0.125);
  assert.equal(fx.params.max, Math.fround(0.425));
  assert.equal(fx.is_relative, true);

  const back = fxWaveformToFlowWaveform(fx);
  assert.equal(back.base, 0.125);
  assert.ok(Math.abs(back.amplitude - 0.3) < 1e-7);
});
