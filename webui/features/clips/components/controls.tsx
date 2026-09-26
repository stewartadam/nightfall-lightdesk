// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { For, type JSX } from "solid-js";
import { CommandClient } from "../../../lib/command-client";
import {
  commandFailureMessage,
  commandSucceeded,
} from "../../../lib/command-result";
import { engineRuntime } from "../../../lib/engine-runtime";
import { controls, masters, pushToast } from "../../../state/appStores";
import type {
  Clip,
  ControlCommand,
  ControlUpdate,
  Master,
} from "../../../types";
import { Control } from "./control";

const commandClient = new CommandClient(engineRuntime);

export interface ControlsProps {
  /** Number of controls to display (default: 10) */
  controlCount?: number;
  /** Clip states map: clip UID -> [Clip, isActive] */
  clipStates: () => Record<string, [Clip, boolean]>;
}

/** Arranges fader strips to fill the section while scrolling horizontally. */
export function Controls(props: ControlsProps): JSX.Element {
  /** Returns the configured number of visible controls. */
  const controlCount = () => props.controlCount ?? 10;
  const $controls = useStore(controls);
  const $masters = useStore(masters);

  /** Sends a tracked control assignment command and surfaces backend or transport failure. */
  const sendCommand = async (command: ControlCommand): Promise<void> => {
    try {
      const result = await commandClient.submitCommand(
        "ControlCommand",
        command,
      );
      if (!commandSucceeded(result)) {
        pushToast("error", commandFailureMessage(result));
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Control command failed";
      pushToast("error", message);
    }
  };

  /** Sends a continuous control update without command lifecycle bookkeeping. */
  const sendUpdate = (update: ControlUpdate): void => {
    engineRuntime.sendUpdate("ControlUpdate", update, false);
  };

  return (
    <div class="controls h-full min-h-0">
      <div class="flex h-full min-h-0 gap-1 overflow-x-auto pb-2">
        <For each={Array.from({ length: controlCount() }, (_, i) => i + 1)}>
          {(controlIndex) => {
            /** Returns the backend snapshot for this control slot. */
            const getControlState = () =>
              $controls().find((control) => control.index === controlIndex);

            /** Returns the assigned clip tuple and active state when present. */
            const getAssignedClipEntry = () => {
              const assignedClipId = getControlState()?.assigned_clip_id;
              if (assignedClipId === undefined) return undefined;
              const states = props.clipStates();
              return Object.values(states).find(
                ([clip]) => clip.identifiers.id === assignedClipId,
              );
            };

            /** Returns the clip assigned to this control when present. */
            const getAssignedClip = () => getAssignedClipEntry()?.[0];

            /** Returns the master assigned to this control when present. */
            const getAssignedMaster = (): Master | undefined => {
              const assignedMasterId = getControlState()?.assigned_master_id;
              if (assignedMasterId === undefined) return undefined;
              return Object.values($masters()).find(
                (master) => master.identifiers.id === assignedMasterId,
              );
            };

            /** Returns whether the assigned clip is currently active. */
            const isClipActive = () => getAssignedClipEntry()?.[1] ?? false;

            /** Activates the backend's current assignment for this control slot. */
            const handleGo = () => {
              void sendCommand({
                type: "Go",
                data: { control_index: controlIndex },
              });
            };

            return (
              <Control
                index={controlIndex}
                assignedClip={getAssignedClip()}
                assignedMaster={getAssignedMaster()}
                isClipActive={isClipActive()}
                displayValue={getControlState()?.display_value ?? 0}
                hardwareValue={getControlState()?.hardware_value ?? 0}
                consoleValue={getControlState()?.console_value ?? 0}
                onGo={handleGo}
                onConsoleValueChange={(value) =>
                  sendUpdate({
                    type: "SetConsoleValue",
                    data: { control_index: controlIndex, value },
                  })
                }
                onClipAssign={(clip) =>
                  sendCommand({
                    type: "AssignClip",
                    data: {
                      control_index: controlIndex,
                      clip_id: clip.identifiers.id,
                    },
                  })
                }
                onMasterAssign={(master) =>
                  sendCommand({
                    type: "AssignMaster",
                    data: {
                      control_index: controlIndex,
                      master_id: master.identifiers.id,
                    },
                  })
                }
                onClipClear={() =>
                  sendCommand({
                    type: "ClearClip",
                    data: { control_index: controlIndex },
                  })
                }
              />
            );
          }}
        </For>
      </div>
    </div>
  );
}
