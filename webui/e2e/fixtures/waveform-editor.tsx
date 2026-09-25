// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { WaveformEditor } from "../../features/fx/components/waveform-editor";
import { type FlowWaveform, WaveformKind } from "../../types";
import "../../index.css";

/** Mounts the shared editor with editable and wired duty-cycle scenarios. */
function WaveformEditorFixture() {
  const [waveform, setWaveform] = createSignal<FlowWaveform>({
    kind: WaveformKind.Sin,
    rate_secs: 1,
    amplitude: 1,
    base: 0,
    phase: 0,
    duty_cycle: 1,
  });
  const [wired, setWired] = createSignal(false);
  return (
    <div class="max-w-3xl p-6">
      <label>
        <input
          type="checkbox"
          checked={wired()}
          onChange={(event) => setWired(event.currentTarget.checked)}
        />
        Wired duty cycle
      </label>
      <WaveformEditor
        waveform={waveform()}
        onKindChange={(kind) => setWaveform((value) => ({ ...value, kind }))}
        onWaveformChange={(updates) =>
          setWaveform((value) => ({ ...value, ...updates }))
        }
        disabledFields={{ dutyCycle: wired() }}
      />
      <output>{JSON.stringify(waveform())}</output>
    </div>
  );
}

render(() => <WaveformEditorFixture />, document.getElementById("root")!);
