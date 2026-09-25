// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createSignal, type JSX } from "solid-js";
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
  const [commitCount, setCommitCount] = createSignal(0);

  /** Toggles whether the duty cycle is controlled by an upstream Flow connection. */
  const changeWired: JSX.EventHandler<HTMLInputElement, Event> = (event) => {
    setWired(event.currentTarget.checked);
  };

  /** Records each editor publication and merges its fields as one waveform commit. */
  const commitWaveform = (updates: Partial<FlowWaveform>) => {
    setWaveform({ ...waveform(), ...updates });
    setCommitCount(commitCount() + 1);
  };

  return (
    <div class="max-w-3xl p-6">
      <label>
        <input type="checkbox" checked={wired()} onChange={changeWired} />
        Wired duty cycle
      </label>
      <WaveformEditor
        waveform={waveform()}
        onWaveformChange={commitWaveform}
        disabledFields={{ dutyCycle: wired() }}
      />
      <output>{JSON.stringify(waveform())}</output>
      <span data-testid="commit-count">{commitCount()}</span>
    </div>
  );
}

render(WaveformEditorFixture, document.getElementById("root")!);
