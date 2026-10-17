// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { MouseScrollIcon } from "@squidlab/phosphor-solid/mouse-scroll";
import { WarningIcon } from "@squidlab/phosphor-solid/warning";
import { createMemo, For, type JSX, Show } from "solid-js";
import { Checkbox, Input } from "../../../../components/ui/form-controls";
import { ToolbarSeparator } from "../../../../components/ui/panel-toolbar";
import Tooltip from "../../../../components/ui/tooltip";
import type * as types from "../../../../types";
import {
  formatStepFxDegrees,
  type StepFxPhaseMarker,
  stepFxPhaseOffset,
  stepFxPreviewIndexTitle,
} from "../../model/step-fx-editor-model";

/** Selects one resolved phase index as the waveform's live reference. */
export function StepFxPhasePreview(props: {
  markers: StepFxPhaseMarker[];
  phase: types.StepFxPhase;
  issues: string[];
  selectedIndex: number;
  onSelectIndex: (index: number) => void;
  showAllPlayheads: boolean;
  showAllPlayheadsLocked: boolean;
  showAllPlayheadsDisabledReason?: string;
  onShowAllPlayheadsChange: (showAll: boolean) => void;
  centerSelectedFixture: boolean;
  onCenterSelectedFixtureChange: (centerFixture: boolean) => void;
  samplingWarning: JSX.Element;
}) {
  /** Builds compact indexes for the resolved spatial selection. */
  const indexes = createMemo(() =>
    Array.from({ length: props.markers.length }, (_, index) => index),
  );
  const viewButtonClass =
    "inline-flex h-7 items-center justify-center border border-neutral-700 px-2 text-[11px] font-medium text-neutral-300 transition-colors hover:bg-neutral-700 aria-checked:bg-blue-600 aria-checked:text-white";
  return (
    <div
      class="flex min-w-0 items-center justify-start gap-1"
      role="group"
      aria-label="Waveform preview"
    >
      <div
        class="mr-1 inline-flex shrink-0 items-center"
        role="radiogroup"
        aria-label="Waveform scrolling"
      >
        <Tooltip content={() => "Waveform scrolling mode"}>
          <span
            class="inline-flex size-7 items-center justify-center rounded-l border border-r-0 border-neutral-700 bg-neutral-900 text-neutral-400"
            role="img"
            aria-label="Waveform scrolling mode"
          >
            <MouseScrollIcon class="size-4" aria-hidden />
          </span>
        </Tooltip>
        <Tooltip
          content={() =>
            "Fixture: scroll fixture playheads across a fixed waveform"
          }
        >
          <button
            type="button"
            role="radio"
            aria-label="Fixture"
            aria-checked={!props.centerSelectedFixture}
            class={`${viewButtonClass} border-r-0`}
            onClick={() => props.onCenterSelectedFixtureChange(false)}
          >
            Fixture
          </button>
        </Tooltip>
        <Tooltip
          content={() =>
            "Waveform: scroll the waveform beneath the selected fixture"
          }
        >
          <button
            type="button"
            role="radio"
            aria-label="Waveform"
            aria-checked={props.centerSelectedFixture}
            class={`${viewButtonClass} rounded-r`}
            onClick={() => props.onCenterSelectedFixtureChange(true)}
          >
            Waveform
          </button>
        </Tooltip>
      </div>
      <ToolbarSeparator data-step-fx-waveform-scroll-separator />
      <label class="flex shrink-0 items-center gap-1 text-[11px] text-neutral-400">
        <Checkbox
          aria-label="Show all waveform playheads"
          checked={props.showAllPlayheads}
          disabled={
            props.showAllPlayheadsLocked ||
            props.showAllPlayheadsDisabledReason !== undefined
          }
          onChange={(event) =>
            props.onShowAllPlayheadsChange(event.currentTarget.checked)
          }
        />
        <span>Show all</span>
      </label>
      <Show when={props.showAllPlayheadsDisabledReason}>
        {(reason) => (
          <Tooltip content={() => reason()} position="bottom">
            <span
              class="mr-1 inline-flex size-5 shrink-0 items-center justify-center rounded text-amber-300 outline-none focus-visible:ring-1 focus-visible:ring-amber-300"
              role="img"
              aria-label={reason()}
              tabindex="0"
              data-step-fx-show-all-warning
            >
              <WarningIcon class="size-4" weight="fill" aria-hidden />
            </span>
          </Tooltip>
        )}
      </Show>
      {props.samplingWarning}
      <Show
        when={props.markers.length > 0}
        fallback={
          <span class="text-xs text-neutral-500">
            Selection order unavailable or empty
          </span>
        }
      >
        <Show
          when={props.markers.length <= 8}
          fallback={
            <Tooltip
              content={() =>
                stepFxPreviewIndexTitle(
                  props.markers,
                  props.selectedIndex,
                  props.phase,
                )
              }
            >
              <label class="flex h-6 items-center rounded border border-neutral-700 bg-neutral-900 px-1 text-[10px] text-neutral-300">
                <Input
                  density="compact"
                  aria-label="Waveform preview index"
                  aria-description={stepFxPreviewIndexTitle(
                    props.markers,
                    props.selectedIndex,
                    props.phase,
                  )}
                  type="number"
                  min="1"
                  max={props.markers.length}
                  class="h-5 w-10 bg-transparent text-right text-amber-200 outline-none"
                  value={props.selectedIndex + 1}
                  onInput={(event) =>
                    props.onSelectIndex(
                      Math.max(
                        0,
                        Math.min(
                          props.markers.length - 1,
                          Math.floor(Number(event.currentTarget.value)) - 1,
                        ),
                      ),
                    )
                  }
                />
                <span class="px-1">/ {props.markers.length}</span>
              </label>
            </Tooltip>
          }
        >
          <For each={indexes()}>
            {(index) => {
              /** Describes the fixtures and phase offset this index previews. */
              const description = () =>
                stepFxPreviewIndexTitle(props.markers, index, props.phase);
              return (
                <Tooltip content={description}>
                  <button
                    type="button"
                    class="flex h-6 min-w-10 shrink-0 items-center justify-center rounded border px-1 text-[10px]"
                    classList={{
                      "border-amber-400/70 bg-amber-400/15 text-amber-100":
                        props.selectedIndex === index,
                      "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]":
                        props.selectedIndex !== index,
                    }}
                    aria-pressed={props.selectedIndex === index}
                    aria-description={description()}
                    data-step-fx-preview-index={index}
                    onClick={() => props.onSelectIndex(index)}
                  >
                    <span>{index + 1}</span>
                    <span class="ml-1 opacity-80">
                      {formatStepFxDegrees(
                        stepFxPhaseOffset(
                          props.phase,
                          index,
                          props.markers.length,
                        ),
                      )}
                    </span>
                  </button>
                </Tooltip>
              );
            }}
          </For>
        </Show>
      </Show>
      <Show when={props.issues.length > 0}>
        <div class="ml-auto shrink-0">
          <Tooltip content={() => props.issues.join("\n")} position="bottom">
            <span
              class="rounded text-[11px] text-amber-300 outline-none focus-visible:ring-1 focus-visible:ring-amber-300"
              tabindex="0"
              aria-description={props.issues.join("\n")}
              data-step-fx-selection-warning
            >
              Selection warning
            </span>
          </Tooltip>
        </div>
      </Show>
    </div>
  );
}
