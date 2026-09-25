// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { durationToMs } from "../../lib/duration";
import type { PanelComponentName } from "../../lib/panel-definitions";
import type {
  ActiveInstancesMap,
  ClipMap,
  CueMap,
  FixtureMap,
  FxMap,
  ProgrammerRow,
  SequenceMap,
  StepFxMap,
  TimecodeMap,
  TimelineMap,
} from "../../state/appStores";
import { type ControlSnapshot, InstanceDisplayKind } from "../../types";
import type { PatchTab } from "../patch";
import { normalizeTimelineUid } from "../timeline";

export type GuideObservation =
  | { type: "command-palette" }
  | { type: "settings" }
  | { type: "save-showfile" }
  | { type: "command-submitted"; command: string }
  | { type: "accent-settings-closed" | "shortcuts-closed" }
  | { type: "panel-hidden"; component: PanelComponentName }
  | { type: "sample-panels" }
  | { type: "panel"; component: PanelComponentName }
  | { type: "sequence-editor"; sequenceId: number }
  | {
      type: "timeline-playing" | "timeline-stopped" | "intensity" | "clear";
    }
  | { type: "selection"; fixtureIds: readonly number[] }
  | { type: "fixture-edit-selected"; fixtureId: number }
  | { type: "patch-view"; view: PatchTab }
  | { type: "timeline-action-selected"; trackId: string; actionId: string }
  | {
      type: "timeline-action-position";
      trackId: string;
      actionId: string;
      positionMs: number;
      toleranceMs: number;
    }
  | { type: "color"; color: "Red" | "Blue" }
  | { type: "cue"; sequenceId: number; id: number }
  | { type: "cue-manual"; sequenceId: number; id: number }
  | { type: "clip-sequence"; clipId: number; sequenceId: number }
  | { type: "clip-created"; clipId: number }
  | { type: "assigned"; clipId: number; control: number }
  | { type: "clip-playing" | "clip-stopped"; clipId: number }
  | { type: "cue-playing"; clipId: number; position: number }
  | { type: "playback-idle" }
  | { type: "panel-closed"; component: PanelComponentName }
  | { type: "fx-saved"; fxId: number }
  | {
      type: "step-fx";
      selection?: readonly [number, number];
      phase?: "together" | "spread";
      beatSeconds?: number;
    }
  | { type: "step-fx-preview-stopped" };

export interface GuideSnapshot {
  commandPaletteOpen?: boolean;
  settingsOpen?: boolean;
  shortcutsOpen?: boolean;
  accentPicked?: boolean;
  saveShowfilePressed?: boolean;
  /** Most recent command submitted from a command input during the step. */
  submittedCommand?: string;
  /** Timeline action chips currently selected in any open timeline editor. */
  selectedTimelineActions?: {
    timelineUid: string;
    trackId: string;
    actionId: string;
  }[];
  /** Fixtures picked in Patch or the Visualizer for editing, separate from programmer selection. */
  editSelection?: string[];
  patchView?: PatchTab;
  panel?: string;
  openPanels?: {
    component: string;
    timelineUid?: string;
    sequenceUid?: string;
    stepFxUid?: string;
    visible?: boolean;
  }[];
  fx?: FxMap;
  stepFx?: StepFxMap;
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

/** Reports whether any clip, effect, or timeline is playing, ignoring editor previews and the Programmer. */
export function isPlaybackRunning(
  instances: ActiveInstancesMap,
  clocks: TimecodeMap,
): boolean {
  return (
    Object.values(instances).some(
      (instance) =>
        !instance.is_preview &&
        instance.display_kind !== InstanceDisplayKind.Programmer,
    ) || Object.values(clocks).some(([, state]) => state.is_active)
  );
}

/** Drops hyphens and case so hyphenated and compact UUID spellings compare equal. */
function normalizeUuid(uid: string): string {
  return uid.replace(/-/g, "").toLowerCase();
}

/** Collapses whitespace and case so equivalent spellings of a lesson command match. */
function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Returns a completion token only for the requested sample object and resulting state. */
export function guideCompletionToken(
  observation: GuideObservation,
  state: GuideSnapshot,
): string {
  const timeline = Object.values(state.timelines).find(
    (entry) => entry.identifiers.id === 1,
  );
  const sampleUid = timeline && normalizeTimelineUid(timeline.identifiers.uid);
  /** Resolves a user-facing fixture ID to its session-specific UID. */
  const fixtureUid = (id: number) =>
    Object.values(state.fixtures).find(
      (fixture) => fixture.identifiers.id === id,
    )?.identifiers.uid;
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
    case "command-palette":
      return state.commandPaletteOpen ? "open" : "";
    case "settings":
      return state.settingsOpen ? "open" : "";
    case "save-showfile":
      return state.saveShowfilePressed ? "pressed" : "";
    case "command-submitted":
      return state.submittedCommand !== undefined &&
        normalizeCommand(state.submittedCommand) ===
          normalizeCommand(observation.command)
        ? "submitted"
        : "";
    case "accent-settings-closed":
      return state.accentPicked && !state.settingsOpen ? "closed" : "";
    case "shortcuts-closed":
      return state.shortcutsOpen ? "" : "closed";
    case "panel-hidden":
      return state.openPanels?.some(
        (panel) => panel.component === observation.component && panel.visible,
      )
        ? ""
        : "hidden";
    case "sample-panels":
      return timeline &&
        state.openPanels?.some((panel) => panel.component === "Visualizer") &&
        state.openPanels.some(
          (panel) =>
            panel.component === "Timeline" &&
            normalizeTimelineUid(panel.timelineUid) === sampleUid,
        )
        ? "ready"
        : "";
    case "panel":
      return state.panel === observation.component ? state.panel : "";
    case "sequence-editor": {
      const sequence = Object.values(state.sequences).find(
        (entry) => entry.identifiers.id === observation.sequenceId,
      );
      return sequence &&
        state.openPanels?.some(
          (panel) =>
            panel.component === "SequenceEditor" &&
            panel.visible &&
            panel.sequenceUid === sequence.identifiers.uid,
        )
        ? "open"
        : "";
    }
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
    case "timeline-action-selected": {
      const selected =
        state.selectedTimelineActions?.filter(
          (entry) =>
            sampleUid !== undefined &&
            normalizeTimelineUid(entry.timelineUid) === sampleUid,
        ) ?? [];
      return selected.length === 1 &&
        selected[0].trackId === observation.trackId &&
        selected[0].actionId === observation.actionId
        ? "selected"
        : "";
    }
    case "timeline-action-position": {
      const action = timeline?.tracks
        .find((track) => track.id === observation.trackId)
        ?.actions.find((entry) => entry.id === observation.actionId);
      if (!action) return "";
      const position = durationToMs(action.position);
      return Math.abs(position - observation.positionMs) <=
        observation.toleranceMs
        ? `moved:${position}`
        : "";
    }
    case "selection": {
      const uids = observation.fixtureIds.map((id) => fixtureUid(id));
      return uids.every((uid) => uid !== undefined) &&
        state.selection.length === uids.length &&
        uids.every((uid) => state.selection.includes(uid))
        ? `selected:${observation.fixtureIds.join(",")}`
        : "";
    }
    case "fixture-edit-selected": {
      const uid = fixtureUid(observation.fixtureId);
      return uid !== undefined && state.editSelection?.includes(uid)
        ? "selected"
        : "";
    }
    case "patch-view":
      return state.patchView === observation.view ? observation.view : "";
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
    case "cue-manual":
    case "cue": {
      const sequence = Object.values(state.sequences).find(
        (entry) => entry.identifiers.id === observation.sequenceId,
      );
      const cue = sequence?.steps
        .map((uid) => state.cues[uid])
        .find((entry) => entry?.identifiers.id === observation.id);
      if (observation.type === "cue-manual")
        return cue?.trigger.type === "Manual" ? "manual" : "";
      return cue && cue.instructions.length > 0
        ? JSON.stringify(cue.instructions)
        : "";
    }
    case "clip-created": {
      const clip = Object.values(state.clips).find(
        ([clip]) => clip.identifiers.id === observation.clipId,
      )?.[0];
      return clip ? JSON.stringify(clip) : "";
    }
    case "clip-sequence": {
      const sequence = Object.values(state.sequences).find(
        (entry) => entry.identifiers.id === observation.sequenceId,
      );
      return sequence &&
        Object.values(state.clips).some(
          ([clip]) =>
            clip.identifiers.id === observation.clipId &&
            clip.source?.type === "Sequence" &&
            clip.source.data === sequence.identifiers.uid,
        )
        ? "linked"
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
    case "playback-idle":
      return isPlaybackRunning(state.instances, state.timecodes) ? "" : "idle";
    case "panel-closed":
      return state.openPanels?.some(
        (panel) => panel.component === observation.component,
      )
        ? ""
        : "closed";
    case "fx-saved": {
      // Armed with the stored definition at step entry, so any saved change advances.
      const effect = Object.values(state.fx ?? {}).find(
        (entry) => entry.identifiers.id === observation.fxId,
      );
      return effect ? JSON.stringify(effect) : "";
    }
    case "step-fx": {
      const uid = [...(state.openPanels ?? [])]
        .reverse()
        .find(
          (panel) => panel.component === "StepFxEditor" && panel.stepFxUid,
        )?.stepFxUid;
      // Editor params and store keys may differ in UUID hyphenation.
      const effect = uid
        ? Object.values(state.stepFx ?? {}).find(
            (entry) =>
              normalizeUuid(entry.identifiers.uid) === normalizeUuid(uid),
          )
        : undefined;
      if (!effect) return "";
      const range = observation.selection;
      const { source, clauses, union } = effect.selection;
      const selectionMatches =
        !range ||
        (source.type === "FixtureRange" &&
          source.data.start.fixture_id === range[0] &&
          source.data.end.fixture_id === range[1] &&
          source.data.start.element_index == null &&
          source.data.end.element_index == null &&
          clauses.length === 0 &&
          !union?.length);
      // One waypoint places every fixture together; two spread them across the selection.
      const phaseMatches =
        !observation.phase ||
        effect.phase.waypoints.length ===
          (observation.phase === "together" ? 1 : 2);
      const beat = effect.timing.beat_duration;
      const speedMatches =
        observation.beatSeconds === undefined ||
        Math.abs(beat.secs + beat.nanos / 1e9 - observation.beatSeconds) < 1e-3;
      return selectionMatches && phaseMatches && speedMatches ? "matched" : "";
    }
    case "step-fx-preview-stopped":
      return Object.values(state.instances).some(
        (instance) =>
          instance.is_preview &&
          instance.display_kind === InstanceDisplayKind.StepFx,
      )
        ? ""
        : "stopped";
  }
}
