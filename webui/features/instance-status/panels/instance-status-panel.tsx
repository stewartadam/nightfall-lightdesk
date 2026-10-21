// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { createMemo } from "solid-js";
import { commandClient } from "../../../lib/engine-commands";
import type { BasePanelComponentProps } from "../../../lib/panel-registry";
import {
  useConditionalShallowStore,
  useShallowStore,
} from "../../../lib/use-shallow-store";
import { useWorkspaceActivity } from "../../../lib/workspace-activity";
import { activeInstances, clips, timecodes } from "../../../state/appStores";
import type {
  InstanceCommand,
  InstanceId,
  InstanceKind as InstanceKindType,
  TimecodeCommand,
} from "../../../types";
import {
  ActiveInstancesSection,
  TimecodesSection,
} from "../components/status-sections";
import {
  compactId,
  compareStatusInstanceRows,
  normalizeUid,
  type StatusInstanceInfo,
} from "../model/instance-status-model";

export interface StatusDisplayPanelProps extends BasePanelComponentProps {}

/** Coordinates playback and timecode stores, sorting, and backend commands. */
export default function StatusDisplayPanel(_props: StatusDisplayPanelProps) {
  const $activeInstances = useShallowStore(activeInstances);
  const $clips = useStore(clips);
  const $timecodes = useConditionalShallowStore(
    timecodes,
    useWorkspaceActivity(),
  );

  /** Projects timecode store entries into rows ordered by operator-facing ID. */
  const timecodeRows = createMemo(() =>
    Object.values($timecodes())
      .map(([timecode, state]) => ({ timecode, state }))
      .sort((a, b) => a.timecode.identifiers.id - b.timecode.identifiers.id),
  );

  /** Counts active timecode rows for the section summary. */
  const runningTimecodes = createMemo(
    () => timecodeRows().filter((row) => row.state.is_active).length,
  );

  /** Indexes clip display labels by numeric ID for the playback clip column. */
  const clipLabelsById = createMemo(() => {
    const labels = new Map<number, string>();
    for (const [_uid, [clip]] of Object.entries($clips())) {
      labels.set(
        clip.identifiers.id,
        clip.identifiers.label || `Exec ${clip.identifiers.id}`,
      );
    }
    return labels;
  });

  /** Indexes clip display labels by normalized UID for playback owner cells. */
  const clipLabelsByUid = createMemo(() => {
    const labels = new Map<string, string>();
    for (const [_uid, [clip]] of Object.entries($clips())) {
      const normalizedUid = normalizeUid(clip.identifiers.uid);
      if (normalizedUid === null) continue;
      labels.set(
        normalizedUid,
        clip.identifiers.label || compactId(normalizedUid),
      );
    }
    return labels;
  });

  /** Returns an clip label for one numeric ID. */
  const clipLabel = (clipId: number | null | undefined): string => {
    if (clipId == null) return "Unbound";
    return clipLabelsById().get(clipId) ?? `Exec ${clipId}`;
  };

  /** Returns an clip label for one owner UID when it can be resolved. */
  const ownerLabel = (ownerUid: unknown): string => {
    const normalizedOwnerUid = normalizeUid(ownerUid);
    if (normalizedOwnerUid === null) return "Unknown";

    return (
      clipLabelsByUid().get(normalizedOwnerUid) ?? compactId(normalizedOwnerUid)
    );
  };

  /** Returns owner labels for one playback row. */
  const ownerLabels = (playback: StatusInstanceInfo): string => {
    const ownerUids = Array.isArray(playback.owner_uids)
      ? playback.owner_uids
      : [];
    if (ownerUids.length === 0) return "-";
    return ownerUids.map(ownerLabel).join(", ");
  };

  /** Lists active playback rows in their default order; header clicks sort within the grid. */
  const playbackRows = createMemo<StatusInstanceInfo[]>(() =>
    (Object.values($activeInstances()) as StatusInstanceInfo[]).sort(
      compareStatusInstanceRows,
    ),
  );

  /** Stops one active playback. */
  const stopPlayback = (instanceId: InstanceId) => {
    const command: InstanceCommand = { type: "Stop", data: instanceId };
    commandClient.emit("InstanceCommand", command);
  };

  /** Stops every active playback. */
  const stopAllInstances = () => {
    const command: InstanceCommand = { type: "StopAll", data: undefined };
    commandClient.emit("InstanceCommand", command);
  };

  /** Stops active instances of one display kind. */
  const stopByKind = (kind: InstanceKindType) => {
    const command: InstanceCommand = { type: "StopByKind", data: kind };
    commandClient.emit("InstanceCommand", command);
  };

  /** Sends one timecode transport command. */
  const sendTimecodeCommand = (
    command: "StartTimecode" | "PauseTimecode" | "StopTimecode",
    id: number,
  ) => {
    const payload: TimecodeCommand = { type: command, data: id };
    commandClient.emit("TimecodeCommand", payload);
  };

  return (
    <div class="flex h-full min-h-0 flex-col bg-neutral-900 text-neutral-100">
      <div
        aria-label="Status display content"
        class="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-3"
        role="region"
      >
        <ActiveInstancesSection
          rows={playbackRows()}
          clipLabel={clipLabel}
          ownerLabels={ownerLabels}
          onStop={stopPlayback}
          onStopAll={stopAllInstances}
          onStopKind={stopByKind}
        />
        <TimecodesSection
          rows={timecodeRows()}
          runningCount={runningTimecodes()}
          onCommand={sendTimecodeCommand}
        />
      </div>
    </div>
  );
}
