// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { For, type JSX } from "solid-js";
import { ScrollArea } from "../../../components/ui/scroll-area";
import {
  commandFailureMessage,
  commandSucceeded,
} from "../../../lib/command-result";
import { commandClient } from "../../../lib/engine-commands";
import { engineRuntime } from "../../../lib/engine-runtime";
import {
  armedLaunches,
  faders,
  masters,
  pushToast,
} from "../../../state/appStores";
import {
  type Clip,
  FaderButtonMode,
  type FaderCommand,
  type FaderUpdate,
  type Master,
} from "../../../types";
import {
  faderButtonControl,
  faderGoControl,
  faderLevelControl,
} from "../model/fader-actions";
import { Fader } from "./fader";

export interface FadersProps {
  /** Number of faders to display (default: 10) */
  faderCount?: number;
  /** Clip states map: clip UID -> [Clip, isActive] */
  clipStates: () => Record<string, [Clip, boolean]>;
}

/** Arranges fader strips to fill the section while scrolling horizontally. */
export function Faders(props: FadersProps): JSX.Element {
  /** Returns the configured number of visible faders. */
  const faderCount = () => props.faderCount ?? 10;
  const $faders = useStore(faders);
  const $masters = useStore(masters);
  const $armedLaunches = useStore(armedLaunches);

  /** Sends a tracked fader command and surfaces backend or transport failure. */
  const sendCommand = async (command: FaderCommand): Promise<void> => {
    try {
      const result = await commandClient.invoke("FaderCommand", command);
      if (!commandSucceeded(result)) {
        pushToast("error", commandFailureMessage(result));
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Fader command failed";
      pushToast("error", message);
    }
  };

  /** Sends a continuous fader update without command lifecycle bookkeeping. */
  const sendUpdate = (update: FaderUpdate): void => {
    engineRuntime.sendUpdate("FaderUpdate", update, false);
  };

  return (
    <ScrollArea
      class="faders h-full min-h-0"
      viewportClass="flex h-full gap-1 pb-2"
    >
      <For each={Array.from({ length: faderCount() }, (_, i) => i + 1)}>
        {(faderIndex) => {
          /** Returns the backend snapshot for this fader. */
          const getFaderState = () =>
            $faders().find((fader) => fader.index === faderIndex);

          /** Returns the assigned clip tuple and active state when present. */
          const getAssignedClipEntry = () => {
            const assignedClipId = getFaderState()?.assigned_clip_id;
            if (assignedClipId === undefined) return undefined;
            const states = props.clipStates();
            return Object.values(states).find(
              ([clip]) => clip.identifiers.id === assignedClipId,
            );
          };

          /** Returns the clip assigned to this fader when present. */
          const getAssignedClip = () => getAssignedClipEntry()?.[0];

          /** Returns the master assigned to this fader when present. */
          const getAssignedMaster = (): Master | undefined => {
            const assignedMasterId = getFaderState()?.assigned_master_id;
            if (assignedMasterId === undefined) return undefined;
            return Object.values($masters()).find(
              (master) => master.identifiers.id === assignedMasterId,
            );
          };

          /** Returns whether the assigned clip is currently active. */
          const isClipActive = () => getAssignedClipEntry()?.[1] ?? false;

          /** Returns what the assigned clip does when its armed launch fires, if it waits. */
          const armedLaunch = () => {
            const clipId = getFaderState()?.assigned_clip_id;
            return clipId === undefined || clipId === null
              ? undefined
              : $armedLaunches()[clipId]?.action;
          };

          return (
            <Fader
              index={faderIndex}
              assignedClip={getAssignedClip()}
              assignedMaster={getAssignedMaster()}
              isClipActive={isClipActive()}
              armedLaunch={armedLaunch()}
              displayValue={getFaderState()?.display_value ?? 0}
              hardwareValue={getFaderState()?.hardware_value ?? undefined}
              consoleValue={getFaderState()?.console_value ?? 0}
              button={faderButtonControl(faderIndex, sendCommand)}
              goChoice={faderGoControl(faderIndex)}
              buttonMode={getFaderState()?.button_mode ?? FaderButtonMode.Go}
              availableButtonModes={
                getFaderState()?.available_button_modes ?? []
              }
              isFlashing={getFaderState()?.is_flashing ?? false}
              heldButton={getFaderState()?.held_button ?? undefined}
              onButtonModeChange={(mode) =>
                sendCommand({
                  type: "SetButtonMode",
                  data: { fader_index: faderIndex, mode },
                })
              }
              level={faderLevelControl(faderIndex, sendUpdate)}
              onClipAssign={(clip) =>
                sendCommand({
                  type: "AssignClip",
                  data: {
                    fader_index: faderIndex,
                    clip_id: clip.identifiers.id,
                  },
                })
              }
              onMasterAssign={(master) =>
                sendCommand({
                  type: "AssignMaster",
                  data: {
                    fader_index: faderIndex,
                    master_id: master.identifiers.id,
                  },
                })
              }
              onClipClear={() =>
                sendCommand({
                  type: "ClearClip",
                  data: { fader_index: faderIndex },
                })
              }
            />
          );
        }}
      </For>
    </ScrollArea>
  );
}
