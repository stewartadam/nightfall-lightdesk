// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createSignal, type JSX, Show } from "solid-js";
import { VerticalRangeSlider } from "../../../components/ui/vertical-range-slider";
import { Button } from "../../../components/ui/visual-language/button";
import { shouldShowDisparateControlValues } from "../../../lib/control-display";
import { getLogger } from "../../../lib/logger";
import { type Clip, type Master, MasterKind } from "../../../types";

export interface ControlProps {
  /** Control index (1-based for display) */
  index: number;
  /** Currently assigned clip, if any */
  assignedClip?: Clip;
  /** Currently assigned master, if any */
  assignedMaster?: Master;
  /** Whether the assigned clip is currently active */
  isClipActive: boolean;
  /** Backend-authored display value */
  displayValue: number;
  /** Backend-authored hardware value */
  hardwareValue: number;
  /** Backend-authored console value */
  consoleValue: number;
  /** Called when the control go button is pressed */
  onGo: () => void;
  /** Called when control value changes */
  onConsoleValueChange: (value: number) => void;
  /** Called when a clip is dropped onto this control */
  onClipAssign: (clip: Clip) => void;
  /** Called when a master is dropped onto this control */
  onMasterAssign: (master: Master) => void;
  /** Called when the assigned clip is cleared */
  onClipClear: () => void;
}

const log = getLogger(import.meta.url);

export function Control(props: ControlProps): JSX.Element {
  const [isDragOver, setIsDragOver] = createSignal(false);

  /** Returns whether the backend and control positions differ visibly. */
  const showDisparateValues = () =>
    shouldShowDisparateControlValues(props.hardwareValue, props.consoleValue);

  /** Returns whether the Go button has an assigned action. */
  const canGo = () =>
    !!props.assignedClip?.source ||
    props.assignedMaster?.mode?.type === "Toggle";

  /** Returns the value label for the assigned control target. */
  const valueLabel = () => {
    if (props.assignedMaster?.kind === MasterKind.PlaybackRate) {
      return `${Math.round(props.displayValue * 2)}%`;
    }
    return `${Math.round(props.displayValue)}%`;
  };

  /** Tracks valid clip or master drag payloads over the control. */
  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    const data =
      e.dataTransfer?.types.includes("application/x-clip") ||
      e.dataTransfer?.types.includes("application/x-master");
    if (data) {
      setIsDragOver(true);
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = "copy";
      }
    }
  };

  /** Clears drag-over presentation when the pointer leaves the control. */
  const handleDragLeave = () => {
    setIsDragOver(false);
  };

  /** Assigns a dropped clip or master payload to this control. */
  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);

    const clipData = e.dataTransfer?.getData("application/x-clip");
    if (clipData) {
      try {
        const clip = JSON.parse(clipData) as Clip;
        props.onClipAssign(clip);
      } catch {
        log.error("Failed to parse clip data");
      }
      return;
    }

    const masterData = e.dataTransfer?.getData("application/x-master");
    if (masterData) {
      try {
        const master = JSON.parse(masterData) as Master;
        props.onMasterAssign(master);
      } catch {
        log.error("Failed to parse master data");
      }
    }
  };

  /** Clears the current control assignment without triggering parent clicks. */
  const handleClearClick = (e: MouseEvent) => {
    e.stopPropagation();
    props.onClipClear();
  };

  return (
    <div
      data-control-index={props.index}
      class={`control flex flex-col items-center gap-2 p-2 rounded-lg transition-colors ${
        isDragOver() ? "bg-blue-900/50 ring-2 ring-blue-500" : "bg-neutral-800"
      }`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Vertical slider */}
      <div class="flex w-full justify-center pb-2 pt-1">
        <Show
          when={props.assignedClip || props.assignedMaster}
          fallback={
            <VerticalRangeSlider
              value={props.displayValue}
              onChange={props.onConsoleValueChange}
              min={0}
              max={100}
              step={1}
              tickCount={11}
              height={160}
              markerValue={
                showDisparateValues() ? props.hardwareValue : undefined
              }
              disabled={true}
            />
          }
        >
          <VerticalRangeSlider
            value={props.displayValue}
            onChange={props.onConsoleValueChange}
            min={0}
            max={100}
            step={1}
            tickCount={11}
            height={160}
            markerValue={
              showDisparateValues() ? props.hardwareValue : undefined
            }
            disabled={false}
          />
        </Show>
      </div>

      {/* Current value display */}
      <div data-control-value-index={props.index} class="w-full text-center">
        <div class="text-xs text-neutral-400 font-mono">{valueLabel()}</div>
      </div>

      {/* Clip label / drop zone */}
      <div
        data-clip-dropzone-index={props.index}
        class={`w-full min-h-[40px] rounded text-center text-xs flex items-center justify-center relative ${
          props.assignedClip || props.assignedMaster
            ? "bg-neutral-700 text-neutral-200"
            : "bg-neutral-900 text-neutral-500 border border-dashed border-neutral-600"
        }`}
      >
        <Show
          when={props.assignedClip || props.assignedMaster}
          fallback={<span class="px-1">Drop target</span>}
        >
          <div class="flex flex-col items-center gap-0.5 py-1 px-1 w-full">
            <span class="font-medium truncate w-full">
              {props.assignedClip?.identifiers.id ??
                props.assignedMaster?.identifiers.id}
            </span>
            <span class="text-[10px] text-neutral-400 truncate w-full">
              {props.assignedClip?.identifiers.label ??
                props.assignedMaster?.identifiers.label}
            </span>
            <Button
              size="icon"
              variant="subtle"
              type="button"
              class="absolute top-0.5 right-0.5"
              style={{ width: "20px", height: "20px" }}
              aria-label="Clear assignment"
              onClick={handleClearClick}
              title="Clear assignment"
            >
              ×
            </Button>
          </div>
        </Show>
      </div>
      <Button
        size="compact"
        type="button"
        data-control-go-index={props.index}
        aria-label={`Go control ${props.index}`}
        class="w-full"
        disabled={!canGo()}
        onClick={props.onGo}
        title={
          !props.assignedClip
            ? props.assignedMaster?.mode?.type === "Toggle"
              ? "Toggle this master"
              : "Assign a clip to enable Go"
            : !props.assignedClip.source
              ? "Assign a source to enable Go"
              : props.assignedClip.source?.type === "Sequence" &&
                  props.isClipActive
                ? "Advance this sequence clip"
                : "Start this clip"
        }
      >
        Go
      </Button>
      {/* Control number */}
      <div class="text-xs text-neutral-500 font-medium">{props.index}</div>
    </div>
  );
}
