// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createEffect, createSignal, For } from "solid-js";
import { useRevealObjectCapability } from "../../components/providers/panel-capabilities/context-core";
import { Table, TableScroll } from "../../components/ui/table";
import type { BasePanelComponentProps } from "../../lib/panel-registry";
import { durationToMs, formatSMPTETime } from "../../lib/time-format";
import { useConditionalShallowStore } from "../../lib/use-shallow-store";
import { useWorkspaceActivity } from "../../lib/workspace-activity";
import { timecodes } from "../../state/appStores";

interface TimecodePanelProps extends BasePanelComponentProps {
  initialPanelId: string;
}

interface TimecodeRow {
  id: number;
  uid: string;
  running: boolean;
  currentFrame: string;
}

/** Normalizes object UIDs for stable lookup and DOM keys. */
function normalizeUid(uid: unknown): string {
  return String(uid).replace(/-/g, "").toLowerCase();
}

export default function TimecodePanel(props: TimecodePanelProps) {
  const $timecodes = useConditionalShallowStore(
    timecodes,
    useWorkspaceActivity(),
  );
  const [rows, setRows] = createSignal<TimecodeRow[]>([]);
  const [selectedUid, setSelectedUid] = createSignal<string | null>(null);

  // Define columns
  const columns = [
    { key: "id", name: "ID" },
    { key: "currentFrame", name: "Timecode" },
    { key: "running", name: "Status" },
  ];

  // Update rows when timecodes change
  createEffect(() => {
    const timecodeList = Object.values($timecodes());
    const newRows = timecodeList
      .map(([tc, tcState]) => ({
        id: tc.identifiers.id,
        uid: normalizeUid(tc.identifiers.uid),
        running: tcState.is_active,
        currentFrame: tcState.current_time
          ? formatSMPTETime(durationToMs(tcState.current_time), tc.rate)
          : "00:00:00:00",
      }))
      .sort((a, b) => a.id - b.id);
    setRows(newRows);
  });

  /** Selects and reveals a timecode requested by the showfile object palette. */
  useRevealObjectCapability(
    props.initialPanelId ?? props.id,
    (request) => {
      const uid = normalizeUid(request.uid);
      if (!rows().some((row) => row.uid === uid)) return;
      setSelectedUid(uid);
      setTimeout(() => {
        document
          .querySelector(`[data-timecode-uid="${uid}"]`)
          ?.scrollIntoView({ block: "nearest" });
      }, 0);
    },
    { accepts: (payload) => payload.type === "timecode" },
  );

  return (
    <TableScroll
      aria-label="Timecodes scroll area"
      class="w-full h-full p-4 dark:text-white"
    >
      <Table aria-label="Timecodes" class="min-w-full">
        <thead>
          <tr>
            <For each={columns}>
              {(col) => (
                <th scope="col" class="text-left">
                  {col.name}
                </th>
              )}
            </For>
          </tr>
        </thead>
        <tbody>
          <For each={rows()}>
            {(row) => (
              <tr
                data-id={row.id}
                data-timecode-uid={row.uid}
                data-selected={selectedUid() === row.uid ? "true" : "false"}
                onClick={() => setSelectedUid(row.uid)}
              >
                <td>{row.id}</td>
                <td>{row.currentFrame}</td>
                <td>{row.running ? "Running" : "Stopped"}</td>
              </tr>
            )}
          </For>
        </tbody>
      </Table>
    </TableScroll>
  );
}
