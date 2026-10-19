// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { Show } from "solid-js";
import { showTempo } from "../../../state/appStores";
import { createBeatInBar } from "../controllers/tempo-controller";
import { formatBpm } from "../model";
import { TempoBeatIndicator } from "./tempo-beat-indicator";
import { TempoTapButton } from "./tempo-tap-button";
import "./tempo.css";

interface TempoPadProps {
  /** Extra classes that size the pad for its surface. */
  class?: string;
}

/**
 * A compact show tempo control for tight surfaces such as boards: the whole
 * pad is a tap tempo button that also shows the beat dots and the current BPM,
 * so the operator sees the result of each tap where they tap.
 */
export function TempoPad(props: TempoPadProps) {
  const tempo = useStore(showTempo);
  const beat = createBeatInBar();
  return (
    <TempoTapButton class={`nf-tempo-pad ${props.class ?? ""}`}>
      <Show
        when={tempo()}
        fallback={<span class="nf-tempo-pad-hint">Tap</span>}
      >
        {(state) => (
          <>
            <TempoBeatIndicator
              beat={beat()}
              beatsPerBar={state().snapshot.beats_per_bar}
            />
            <span class="nf-tempo-pad-bpm">
              <span data-testid="tempo-bpm">
                {formatBpm(state().snapshot.bpm)}
              </span>{" "}
              <span class="nf-tempo-unit">BPM</span>
            </span>
            <span class="nf-tempo-pad-hint">Tap</span>
          </>
        )}
      </Show>
    </TempoTapButton>
  );
}
