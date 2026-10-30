// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { ArrowsClockwiseIcon } from "@squidlab/phosphor-solid/arrows-clockwise";
import { FastForwardIcon } from "@squidlab/phosphor-solid/fast-forward";
import { LightningIcon } from "@squidlab/phosphor-solid/lightning";
import { RewindIcon } from "@squidlab/phosphor-solid/rewind";
import { SkipForwardIcon } from "@squidlab/phosphor-solid/skip-forward";
import { For, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { NumericStepper } from "../../../components/ui/numeric-stepper";
import PanelToolbar from "../../../components/ui/panel-toolbar";
import {
  SegmentedControl,
  type SegmentedControlOption,
} from "../../../components/ui/segmented-control";
import { Toolbar } from "../../../components/ui/toolbar";
import { ToolbarButton } from "../../../components/ui/toolbar-button";
import { isEditableKeyboardTarget } from "../../../components/widgets/data-grid/event-adapter";
import { commandClient } from "../../../lib/engine-commands";
import type { BasePanelComponentProps } from "../../../lib/panel-registry";
import { armedLaunches, showTempo } from "../../../state/appStores";
import { LaunchQuantize } from "../../../types";
import { TempoBeatIndicator } from "../components/tempo-beat-indicator";
import { TempoTapButton } from "../components/tempo-tap-button";
import {
  createBeatInBar,
  createTempoField,
  sendTap,
  sendTempoCommand,
} from "../controllers/tempo-controller";
import {
  formatBpm,
  MAX_BEATS_PER_BAR,
  MAX_BPM,
  MIN_BPM,
  parseBpmInput,
} from "../model";
import "../components/tempo.css";

/**
 * Returns whether a key press inside the panel should tap: a printable key or Space,
 * pressed without Ctrl, Cmd or Alt and without auto-repeat, outside the tempo fields and
 * toolbar buttons (which keep their own keys). The Tap pad handles its own keys first.
 */
function isTapKeyEvent(event: KeyboardEvent): boolean {
  return (
    !event.defaultPrevented &&
    !event.repeat &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    event.key.length === 1 &&
    !isEditableKeyboardTarget(event.target) &&
    !(event.target instanceof HTMLButtonElement)
  );
}

/** One-press tempo actions shown in the panel toolbar. */
const TEMPO_ACTIONS = [
  ["Half time", RewindIcon, { type: "Multiply", data: 0.5 }],
  ["Double time", FastForwardIcon, { type: "Multiply", data: 2 }],
  ["Resync to downbeat", ArrowsClockwiseIcon, { type: "Resync" }],
  ["Jump to next downbeat", SkipForwardIcon, { type: "Snap" }],
] as const;

/** Launch quantize modes offered by the panel. */
const LAUNCH_QUANTIZE_OPTIONS: readonly SegmentedControlOption<LaunchQuantize>[] =
  [
    {
      value: LaunchQuantize.Off,
      label: "Off",
      tooltip: "Clips launch as soon as they are pressed",
    },
    {
      value: LaunchQuantize.Beat,
      label: "Beat",
      tooltip: "Clips launch and stop on the next beat",
    },
    {
      value: LaunchQuantize.Bar,
      label: "Bar",
      tooltip: "Clips launch and stop on the next downbeat",
    },
  ];

/** Fires every clip waiting for its beat or bar now. */
function launchArmedNow() {
  commandClient.emit("ClipCommand", { type: "LaunchArmed" });
}

/**
 * The show tempo panel: a beat indicator and BPM readout that follow the
 * engine, fields for the exact tempo and bar length, half/double time and
 * downbeat actions, and a large Tap pad for tapping along with the music.
 */
export default function TempoPanel(_props: BasePanelComponentProps) {
  const tempo = useStore(showTempo);
  const armed = useStore(armedLaunches);
  const beat = createBeatInBar();

  /** Returns whether any clip is waiting for its beat or bar. */
  const hasArmedLaunches = () => Object.keys(armed()).length > 0;

  /**
   * The exact tempo. Only a value in the engine's range is sent, so a partly
   * typed number such as the "1" of "128" is never applied.
   */
  const bpm = createTempoField({
    read: (snapshot) => formatBpm(snapshot.target_bpm),
    apply: (draft) => {
      const value = parseBpmInput(draft);
      if (value === undefined || value < MIN_BPM || value > MAX_BPM) {
        return false;
      }
      sendTempoCommand({ type: "SetBpm", data: value });
      return true;
    },
  });

  /** The bar length, sent only as a whole number of beats in range. */
  const beatsPerBar = createTempoField({
    read: (snapshot) => String(snapshot.beats_per_bar),
    apply: (draft) => {
      const value = Number(draft);
      if (!Number.isInteger(value) || value < 1 || value > MAX_BEATS_PER_BAR) {
        return false;
      }
      sendTempoCommand({ type: "SetBeatsPerBar", data: value });
      return true;
    },
  });

  return (
    <div
      class="nf-tempo-panel"
      data-testid="tempo-panel"
      tabIndex={-1}
      onKeyDown={(event) => {
        if (isTapKeyEvent(event)) {
          event.preventDefault();
          event.stopPropagation();
          sendTap(event);
        }
      }}
    >
      <PanelToolbar
        left={
          <Toolbar label="Tempo actions" class="flex items-center gap-0.5">
            <For each={TEMPO_ACTIONS}>
              {([label, icon, command]) => (
                <ToolbarButton
                  label={label}
                  onClick={() => sendTempoCommand(command)}
                >
                  <Dynamic component={icon} class="size-4" aria-hidden />
                </ToolbarButton>
              )}
            </For>
            <ToolbarButton
              label="Launch armed clips now"
              disabled={!hasArmedLaunches()}
              onClick={launchArmedNow}
            >
              <LightningIcon class="size-4" aria-hidden />
            </ToolbarButton>
          </Toolbar>
        }
      />
      <Show
        when={tempo()}
        fallback={<div class="nf-tempo-panel-empty">Waiting for tempo…</div>}
      >
        {(state) => (
          <div class="nf-tempo-panel-body">
            <div class="nf-tempo-readout">
              <TempoBeatIndicator
                beat={beat()}
                beatsPerBar={state().snapshot.beats_per_bar}
                size="large"
              />
              <span class="nf-tempo-readout-bpm" data-testid="tempo-bpm">
                {formatBpm(state().snapshot.bpm)}
              </span>
              <span class="nf-tempo-unit">BPM</span>
            </div>
            <div class="nf-tempo-fields">
              <label class="nf-tempo-field">
                <span>Tempo (BPM)</span>
                <NumericStepper
                  aria-label="Tempo in BPM"
                  data-testid="tempo-bpm-input"
                  density="compact"
                  min={MIN_BPM}
                  max={MAX_BPM}
                  step="any"
                  value={bpm.draft()}
                  onValueChange={bpm.change}
                  onBlur={bpm.blur}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") bpm.commit();
                  }}
                  decreaseLabel="Decrease tempo"
                  increaseLabel="Increase tempo"
                />
              </label>
              <label class="nf-tempo-field">
                <span>Beats per bar</span>
                <NumericStepper
                  aria-label="Beats per bar"
                  density="compact"
                  min={1}
                  max={MAX_BEATS_PER_BAR}
                  step={1}
                  value={beatsPerBar.draft()}
                  onValueChange={beatsPerBar.change}
                  onBlur={beatsPerBar.blur}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") beatsPerBar.commit();
                  }}
                  decreaseLabel="Fewer beats per bar"
                  increaseLabel="More beats per bar"
                />
              </label>
            </div>
            <div class="nf-tempo-launch-quantize">
              <span aria-hidden="true">Launch quantize</span>
              <SegmentedControl
                label="Launch quantize"
                density="compact"
                options={LAUNCH_QUANTIZE_OPTIONS}
                value={state().launchQuantize}
                onChange={(mode) =>
                  sendTempoCommand({ type: "SetLaunchQuantize", data: mode })
                }
                data-testid="launch-quantize-control"
              />
            </div>
            <TempoTapButton class="nf-tempo-panel-tap" />
            <div class="nf-tempo-key-hint">
              Or press any key while this panel has focus
            </div>
          </div>
        )}
      </Show>
    </div>
  );
}
