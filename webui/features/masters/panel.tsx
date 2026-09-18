// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { DotsSixVerticalIcon } from "@squidlab/phosphor-solid/dots-six-vertical";
import { createMemo, createSignal, For, type JSX, Show } from "solid-js";
import { useRevealObjectCapability } from "../../components/providers/panel-capabilities/context-core";
import { NativeSelect } from "../../components/ui/form-controls";
import { Table, TableEmptyRow, TableScroll } from "../../components/ui/table";
import { Button } from "../../components/ui/visual-language/button";
import type { BasePanelComponentProps } from "../../lib/panel-registry";
import { clips, groups, masters } from "../../state/appStores";
import * as types from "../../types";
import {
  allFixturesTarget,
  allInstancesTarget,
  buildSetMasterLevelCommand,
  buildSetMasterModeCommand,
  buildStoreMasterCommand,
  buildToggleMasterCommand,
  clipPlaybackTarget,
  groupTarget,
  masterLevelMax,
  modeKey,
  normalizeUid,
  sortedClips,
  sortedGroups,
  sortedMasters,
  targetLabel,
} from "./model/master-model";
import { newMasterUid, sendMasterCommand } from "./services/master-commands";

const MASTER_DRAG_TYPE = "application/x-master";

/** Renders the master/submaster management panel. */
export default function MastersPanel(
  props: BasePanelComponentProps,
): JSX.Element {
  const $masters = useStore(masters);
  const $groups = useStore(groups);
  const $clips = useStore(clips);
  const [selectedGroupUid, setSelectedGroupUid] = createSignal("");
  const [selectedMasterUid, setSelectedMasterUid] = createSignal<string | null>(
    null,
  );
  const [selectedClipIds, setSelectedClipIds] = createSignal<number[]>([]);
  /** Returns masters sorted by visible numeric ID for stable table ordering. */
  const masterList = createMemo(() => sortedMasters($masters()));
  /** Returns groups sorted by visible numeric ID for the target picker. */
  const groupList = createMemo(() => sortedGroups($groups()));
  /** Returns clips sorted by visible numeric ID for the target picker. */
  const clipList = createMemo(() => sortedClips($clips()));
  /** Returns masters keyed by normalized UID for palette reveal requests. */
  const masterByUid = createMemo(() => {
    const byUid = new Map<string, types.Master>();
    for (const master of masterList()) {
      byUid.set(normalizeUid(master.identifiers.uid), master);
    }
    return byUid;
  });

  /** Selects and reveals a master requested by the showfile object palette. */
  useRevealObjectCapability(
    props.id,
    (request) => {
      const uid = normalizeUid(request.uid);
      const master = masterByUid().get(uid);
      if (!master) return;
      setSelectedMasterUid(uid);
      setTimeout(() => {
        document
          .querySelector(`[data-master-uid="${uid}"]`)
          ?.scrollIntoView({ block: "nearest" });
      }, 0);
    },
    { accepts: (payload) => payload.type === "master" },
  );

  /** Creates an all-fixtures master from the panel toolbar. */
  const createGlobalMaster = () => {
    sendMasterCommand(
      buildStoreMasterCommand(
        $masters(),
        types.MasterKind.InhibitiveIntensity,
        allFixturesTarget(),
        "Global Master",
        newMasterUid(),
      ),
    );
  };

  /** Creates a group-targeted master for the selected group. */
  const createGroupMaster = () => {
    const groupUid = selectedGroupUid();
    const group = $groups()[groupUid];
    if (!group) return;
    sendMasterCommand(
      buildStoreMasterCommand(
        $masters(),
        types.MasterKind.InhibitiveIntensity,
        groupTarget(groupUid),
        `${group.identifiers.label} Master`,
        newMasterUid(),
      ),
    );
  };

  /** Creates a playback-rate master affecting all live instances. */
  const createGlobalRateMaster = () => {
    sendMasterCommand(
      buildStoreMasterCommand(
        $masters(),
        types.MasterKind.PlaybackRate,
        allInstancesTarget(),
        "Playback Rate Master",
        newMasterUid(),
      ),
    );
  };

  /** Creates a playback-rate master affecting selected clip instances. */
  const createClipRateMaster = () => {
    const clipIds = selectedClipIds();
    if (clipIds.length === 0) return;
    sendMasterCommand(
      buildStoreMasterCommand(
        $masters(),
        types.MasterKind.PlaybackRate,
        clipPlaybackTarget(clipIds),
        "Clip Rate Master",
        newMasterUid(),
      ),
    );
  };

  /** Starts a drag assignment payload for controls. */
  const handleDragStart = (master: types.Master, event: DragEvent) => {
    event.dataTransfer?.setData(MASTER_DRAG_TYPE, JSON.stringify(master));
    event.dataTransfer?.setData("text/plain", master.identifiers.label);
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "copy";
    }
  };

  return (
    <div class="flex h-full flex-col bg-neutral-950 text-neutral-100">
      <div class="flex flex-wrap items-end gap-2 border-b border-neutral-800 p-3">
        <Button size="compact" type="button" onClick={createGlobalMaster}>
          New intensity global
        </Button>
        <label class="flex w-48 shrink-0 flex-col gap-1 text-xs text-neutral-400">
          <span>Group</span>
          <NativeSelect
            density="compact"
            aria-label="Group"
            value={selectedGroupUid()}
            onChange={(event) => setSelectedGroupUid(event.currentTarget.value)}
          >
            <option value="">Select group</option>
            <For each={groupList()}>
              {(group) => (
                <option value={group.identifiers.uid}>
                  {group.identifiers.id}: {group.identifiers.label}
                </option>
              )}
            </For>
          </NativeSelect>
        </label>
        <Button
          size="compact"
          type="button"
          disabled={!selectedGroupUid()}
          onClick={createGroupMaster}
        >
          New group master
        </Button>
        <Button size="compact" type="button" onClick={createGlobalRateMaster}>
          New rate global
        </Button>
        <label class="flex w-48 shrink-0 flex-col gap-1 text-xs text-neutral-400">
          <span>Clips</span>
          <NativeSelect
            density="compact"
            aria-label="Clips"
            multiple
            onChange={(event) =>
              setSelectedClipIds(
                Array.from(event.currentTarget.selectedOptions, (option) =>
                  Number(option.value),
                ),
              )
            }
          >
            <For each={clipList()}>
              {(clip) => (
                <option value={clip.identifiers.id}>
                  {clip.identifiers.id}: {clip.identifiers.label}
                </option>
              )}
            </For>
          </NativeSelect>
        </label>
        <Button
          size="compact"
          type="button"
          disabled={selectedClipIds().length === 0}
          onClick={createClipRateMaster}
        >
          New clip rate
        </Button>
      </div>

      <TableScroll aria-label="Masters scroll area" class="min-h-0 flex-1">
        <Table aria-label="Masters" style={{ "min-width": "720px" }}>
          <thead class="text-left">
            <tr>
              <th scope="col" class="w-10"></th>
              <th scope="col" class="w-16">
                ID
              </th>
              <th scope="col">Label</th>
              <th scope="col">Target</th>
              <th scope="col" class="w-36">
                Mode
              </th>
              <th scope="col" class="w-56">
                Level
              </th>
              <th scope="col" class="w-20"></th>
            </tr>
          </thead>
          <tbody>
            <For
              each={masterList()}
              fallback={<TableEmptyRow colSpan={7}>No masters</TableEmptyRow>}
            >
              {(master) => (
                <tr
                  class="select-none"
                  data-master-id={master.identifiers.id}
                  data-master-uid={normalizeUid(master.identifiers.uid)}
                  data-selected={
                    selectedMasterUid() === normalizeUid(master.identifiers.uid)
                      ? "true"
                      : "false"
                  }
                  onClick={() =>
                    setSelectedMasterUid(normalizeUid(master.identifiers.uid))
                  }
                >
                  <td>
                    <div
                      role="button"
                      tabIndex={0}
                      draggable="true"
                      class="flex h-7 w-7 cursor-grab items-center justify-center rounded border border-neutral-800 bg-neutral-900 font-mono text-xs text-neutral-400 hover:border-blue-500 hover:text-neutral-100 active:cursor-grabbing"
                      aria-label={`Drag ${master.identifiers.label} to a control`}
                      title="Drag to control"
                      data-master-drag-handle-id={master.identifiers.id}
                      onDragStart={[handleDragStart, master]}
                    >
                      <DotsSixVerticalIcon class="size-4" aria-hidden />
                    </div>
                  </td>
                  <td class="font-mono">{master.identifiers.id}</td>
                  <td>{master.identifiers.label}</td>
                  <td>{targetLabel(master.target, $groups(), $clips())}</td>
                  <td>
                    <NativeSelect
                      density="compact"
                      class="w-full"
                      style={{ "min-width": "120px" }}
                      value={modeKey(master.mode)}
                      onChange={(event) =>
                        sendMasterCommand(
                          buildSetMasterModeCommand(
                            master.identifiers.id,
                            event.currentTarget.value,
                          ),
                        )
                      }
                    >
                      <option value="AlwaysOn">Always on</option>
                      <option value="toggle-on">Toggle on</option>
                      <option value="toggle-off">Toggle off</option>
                      <option value="Disabled">Disabled</option>
                    </NativeSelect>
                  </td>
                  <td>
                    <div class="flex items-center gap-2">
                      <input
                        type="range"
                        min="0"
                        max={masterLevelMax(master)}
                        step="1"
                        value={master.level_percent}
                        class="w-full"
                        onInput={(event) =>
                          sendMasterCommand(
                            buildSetMasterLevelCommand(
                              master.identifiers.id,
                              Number(event.currentTarget.value),
                            ),
                          )
                        }
                      />
                      <span class="w-11 text-right font-mono text-xs text-neutral-400">
                        {Math.round(master.level_percent)}%
                      </span>
                    </div>
                  </td>
                  <td class="text-right">
                    <Show when={master.mode?.type === "Toggle"}>
                      <Button
                        size="compact"
                        type="button"
                        onClick={() =>
                          sendMasterCommand(
                            buildToggleMasterCommand(master.identifiers.id),
                          )
                        }
                      >
                        Toggle
                      </Button>
                    </Show>
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </Table>
      </TableScroll>
    </div>
  );
}
