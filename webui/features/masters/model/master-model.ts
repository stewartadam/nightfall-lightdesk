// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import * as types from "../../../types";

/** Returns a compact, sorted list of persisted masters. */
export function sortedMasters(
  masterMap: Record<string, types.Master>,
): types.Master[] {
  return Object.values(masterMap).sort(
    (left, right) => left.identifiers.id - right.identifiers.id,
  );
}

/** Returns a compact, sorted list of persisted groups. */
export function sortedGroups(
  groupMap: Record<string, types.Group>,
): types.Group[] {
  return Object.values(groupMap).sort(
    (left, right) => left.identifiers.id - right.identifiers.id,
  );
}

/** Returns a compact, sorted list of persisted clips. */
export function sortedClips(
  clipMap: Record<string, [types.Clip, boolean]>,
): types.Clip[] {
  return Object.values(clipMap)
    .map(([clip]) => clip)
    .sort((left, right) => left.identifiers.id - right.identifiers.id);
}

/** Normalizes object UIDs for stable lookup and DOM keys. */
export function normalizeUid(uid: unknown): string {
  return String(uid).replace(/-/g, "").toLowerCase();
}

/** Returns the next numeric master ID after the current highest ID. */
export function nextMasterId(masterMap: Record<string, types.Master>): number {
  return (
    Object.values(masterMap).reduce(
      (highest, master) => Math.max(highest, master.identifiers.id),
      0,
    ) + 1
  );
}

/** Builds the serde-tagged target for all fixtures. */
export function allFixturesTarget(): types.MasterTarget {
  return {
    type: "Fixtures",
    data: { type: "All" },
  } as types.MasterTarget;
}

/** Builds the serde-tagged target for a group-scoped master. */
export function groupTarget(groupUid: string): types.MasterTarget {
  return {
    type: "Fixtures",
    data: { type: "Group", data: groupUid },
  } as types.MasterTarget;
}

/** Builds the serde-tagged target for all live instances. */
export function allInstancesTarget(): types.MasterTarget {
  return {
    type: "Instances",
    data: { type: "All" },
  } as types.MasterTarget;
}

/** Builds the serde-tagged target for clip-attached instances. */
export function clipPlaybackTarget(clipIds: number[]): types.MasterTarget {
  return {
    type: "Instances",
    data: { type: "Clips", data: clipIds },
  } as types.MasterTarget;
}

/** Builds the serde-tagged always-on master mode. */
export function alwaysOnMode(): types.MasterMode {
  return { type: "AlwaysOn" } as types.MasterMode;
}

/** Builds the serde-tagged disabled master mode. */
export function disabledMode(): types.MasterMode {
  return { type: "Disabled" } as types.MasterMode;
}

/** Builds the serde-tagged toggle master mode. */
export function toggleMode(active: boolean): types.MasterMode {
  return { type: "Toggle", data: { active } } as types.MasterMode;
}

/** Returns a concise target label for a master row. */
export function targetLabel(
  target: types.MasterTarget | undefined,
  groupMap: Record<string, types.Group>,
  clipMap: Record<string, [types.Clip, boolean]>,
): string {
  if (!target) return "All fixtures";
  if (target.type === "Fixtures") {
    if (target.data.type === "All") return "All fixtures";
    if (target.data.type === "Group") {
      const group = groupMap[target.data.data];
      return group
        ? `Group ${group.identifiers.id}: ${group.identifiers.label}`
        : "Missing group";
    }
    return "Captured selection";
  }
  if (target.data.type === "All") return "All instances";
  const clipLabels = target.data.data.map((clipId) => {
    const clip = Object.values(clipMap).find(
      ([candidate]) => candidate.identifiers.id === clipId,
    )?.[0];
    return clip
      ? `${clip.identifiers.id}: ${clip.identifiers.label}`
      : `${clipId}`;
  });
  return clipLabels.length === 0
    ? "No clips"
    : `Clips ${clipLabels.join(", ")}`;
}

/** Returns the editable mode key used by the mode select. */
export function modeKey(mode: types.MasterMode | undefined): string {
  if (!mode) return "AlwaysOn";
  if (mode.type === "Toggle") {
    return mode.data.active ? "toggle-on" : "toggle-off";
  }
  return mode.type;
}

/** Converts a mode select key back into the backend mode shape. */
export function modeFromKey(key: string): types.MasterMode {
  if (key === "Disabled") return disabledMode();
  if (key === "toggle-on") return toggleMode(true);
  if (key === "toggle-off") return toggleMode(false);
  return alwaysOnMode();
}

/** Returns whether a persisted master controls playback rate. */
export function isRateMaster(master: types.Master): boolean {
  return master.kind === types.MasterKind.PlaybackRate;
}

/** Returns the maximum stored level for a master. */
export function masterLevelMax(master: types.Master): number {
  return isRateMaster(master) ? 200 : 100;
}

/** Builds the command that stores a new master. */
export function buildStoreMasterCommand(
  masterMap: Record<string, types.Master>,
  kind: types.MasterKind,
  target: types.MasterTarget,
  label: string,
  uid: string,
): types.MasterCommand {
  return {
    type: "StoreMaster",
    data: {
      identifiers: {
        id: nextMasterId(masterMap),
        uid,
        label,
      },
      kind,
      target,
      mode: alwaysOnMode(),
      level_percent: 100,
    },
  } as types.MasterCommand;
}

/** Builds a command that changes a master's operating mode. */
export function buildSetMasterModeCommand(
  id: number,
  key: string,
): types.MasterCommand {
  return {
    type: "SetMasterMode",
    data: { id, mode: modeFromKey(key) },
  } as types.MasterCommand;
}

/** Builds a command that changes a master's level. */
export function buildSetMasterLevelCommand(
  id: number,
  levelPercent: number,
): types.MasterCommand {
  return {
    type: "SetMasterLevel",
    data: { id, level_percent: levelPercent },
  } as types.MasterCommand;
}

/** Builds a command that flips a toggle master's active state. */
export function buildToggleMasterCommand(id: number): types.MasterCommand {
  return {
    type: "ToggleMaster",
    data: { id },
  } as types.MasterCommand;
}
