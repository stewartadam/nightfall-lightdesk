// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { ArrowsClockwiseIcon } from "@squidlab/phosphor-solid/arrows-clockwise";
import { FastForwardIcon } from "@squidlab/phosphor-solid/fast-forward";
import { RewindIcon } from "@squidlab/phosphor-solid/rewind";
import { SkipForwardIcon } from "@squidlab/phosphor-solid/skip-forward";
import {
  createEffect,
  createSignal,
  For,
  Index,
  on,
  onCleanup,
  Show,
  untrack,
} from "solid-js";
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "../../components/ui/dropdown-menu";
import { NumericStepper } from "../../components/ui/numeric-stepper";
import { ToolbarButton } from "../../components/ui/toolbar-button";
import { engineRuntime } from "../../lib/engine-runtime";
import { getLogger } from "../../lib/logger";
import { showTempo } from "../../state/appStores";
import type { TempoCommand } from "../../types";
import {
  beatInBar,
  extrapolateBeatPosition,
  formatBpm,
  MAX_BEAT_DOTS,
  parseBpmInput,
} from "./model";
import "./tempo-controls.css";

const log = getLogger(import.meta.url);

/** Sends one command to the show tempo engine. */
function sendTempoCommand(command: TempoCommand) {
  log.debug("Sending tempo command", { command });
  engineRuntime.sendCommand({ module: "TempoCommand", command });
}

/**
 * Show tempo readout for the status bar and compact header: a beat indicator
 * that follows the engine's beat counter, the BPM (which opens tempo actions),
 * and a Tap button. Tapping registers on pointer down for the tightest timing.
 */
export function TempoControls(props: { placement: "above" | "below" }) {
  const tempo = useStore(showTempo);
  const [beat, setBeat] = createSignal(0);
  const [bpmDraft, setBpmDraft] = createSignal("");
  const [beatsPerBarDraft, setBeatsPerBarDraft] = createSignal("");
  const [menuOpen, setMenuOpen] = createSignal(false);

  /** Re-derives the current beat each animation frame while tempo data exists. */
  createEffect(() => {
    const state = tempo();
    if (!state) return;
    let frame = 0;
    const tick = () => {
      const position = extrapolateBeatPosition(
        state.snapshot,
        state.receivedAtMs,
        performance.now(),
      );
      setBeat(beatInBar(position, state.snapshot.beats_per_bar));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    onCleanup(() => cancelAnimationFrame(frame));
  });

  /**
   * Seeds the menu's editable fields from the engine when the menu opens, and
   * leaves them alone while it stays open so incoming tempo updates never
   * overwrite what the operator is typing.
   */
  createEffect(
    on(menuOpen, (open) => {
      const state = untrack(tempo);
      if (!open || !state) return;
      setBpmDraft(formatBpm(state.snapshot.target_bpm));
      setBeatsPerBarDraft(String(state.snapshot.beats_per_bar));
    }),
  );

  /** Sends the drafted tempo when it is a valid positive number. */
  const commitBpm = () => {
    const bpm = parseBpmInput(bpmDraft());
    if (bpm !== undefined) sendTempoCommand({ type: "SetBpm", data: bpm });
  };

  /** Sends the drafted bar length when it is a whole number of beats. */
  const commitBeatsPerBar = () => {
    const beats = Number(beatsPerBarDraft());
    if (Number.isInteger(beats) && beats >= 1 && beats <= 16) {
      sendTempoCommand({ type: "SetBeatsPerBar", data: beats });
    }
  };

  /** Number of beat dots to draw for the current bar length. */
  const dotCount = () => tempo()?.snapshot.beats_per_bar ?? 4;

  return (
    <Show when={tempo()}>
      {(state) => (
        <div class="nf-tempo-controls" data-testid="tempo-controls">
          <DropdownMenu
            triggerLabel="Tempo"
            triggerTitle="Tempo"
            triggerClass="nf-tempo-trigger"
            placement={props.placement}
            align="end"
            contentLabel="Tempo"
            open={menuOpen()}
            onOpenChange={setMenuOpen}
            trigger={
              <>
                <Show
                  when={dotCount() <= MAX_BEAT_DOTS}
                  fallback={
                    <span class="nf-tempo-beat-counter" aria-hidden="true">
                      {beat() + 1}/{dotCount()}
                    </span>
                  }
                >
                  <span
                    class="nf-tempo-beats"
                    aria-hidden="true"
                    data-testid="tempo-beats"
                  >
                    <Index each={Array.from({ length: dotCount() })}>
                      {(_, index) => (
                        <span
                          class="nf-tempo-beat"
                          data-downbeat={index === 0 ? "true" : undefined}
                          data-active={beat() === index ? "true" : undefined}
                        />
                      )}
                    </Index>
                  </span>
                </Show>
                <span class="nf-tempo-bpm" data-testid="tempo-bpm">
                  {formatBpm(state().snapshot.bpm)}
                </span>
                <span class="nf-tempo-unit">BPM</span>
              </>
            }
          >
            <div
              class="nf-tempo-menu-fields"
              onKeyDown={(event) => event.stopPropagation()}
            >
              <label class="nf-tempo-field">
                <span>Tempo (BPM)</span>
                <NumericStepper
                  aria-label="Tempo in BPM"
                  data-testid="tempo-bpm-input"
                  density="compact"
                  min={20}
                  max={300}
                  step="any"
                  value={bpmDraft()}
                  onValueChange={setBpmDraft}
                  onBlur={commitBpm}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") commitBpm();
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
                  max={16}
                  step={1}
                  value={beatsPerBarDraft()}
                  onValueChange={(value) => {
                    setBeatsPerBarDraft(value);
                    commitBeatsPerBar();
                  }}
                  decreaseLabel="Fewer beats per bar"
                  increaseLabel="More beats per bar"
                />
              </label>
            </div>
            <DropdownMenuSeparator />
            <For
              each={
                [
                  ["Half time", RewindIcon, { type: "Multiply", data: 0.5 }],
                  [
                    "Double time",
                    FastForwardIcon,
                    { type: "Multiply", data: 2 },
                  ],
                  [
                    "Resync to downbeat",
                    ArrowsClockwiseIcon,
                    { type: "Resync" },
                  ],
                  ["Jump to next downbeat", SkipForwardIcon, { type: "Snap" }],
                ] as const
              }
            >
              {([label, icon, command]) => (
                <DropdownMenuItem
                  icon={icon}
                  onClick={() => sendTempoCommand(command)}
                >
                  {label}
                </DropdownMenuItem>
              )}
            </For>
          </DropdownMenu>
          <ToolbarButton
            label="Tap tempo"
            size="labeled"
            class="nf-tempo-tap"
            data-testid="tempo-tap"
            onPointerDown={(event) => {
              if (event.button === 0) sendTempoCommand({ type: "Tap" });
            }}
            onKeyDown={(event) => {
              if (event.repeat) return;
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                sendTempoCommand({ type: "Tap" });
              }
            }}
          >
            Tap
          </ToolbarButton>
        </div>
      )}
    </Show>
  );
}
