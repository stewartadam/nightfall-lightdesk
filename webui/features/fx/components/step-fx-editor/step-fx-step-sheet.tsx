// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { For, Show } from "solid-js";
import { Checkbox, Input } from "../../../../components/ui/form-controls";
import { RangeSlider } from "../../../../components/ui/range-slider";
import { Table } from "../../../../components/ui/table";
import type * as types from "../../../../types";
import type { StepFxEditorViewController } from "../../controllers/step-fx-editor-view-controller";
import {
  formatStepFxTarget,
  formatStepFxWidthBeats,
  isStepFxWaveformRampDrag,
  isStepFxWaveformValueDrag,
  isStepFxWaveformWidthDrag,
  parseStepFxTarget,
  roundStepFxWidthBeats,
  setStepFxTargetValue,
  stepFxTargetValue,
  stepFxWaveformRampDragPoint,
} from "../../model/step-fx-editor-model";
import { StepFxCurveSelect } from "./step-fx-curve-select";
import { STEP_FX_FIELD_CLASS } from "./step-fx-editor-styles";

/** Renders the editable step table for the active contribution track. */
export function StepFxStepSheet(props: {
  editor: StepFxEditorViewController;
  track: types.FxTrack;
}) {
  const { selection, edit } = props.editor;

  /** Reports whether one value cell owns the active waveform drag. */
  const isValueDrag = (stepUid: string) =>
    isStepFxWaveformValueDrag(props.editor.waveformDragTarget(), stepUid);
  /** Reports whether one ramp range owns the active waveform drag. */
  const isRampDrag = (stepUid: string) =>
    isStepFxWaveformRampDrag(props.editor.waveformDragTarget(), stepUid);
  /** Returns which endpoint of one ramp range owns the active waveform drag. */
  const rampDragPoint = (stepUid: string) =>
    stepFxWaveformRampDragPoint(props.editor.waveformDragTarget(), stepUid);
  /** Reports whether one width cell participates in the active boundary drag. */
  const isWidthDrag = (stepUid: string) =>
    isStepFxWaveformWidthDrag(props.editor.waveformDragTarget(), stepUid);

  return (
    <Table
      class="w-full table-fixed border-collapse text-sm"
      data-step-fx-sheet
    >
      <colgroup>
        <Show when={selection.selectionMode()}>
          <col class="w-8" />
        </Show>
        <col class="w-10" />
        <col class="w-28" />
        <col class="w-20" />
        <col />
        <col class="w-28" />
      </colgroup>
      <thead class="sticky top-0 z-10 bg-neutral-900 text-left text-xs text-neutral-400">
        <tr>
          <Show when={selection.selectionMode()}>
            <th class="p-2"></th>
          </Show>
          <th class="p-2">Step</th>
          <th class="p-2">Value</th>
          <th class="p-2">Beats</th>
          <th class="p-2">Ramp duration</th>
          <th class="p-2">Curve</th>
        </tr>
      </thead>
      <tbody>
        <For each={selection.stepRows}>
          {(step, index) => {
            /** Returns the validation prefix for this authored row. */
            const path = () => props.editor.stepIssuePath(index());
            /** Reports whether any localized error belongs to this row. */
            const rowInvalid = () => props.editor.stepHasIssues(index());
            return (
              <tr
                class="border-t border-neutral-800 transition-shadow duration-200 ease-out motion-reduce:transition-none"
                classList={{
                  "bg-[var(--accent-soft)]": selection
                    .selectedStepUids()
                    .has(step.uid),
                  "ring-1 ring-inset ring-amber-300/70":
                    props.editor.liveStepUid() === step.uid,
                  "bg-red-950/20": rowInvalid(),
                }}
                aria-current={
                  props.editor.liveStepUid() === step.uid ? "step" : undefined
                }
                data-step-fx-step-row
                data-step-index={index()}
                data-live={
                  props.editor.liveStepUid() === step.uid ? "true" : undefined
                }
              >
                <Show when={selection.selectionMode()}>
                  <td class="p-2 text-center">
                    <Checkbox
                      aria-label={`Select step ${index() + 1}`}
                      checked={selection.selectedStepUids().has(step.uid)}
                      onChange={(event) =>
                        selection.setSelectedStepUids((currentSelection) => {
                          const next = new Set(currentSelection);
                          if (event.currentTarget.checked) next.add(step.uid);
                          else next.delete(step.uid);
                          return next;
                        })
                      }
                    />
                  </td>
                </Show>
                <td class="p-2 font-mono text-neutral-400">{index() + 1}</td>
                <td class="p-2">
                  <div
                    class="flex w-full items-stretch overflow-hidden rounded border border-neutral-700 bg-neutral-900 focus-within:border-[var(--accent)]"
                    data-step-fx-value-field
                    data-waveform-drag-active={
                      isValueDrag(step.uid) ? "true" : undefined
                    }
                    classList={{
                      "border-red-500": props.editor
                        .issuesByPath()
                        .has(`${path()}.target`),
                      "border-amber-300 bg-amber-400/15 ring-1 ring-inset ring-amber-300/70":
                        isValueDrag(step.uid),
                    }}
                  >
                    <Input
                      density="compact"
                      aria-label={`Step ${index() + 1} value`}
                      type="number"
                      step="0.1"
                      class="min-w-0 w-full appearance-none border-0 bg-transparent px-2 py-1.5 text-right text-sm text-neutral-100 focus:outline-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                      value={formatStepFxTarget(step.target)}
                      onChange={(event) => {
                        const parsed = parseStepFxTarget(
                          event.currentTarget.value,
                          selection.trackKind(),
                        );
                        if (!parsed) {
                          // Rows stay mounted across edits, so restore the authored text.
                          event.currentTarget.value = formatStepFxTarget(
                            step.target,
                          );
                          return;
                        }
                        edit.editSteps(props.track, step.uid, (candidate) => ({
                          ...candidate,
                          blueprint_uid: undefined,
                          target: setStepFxTargetValue(
                            parsed,
                            stepFxTargetValue(parsed),
                            selection.trackKind(),
                          ),
                        }));
                        // Normalized input can leave the target unchanged, which skips Solid's DOM update.
                        event.currentTarget.value = formatStepFxTarget(
                          step.target,
                        );
                      }}
                    />
                    <span class="inline-flex items-center border-l border-neutral-700 px-2 text-xs text-neutral-500">
                      %
                    </span>
                  </div>
                </td>
                <td class="p-2">
                  <Input
                    density="compact"
                    aria-label={`Step ${index() + 1} width`}
                    type="number"
                    step="0.001"
                    class={`${STEP_FX_FIELD_CLASS} w-full`}
                    data-waveform-drag-active={
                      isWidthDrag(step.uid) ? "true" : undefined
                    }
                    classList={{
                      "border-red-500": props.editor
                        .issuesByPath()
                        .has(`${path()}.width_beats`),
                      "border-amber-300 bg-amber-400/15 ring-1 ring-inset ring-amber-300/70":
                        isWidthDrag(step.uid),
                    }}
                    value={formatStepFxWidthBeats(step.width_beats)}
                    onChange={(event) => {
                      const value = event.currentTarget.valueAsNumber;
                      if (!Number.isFinite(value)) {
                        // An emptied field is not an authored width; restore the current one.
                        event.currentTarget.value = formatStepFxWidthBeats(
                          step.width_beats,
                        );
                        return;
                      }
                      edit.editSteps(props.track, step.uid, (candidate) => ({
                        ...candidate,
                        width_beats: roundStepFxWidthBeats(value),
                      }));
                      // Rounding can leave the width unchanged, which skips Solid's DOM update.
                      event.currentTarget.value = formatStepFxWidthBeats(
                        step.width_beats,
                      );
                    }}
                  />
                </td>
                <td class="p-2">
                  <div
                    class="flex min-w-0 items-center gap-2 rounded"
                    data-step-fx-ramp-field
                    data-waveform-drag-active={
                      isRampDrag(step.uid) ? "true" : undefined
                    }
                    data-waveform-ramp-drag-point={rampDragPoint(step.uid)}
                    classList={{
                      "bg-amber-400/15 ring-1 ring-inset ring-amber-300/70":
                        isRampDrag(step.uid),
                    }}
                  >
                    <RangeSlider
                      mode="range"
                      value={[
                        step.transition.start * 100,
                        step.transition.end * 100,
                      ]}
                      min={0}
                      max={100}
                      step={1}
                      showPips={false}
                      showInputs={false}
                      containerClass="ml-0 min-w-8 flex-1"
                      handleLabels={[
                        `Step ${index() + 1} ramp start`,
                        `Step ${index() + 1} ramp end`,
                      ]}
                      onChange={([start, end]: [number, number]) =>
                        edit.editSteps(props.track, step.uid, (candidate) => ({
                          ...candidate,
                          transition: {
                            start: start / 100,
                            end: end / 100,
                          },
                        }))
                      }
                    />
                    <span class="w-10 shrink-0 whitespace-nowrap text-right text-[11px] tabular-nums">
                      {Math.round(step.transition.start * 100)}–
                      {Math.round(step.transition.end * 100)}%
                    </span>
                  </div>
                </td>
                <td class="p-2">
                  <StepFxCurveSelect
                    stepNumber={index() + 1}
                    curve={step.curve}
                    onChange={(curve) =>
                      edit.editSteps(props.track, step.uid, (candidate) => ({
                        ...candidate,
                        curve,
                      }))
                    }
                  />
                </td>
              </tr>
            );
          }}
        </For>
      </tbody>
    </Table>
  );
}
