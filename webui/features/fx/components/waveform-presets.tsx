// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { For } from "solid-js";
import { Button } from "../../../components/ui/visual-language/button";
import { WaveformKind } from "../../../types";

/** Available waveform presets */
const WAVE_PRESETS: { kind: WaveformKind; label: string; icon: string }[] = [
  { kind: WaveformKind.Sin, label: "Sine", icon: "∿" },
  { kind: WaveformKind.Triangle, label: "Triangle", icon: "△" },
  { kind: WaveformKind.Sawtooth, label: "Sawtooth", icon: "⋰" },
  { kind: WaveformKind.Square, label: "Square", icon: "⊓" },
  { kind: WaveformKind.Pulse, label: "Pulse", icon: "⎍" },
];

export interface WaveformPresetsProps {
  /** The attribute this preset selector is for */
  attribute: string;
  /** The currently selected waveform kind */
  currentKind: WaveformKind;
  /** Callback when a preset is selected */
  onSelect: (kind: WaveformKind) => void;
}

/**
 * Preset button bar for selecting waveform types.
 */
export function WaveformPresets(props: WaveformPresetsProps) {
  return (
    <div class="flex gap-1 flex-wrap">
      <For each={WAVE_PRESETS}>
        {(preset) => (
          <Button
            size="compact"
            type="button"
            variant={
              props.currentKind === preset.kind ? "primary" : "secondary"
            }
            aria-pressed={props.currentKind === preset.kind}
            onClick={() => props.onSelect(preset.kind)}
            title={preset.label}
          >
            <span class="mr-1">{preset.icon}</span>
            {preset.label}
          </Button>
        )}
      </For>
    </div>
  );
}
