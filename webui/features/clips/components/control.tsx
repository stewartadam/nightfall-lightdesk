// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { CaretDownIcon } from "@squidlab/phosphor-solid/caret-down";
import { createSignal, For, type JSX, onCleanup, Show } from "solid-js";
import {
  DropdownMenu,
  DropdownMenuItem,
} from "../../../components/ui/dropdown-menu";
import { VerticalRangeSlider } from "../../../components/ui/vertical-range-slider";
import { Button } from "../../../components/ui/visual-language/button";
import { shouldShowDisparateControlValues } from "../../../lib/control-display";
import { getLogger } from "../../../lib/logger";
import {
  type Clip,
  ControlButtonMode,
  type HeldButtonEffect,
  type Master,
  MasterKind,
} from "../../../types";
import type { EngineControl } from "../../actions";
import { Mappable, type MappableChoice } from "../../io";
import { masterLevelControl } from "../../masters";
import { CONTROL_BUTTON_MODE_TEXT } from "../model/control-button-modes";
import { HeldButtonBadge } from "./held-button-badge";

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
  /** Position of the slot's physical fader, absent when no physical fader drives the slot */
  hardwareValue: number | undefined;
  /** Backend-authored console value */
  consoleValue: number;
  /** The slot's button: its press and release and its controller binding. */
  button: EngineControl<{ press: () => void; release: () => void }>;
  /** Mapping-only choice that always runs Go, whatever the button mode. */
  goChoice: EngineControl;
  /** Backend-authored mode deciding what the slot's button does. */
  buttonMode: ControlButtonMode;
  /** Backend-authored modes the slot's current assignment supports. */
  availableButtonModes: ControlButtonMode[];
  /** Whether a Flash or Swop is held on the slot, from this or any other surface. */
  isFlashing: boolean;
  /** How a held Flash or Swop changes the slot's playback, if any does. */
  heldButton: HeldButtonEffect | undefined;
  /** Called when a different button mode is picked. */
  onButtonModeChange: (mode: ControlButtonMode) => void;
  /** The slot's fader: its on-screen drag and its controller binding. */
  fader: EngineControl<{ setConsoleValue: (value: number) => void }>;
  /** Called when a clip is dropped onto this control */
  onClipAssign: (clip: Clip) => void;
  /** Called when a master is dropped onto this control */
  onMasterAssign: (master: Master) => void;
  /** Called when the assigned clip is cleared */
  onClipClear: () => void;
}

const log = getLogger(import.meta.url);

/** Renders a full-height fader strip with fixed-size assignment and playback actions. */
export function Control(props: ControlProps): JSX.Element {
  const [isDragOver, setIsDragOver] = createSignal(false);

  /** Whether a Swop held on another slot is taking this slot's playback out of the output. */
  const isSwoppedOut = () => props.heldButton?.type === "SwoppedOut";

  /** Returns whether the backend and control positions differ visibly. */
  const showDisparateValues = () =>
    shouldShowDisparateControlValues(props.hardwareValue, props.consoleValue);

  /** Returns the actions this fader can be mapped to: its slot, or the assigned master. */
  const faderChoices = (): MappableChoice[] => {
    const master = props.assignedMaster;
    return master
      ? [
          props.fader,
          masterLevelControl(
            master,
            `Assigned master: ${master.identifiers.label}`,
          ),
        ]
      : [props.fader];
  };

  /** Returns whether the slot's button has something to act on. */
  const canPress = () =>
    !!props.assignedClip?.source ||
    (!!props.assignedMaster && props.buttonMode === ControlButtonMode.Flash) ||
    props.assignedMaster?.mode?.type === "Toggle";

  /** Whether this button sent a press that still needs its release. */
  let isHeld = false;

  /** Sends the press edge once, ignoring repeats while the button is already held. */
  const pressButton = () => {
    if (isHeld || !canPress()) return;
    isHeld = true;
    props.button.handlers.press();
  };

  /** Sends the release edge for a press this button sent, if any. */
  const releaseButton = () => {
    if (!isHeld) return;
    isHeld = false;
    props.button.handlers.release();
  };

  /** Presses on the primary pointer button, capturing the pointer so the release is seen. */
  const handlePointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    pressButton();
  };

  /** Presses on Enter or Space, ignoring key repeat. */
  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    if (!event.repeat) pressButton();
  };

  /** Releases on Enter or Space. */
  const handleKeyUp = (event: KeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    releaseButton();
  };

  /**
   * Presses and releases for activations that arrive only as a click, such as a screen
   * reader's activate action. Pointer clicks report a click count and keyboard clicks are
   * suppressed by the key handlers, so both already sent their edges.
   */
  const handleClick = (event: MouseEvent) => {
    if (event.detail !== 0) return;
    pressButton();
    releaseButton();
  };

  onCleanup(releaseButton);

  /** Returns the text for the slot's current button mode. */
  const modeText = () => CONTROL_BUTTON_MODE_TEXT[props.buttonMode];

  /** Explains what the button does now, or what it needs before it can act. */
  const buttonTitle = () => {
    if (props.assignedMaster) {
      if (props.buttonMode === ControlButtonMode.Flash) {
        return modeText().description;
      }
      return props.assignedMaster.mode?.type === "Toggle"
        ? "Toggle this master"
        : "Only toggle-mode masters respond to the button";
    }
    if (!props.assignedClip) return "Assign a clip to enable the button";
    if (!props.assignedClip.source)
      return "Assign a source to enable the button";
    return modeText().description;
  };

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
      data-control-held-button={props.heldButton?.type}
      class={`control h-full min-h-0 flex flex-col items-center gap-2 p-2 rounded-lg transition-colors ${
        isDragOver()
          ? "bg-blue-900/50 ring-2 ring-blue-500"
          : isSwoppedOut()
            ? "bg-neutral-800 ring-1 ring-amber-500/60"
            : "bg-neutral-800"
      }`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Vertical slider */}
      <Mappable
        class="flex min-h-0 flex-1 w-full justify-center pb-2 pt-1"
        label={`control ${props.index} fader`}
        choices={faderChoices}
      >
        <Show
          when={props.assignedClip || props.assignedMaster}
          fallback={
            <VerticalRangeSlider
              value={props.displayValue}
              onChange={props.fader.handlers.setConsoleValue}
              min={0}
              max={100}
              step={1}
              tickCount={11}
              height="100%"
              markerValue={
                showDisparateValues() ? props.hardwareValue : undefined
              }
              disabled={true}
            />
          }
        >
          <VerticalRangeSlider
            value={props.displayValue}
            onChange={props.fader.handlers.setConsoleValue}
            min={0}
            max={100}
            step={1}
            tickCount={11}
            height="100%"
            markerValue={
              showDisparateValues() ? props.hardwareValue : undefined
            }
            disabled={false}
          />
        </Show>
      </Mappable>

      {/* Current value display */}
      <div
        data-control-value-index={props.index}
        class="w-full shrink-0 text-center"
      >
        <Show
          when={!isSwoppedOut()}
          fallback={<HeldButtonBadge effect={props.heldButton} />}
        >
          <div class="text-xs text-neutral-400 font-mono">{valueLabel()}</div>
        </Show>
      </div>

      {/* Clip label / drop zone */}
      <div
        data-clip-dropzone-index={props.index}
        class={`w-full shrink-0 min-h-[40px] rounded text-center text-xs flex items-center justify-center relative ${
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
              tooltipClass="absolute top-0.5 right-0.5"
              style={{ width: "20px", height: "20px" }}
              aria-label="Clear assignment"
              onClick={handleClearClick}
              tooltip="Clear assignment"
            >
              ×
            </Button>
          </div>
        </Show>
      </div>
      <Mappable
        class="w-full shrink-0"
        label={`control ${props.index} button`}
        choices={() => [props.button, props.goChoice]}
      >
        <Button
          size="compact"
          type="button"
          data-control-button-index={props.index}
          data-control-button-mode={props.buttonMode}
          data-control-button-flashing={props.isFlashing}
          aria-label={`${modeText().label} control ${props.index}`}
          variant={props.isFlashing ? "primary" : "secondary"}
          class="w-full px-1!"
          disabled={!canPress()}
          onPointerDown={handlePointerDown}
          onPointerUp={releaseButton}
          onPointerCancel={releaseButton}
          onLostPointerCapture={releaseButton}
          onKeyDown={handleKeyDown}
          onKeyUp={handleKeyUp}
          onClick={handleClick}
          onBlur={releaseButton}
          tooltip={buttonTitle()}
          tooltipClass="block w-full"
        >
          {modeText().label}
        </Button>
      </Mappable>
      {/* Control number, with the button mode menu beside it */}
      <div class="grid w-full shrink-0 grid-cols-[1fr_auto_1fr] items-center text-xs font-medium text-neutral-500">
        <span />
        <span>{props.index}</span>
        <DropdownMenu
          align="end"
          triggerLabel={`Button mode of control ${props.index}`}
          triggerTitle="Choose what the button does"
          triggerVariant="subtle"
          triggerSize="inline"
          triggerClass="ml-auto"
          contentLabel={`Button mode of control ${props.index}`}
          trigger={<CaretDownIcon class="size-3" aria-hidden />}
        >
          <div class="py-0.5" data-menu-kind="control-button-mode">
            <For each={props.availableButtonModes}>
              {(mode) => (
                <DropdownMenuItem
                  checked={props.buttonMode === mode}
                  onClick={() => {
                    if (mode !== props.buttonMode) {
                      props.onButtonModeChange(mode);
                    }
                  }}
                >
                  <span
                    class="flex min-w-0 flex-col"
                    data-control-button-mode-option={mode}
                  >
                    <span>{CONTROL_BUTTON_MODE_TEXT[mode].label}</span>
                    <span class="text-[11px] text-neutral-400">
                      {CONTROL_BUTTON_MODE_TEXT[mode].description}
                    </span>
                  </span>
                </DropdownMenuItem>
              )}
            </For>
          </div>
        </DropdownMenu>
      </div>
    </div>
  );
}
