// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Input } from "../../../components/ui/form-controls";
import { formatGranularity, formatSliderValue } from "../model/panel-model";
import type { TapPatternDetectionOptions } from "../model/tap-pattern-analysis";

interface TapPatternSettingsProps {
  beatsPerLoop: number;
  detectionOptions: TapPatternDetectionOptions;
  onBeatsPerLoopChange: (value: string) => void;
  onDetectionOptionChange: (
    option: keyof TapPatternDetectionOptions,
    value: string,
  ) => void;
}

/** Presents loop and detection controls without owning panel state. */
export function TapPatternSettings(props: TapPatternSettingsProps) {
  return (
    <div class="flex flex-wrap items-center gap-4 border border-neutral-800 bg-neutral-950 px-3 py-2">
      <label class="flex items-center gap-2 text-xs text-neutral-400">
        <span>Beats/loop</span>
        <Input
          density="compact"
          class="h-7 w-16"
          min="1"
          max="16"
          step="0.25"
          type="number"
          value={props.beatsPerLoop}
          onInput={(event) =>
            props.onBeatsPerLoopChange(event.currentTarget.value)
          }
        />
      </label>
      <label
        class="flex items-center gap-2 text-xs text-neutral-400"
        data-tap-control="true"
      >
        <span>Sensitivity</span>
        <input
          aria-label="Sensitivity"
          class="h-7 w-28 accent-cyan-300"
          min="0"
          max="100"
          step="1"
          type="range"
          value={props.detectionOptions.sensitivity}
          onInput={(event) =>
            props.onDetectionOptionChange(
              "sensitivity",
              event.currentTarget.value,
            )
          }
        />
        <span class="w-10 font-mono text-neutral-300">
          {formatSliderValue(props.detectionOptions.sensitivity)}
        </span>
      </label>
      <label
        class="flex items-center gap-2 text-xs text-neutral-400"
        data-tap-control="true"
      >
        <span>Granularity</span>
        <input
          aria-label="Granularity"
          class="h-7 w-28 accent-cyan-300"
          min="0"
          max="100"
          step="1"
          type="range"
          value={props.detectionOptions.granularity}
          onInput={(event) =>
            props.onDetectionOptionChange(
              "granularity",
              event.currentTarget.value,
            )
          }
        />
        <span class="w-16 font-mono text-neutral-300">
          {formatGranularity(props.detectionOptions.granularity)}
        </span>
      </label>
    </div>
  );
}
