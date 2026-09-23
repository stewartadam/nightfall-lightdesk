// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { PanelComponentName } from "../../lib/panel-definitions";
import type {
  ActiveInstancesMap,
  ClipMap,
  CueMap,
  FixtureMap,
  ProgrammerRow,
  SequenceMap,
  TimecodeMap,
  TimelineMap,
} from "../../state/appStores";
import type { ControlSnapshot } from "../../types";

export type GuideObservation =
  | { type: "panel"; component: PanelComponentName }
  | {
      type:
        | "timeline-playing"
        | "timeline-stopped"
        | "timeline-action-moved"
        | "selection"
        | "intensity"
        | "clear";
    }
  | { type: "color"; color: "Red" | "Blue" }
  | { type: "cue"; id: number; label: string }
  | { type: "assigned"; clipId: number; control: number }
  | { type: "clip-playing" | "clip-stopped"; clipId: number }
  | { type: "cue-playing"; clipId: number; position: number };

export interface GuideSnapshot {
  panel?: string;
  fixtures: FixtureMap;
  selection: string[];
  programmer: ProgrammerRow[];
  cues: CueMap;
  sequences: SequenceMap;
  clips: ClipMap;
  controls: ControlSnapshot[];
  instances: ActiveInstancesMap;
  timelines: TimelineMap;
  timecodes: TimecodeMap;
}

/** Returns a completion token only for the requested sample object and resulting state. */
export function guideCompletionToken(
  observation: GuideObservation,
  state: GuideSnapshot,
): string {
  const timeline = Object.values(state.timelines).find(
    (entry) => entry.identifiers.id === 1,
  );
  const sequence = Object.values(state.sequences).find(
    (entry) => entry.identifiers.id === 1,
  );
  const expectedFixtures = Object.values(state.fixtures)
    .filter(
      (fixture) =>
        fixture.identifiers.id >= 310 && fixture.identifiers.id <= 313,
    )
    .map((fixture) => fixture.identifiers.uid);
  /** Requires all four intended strips, so unrelated programmer edits cannot complete a step. */
  const allRowsMatch = (match: (row: ProgrammerRow) => boolean) =>
    expectedFixtures.length === 4 &&
    expectedFixtures.every((uid) => {
      const row = state.programmer.find((entry) => entry.fixtureUid === uid);
      return row !== undefined && match(row);
    });
  switch (observation.type) {
    case "panel":
      return state.panel === observation.component ? state.panel : "";
    case "timeline-playing":
      return timeline && state.timecodes[timeline.timecode_uid]?.[1].is_active
        ? "playing"
        : "";
    case "timeline-stopped":
      return timeline &&
        !state.timecodes[timeline.timecode_uid]?.[1].is_active &&
        state.timecodes[timeline.timecode_uid]?.[1].current_time.secs ===
          timeline.timecode_start.secs &&
        state.timecodes[timeline.timecode_uid]?.[1].current_time.nanos ===
          timeline.timecode_start.nanos
        ? "stopped"
        : "";
    case "timeline-action-moved": {
      const action = timeline?.tracks
        .find((track) => track.id === "1")
        ?.actions.find((entry) => entry.id === "1");
      return action?.position.secs === 3 && action.position.nanos === 0
        ? "moved"
        : "";
    }
    case "selection":
      return expectedFixtures.length === 4 &&
        state.selection.length === 4 &&
        expectedFixtures.every((uid) => state.selection.includes(uid))
        ? "selected"
        : "";
    case "intensity":
      return allRowsMatch((row) => {
        const value =
          row.attributes.Intensity ?? row.attributes.VirtualIntensity;
        return (
          value !== undefined &&
          !value.isRelative &&
          value.value === (value.isPercentage ? 1 : 255)
        );
      })
        ? "intensity"
        : "";
    case "color":
      return allRowsMatch((row) =>
        ["Red", "Green", "Blue"].every((attribute) => {
          const value = row.attributes[attribute];
          return (
            value !== undefined &&
            !value.isRelative &&
            value.value ===
              (attribute === observation.color
                ? value.isPercentage
                  ? 1
                  : 255
                : 0)
          );
        }),
      )
        ? observation.color
        : "";
    case "cue": {
      const cue = sequence?.steps
        .map((uid) => state.cues[uid])
        .find((entry) => entry?.identifiers.id === observation.id);
      return cue?.identifiers.label === observation.label &&
        cue.instructions.length > 0
        ? JSON.stringify(cue)
        : "";
    }
    case "clear":
      return state.selection.length === 0 && state.programmer.length === 0
        ? "clear"
        : "";
    case "assigned":
      return state.controls.find(
        (control) => control.index === observation.control,
      )?.assigned_clip_id === observation.clipId
        ? "assigned"
        : "";
    case "clip-playing":
      return Object.values(state.clips).some(
        ([clip, active]) =>
          clip.identifiers.id === observation.clipId && active,
      )
        ? "playing"
        : "";
    case "clip-stopped":
      return Object.values(state.clips).some(
        ([clip, active]) =>
          clip.identifiers.id === observation.clipId && !active,
      )
        ? "stopped"
        : "";
    case "cue-playing":
      return Object.values(state.instances).some(
        (instance) =>
          instance.bound_clip_id === observation.clipId &&
          instance.status.position.type === "Sequence" &&
          instance.status.position.data.current_position ===
            observation.position,
      )
        ? "advanced"
        : "";
  }
}
