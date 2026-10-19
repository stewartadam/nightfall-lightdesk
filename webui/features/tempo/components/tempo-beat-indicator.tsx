// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Index, Show } from "solid-js";
import { MAX_BEAT_DOTS } from "../model";
import "./tempo.css";

interface TempoBeatIndicatorProps {
  /** Zero-based beat within the bar that is currently playing. */
  beat: number;
  /** Number of beats in one bar. */
  beatsPerBar: number;
  /** Dot scale: `compact` for tight surfaces, `large` for the Tempo panel. */
  size?: "compact" | "large";
}

/**
 * Draws one dot per beat of the bar with the current beat lit and beat 1
 * drawn larger. Bars too long to draw as dots show a `beat/bar` counter.
 */
export function TempoBeatIndicator(props: TempoBeatIndicatorProps) {
  return (
    <Show
      when={props.beatsPerBar <= MAX_BEAT_DOTS}
      fallback={
        <span
          class="nf-tempo-beat-counter"
          data-size={props.size ?? "compact"}
          aria-hidden="true"
        >
          {props.beat + 1}/{props.beatsPerBar}
        </span>
      }
    >
      <span
        class="nf-tempo-beats"
        data-size={props.size ?? "compact"}
        aria-hidden="true"
        data-testid="tempo-beats"
      >
        <Index each={Array.from({ length: props.beatsPerBar })}>
          {(_, index) => (
            <span
              class="nf-tempo-beat"
              data-downbeat={index === 0 ? "true" : undefined}
              data-active={props.beat === index ? "true" : undefined}
            />
          )}
        </Index>
      </span>
    </Show>
  );
}
