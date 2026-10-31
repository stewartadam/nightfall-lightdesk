// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { normalizeFixtureUid } from "../../../lib/route-utils";
import type {
  ClipMap,
  CueDurationProfileMap,
  CueMap,
  FlowMap,
  FxMap,
  FxModuleMap,
  SequenceMap,
  StepFxMap,
} from "../../../state/appStores";
import type * as types from "../../../types";
import { formatCueEditorTitle } from "../../cues";
import type { TimelineActionKind } from "./timeline-action-kind";

export type ActionEditorTarget = {
  panelId: string;
  component: string;
  title: string;
  params: Record<string, unknown>;
  label: string;
};

export type ActionClipPropertiesTarget = {
  clipUid: string;
  clipId: number;
  label: string;
};

type FxEditorSource = types.Fx | types.StepFx | types.StoredFxModule;

export type ActionTargetIndex = {
  cueMapByUid: Map<string, types.Cue>;
  cueDurationProfileMapByUid: Map<string, types.CueDurationProfileMessage>;
  sequenceMapByUid: Map<string, types.Sequence>;
  clipMapByUid: Map<string, ClipMap[string]>;
  flowMapByUid: Map<string, FlowMap[string]>;
  fxMapByUid: Map<string, FxEditorSource>;
  cueSequenceRefByUid: Map<
    string,
    { sequenceId: number; sequenceUid: string; cueId: number }
  >;
};

type ActionTargetSources = {
  cues: CueMap;
  cueDurationProfiles: CueDurationProfileMap;
  sequences: SequenceMap;
  clips: ClipMap;
  flows: FlowMap;
  fx: FxMap;
  stepFx: StepFxMap;
  fxModules: FxModuleMap;
};

/** Normalizes a backend UID into the lookup key used by timeline action labels. */
export function normalizeActionTargetUid(uid: unknown): string {
  return normalizeFixtureUid(uid).toLowerCase();
}

/** Builds shared lookup maps for all timeline action target display and editor resolution. */
export function buildActionTargetIndex(
  sources: ActionTargetSources,
): ActionTargetIndex {
  const cueMapByUid = new Map<string, types.Cue>();
  for (const cue of Object.values(sources.cues)) {
    cueMapByUid.set(normalizeActionTargetUid(cue.identifiers.uid), cue);
  }

  const cueDurationProfileMapByUid = new Map<
    string,
    types.CueDurationProfileMessage
  >();
  for (const profile of Object.values(sources.cueDurationProfiles)) {
    cueDurationProfileMapByUid.set(
      normalizeActionTargetUid(profile.cue_uid),
      profile,
    );
  }

  const sequenceMapByUid = new Map<string, types.Sequence>();
  for (const sequence of Object.values(sources.sequences)) {
    sequenceMapByUid.set(
      normalizeActionTargetUid(sequence.identifiers.uid),
      sequence,
    );
  }

  const clipMapByUid = new Map<string, ClipMap[string]>();
  for (const clipTuple of Object.values(sources.clips)) {
    clipMapByUid.set(
      normalizeActionTargetUid(clipTuple[0].identifiers.uid),
      clipTuple,
    );
  }

  const flowMapByUid = new Map<string, FlowMap[string]>();
  for (const flow of Object.values(sources.flows)) {
    flowMapByUid.set(normalizeActionTargetUid(flow.identifiers.uid), flow);
  }

  const fxMapByUid = new Map<string, FxEditorSource>();
  for (const fxEntry of Object.values(sources.fx)) {
    fxMapByUid.set(normalizeActionTargetUid(fxEntry.identifiers.uid), fxEntry);
  }
  for (const fxEntry of Object.values(sources.stepFx)) {
    fxMapByUid.set(normalizeActionTargetUid(fxEntry.identifiers.uid), fxEntry);
  }
  for (const fxEntry of Object.values(sources.fxModules)) {
    fxMapByUid.set(normalizeActionTargetUid(fxEntry.identifiers.uid), fxEntry);
  }

  const cueSequenceRefByUid = new Map<
    string,
    { sequenceId: number; sequenceUid: string; cueId: number }
  >();
  for (const sequence of Object.values(sources.sequences)) {
    const sequenceId = sequence.identifiers.id;
    const sequenceUid = sequence.identifiers.uid;
    for (const cueUid of sequence.steps) {
      const normalizedCueUid = normalizeActionTargetUid(cueUid);
      if (cueSequenceRefByUid.has(normalizedCueUid)) continue;
      const cue = cueMapByUid.get(normalizedCueUid);
      if (!cue) continue;
      cueSequenceRefByUid.set(normalizedCueUid, {
        sequenceId,
        sequenceUid,
        cueId: cue.identifiers.id,
      });
    }
  }

  return {
    cueMapByUid,
    cueDurationProfileMapByUid,
    sequenceMapByUid,
    clipMapByUid,
    flowMapByUid,
    fxMapByUid,
    cueSequenceRefByUid,
  };
}

/** Builds the cue editor panel target for a timeline action cue UID. */
function cueEditorTarget(
  index: ActionTargetIndex,
  cueUid: string,
): ActionEditorTarget | undefined {
  const cue = index.cueMapByUid.get(normalizeActionTargetUid(cueUid));
  if (!cue) return undefined;
  const normalizedCueUid = normalizeActionTargetUid(cue.identifiers.uid);
  const sequenceRef = index.cueSequenceRefByUid.get(normalizedCueUid);
  return {
    panelId: `cue-list-panel-${normalizedCueUid}`,
    component: "CueEditor",
    title: formatCueEditorTitle({
      cueId: cue.identifiers.id,
      sequenceId: sequenceRef?.sequenceId,
      partId: 0,
      hasAdditionalParts: (cue.parts?.length ?? 0) > 0,
    }),
    params: {
      initialCueUid: normalizedCueUid,
      initialSequenceId: sequenceRef?.sequenceId,
      initialSequenceUid: sequenceRef?.sequenceUid,
    },
    label: `Open Cue ${cue.identifiers.id} Editor`,
  };
}

/** Builds the sequence editor panel target for a sequence UID. */
function sequenceEditorTarget(
  index: ActionTargetIndex,
  sequenceUid: string,
): ActionEditorTarget | undefined {
  const sequence = index.sequenceMapByUid.get(
    normalizeActionTargetUid(sequenceUid),
  );
  if (!sequence) return undefined;
  const normalizedSequenceUid = normalizeActionTargetUid(
    sequence.identifiers.uid,
  );
  const label = sequence.identifiers.label.trim();
  return {
    panelId: `sequence-editor-panel-${normalizedSequenceUid}`,
    component: "SequenceEditor",
    title: label
      ? `Sequence ${sequence.identifiers.id}: ${label}`
      : `Sequence ${sequence.identifiers.id}`,
    params: { initialSequenceUid: normalizedSequenceUid },
    label: `Open Sequence ${sequence.identifiers.id} Editor`,
  };
}

/** Builds the flow editor panel target for a flow UID. */
function flowEditorTarget(
  index: ActionTargetIndex,
  flowUid: string,
): ActionEditorTarget | undefined {
  const flow = index.flowMapByUid.get(normalizeActionTargetUid(flowUid));
  if (!flow) return undefined;
  const normalizedFlowUid = normalizeActionTargetUid(flow.identifiers.uid);
  return {
    panelId: `flow-editor-${normalizedFlowUid}`,
    component: "FlowEditor",
    title: `Flow ${flow.identifiers.id}: ${flow.identifiers.label}`,
    params: { initialFlowUid: normalizedFlowUid },
    label: `Open Flow ${flow.identifiers.id} Editor`,
  };
}

/** Builds the FX editor panel target for an FX, StepFx, or module UID. */
function fxEditorTarget(
  index: ActionTargetIndex,
  fxUid: string,
): ActionEditorTarget | undefined {
  const fxEntry = index.fxMapByUid.get(normalizeActionTargetUid(fxUid));
  if (!fxEntry) return undefined;
  const normalizedFxUid = normalizeActionTargetUid(fxEntry.identifiers.uid);
  return {
    panelId: `fx-editor-${normalizedFxUid}`,
    component: "FxEditor",
    title: `FX ${fxEntry.identifiers.id}: ${fxEntry.identifiers.label}`,
    params: { initialFxUid: normalizedFxUid },
    label: `Open FX ${fxEntry.identifiers.id} Editor`,
  };
}

/** Resolves the best editor target for a clip action. */
function clipEditorTarget(
  index: ActionTargetIndex,
  clipUid: string,
): ActionEditorTarget | undefined {
  const clipTuple = index.clipMapByUid.get(normalizeActionTargetUid(clipUid));
  const clip = clipTuple?.[0];
  if (!clip) return undefined;
  if (clip.source?.type === "Sequence") {
    return sequenceEditorTarget(index, clip.source.data);
  }
  if (clip.source?.type === "Flow") {
    return flowEditorTarget(index, clip.source.data);
  }
  if (
    clip.source?.type === "Fx" ||
    clip.source?.type === "StepFx" ||
    clip.source?.type === "FxModule"
  ) {
    return fxEditorTarget(index, clip.source.data);
  }
  return {
    panelId: "panel-ClipList",
    component: "ClipList",
    title: "Clips",
    params: {},
    label: `Open Clip ${clip.identifiers.id} Properties`,
  };
}

/** Resolves the clip directly controlled by a timeline action kind. */
export function resolveActionClipPropertiesTarget(
  action: TimelineActionKind,
  index: ActionTargetIndex,
): ActionClipPropertiesTarget | undefined {
  const clipUid = (() => {
    switch (action.type) {
      case "StartClip":
      case "StopClip":
      case "AdvanceSequence":
      case "BackSequence":
        return action.data;
      case "SetClipSpeed":
      case "JumpToCue":
        return action.data.uid;
      case "FireCue":
      case "DeskEval":
      case "RegisteredAction":
        return undefined;
    }
  })();
  if (!clipUid) return undefined;

  const clipTuple = index.clipMapByUid.get(normalizeActionTargetUid(clipUid));
  const clip = clipTuple?.[0];
  if (!clip) return undefined;

  return {
    clipUid: clip.identifiers.uid,
    clipId: clip.identifiers.id,
    label: `Edit Clip ${clip.identifiers.id} Properties`,
  };
}

/** Resolves a sequence cue editor target from a clip action and the cue it lands on. */
function sequenceCueEditorTarget(
  index: ActionTargetIndex,
  clipUid: string,
  cueUid: string | undefined,
) {
  const clipTuple = index.clipMapByUid.get(normalizeActionTargetUid(clipUid));
  const source = clipTuple?.[0].source;
  const sequenceUid = source?.type === "Sequence" ? source.data : undefined;
  if (!sequenceUid) return undefined;

  return (
    (cueUid ? cueEditorTarget(index, cueUid) : undefined) ??
    sequenceEditorTarget(index, sequenceUid)
  );
}

/** Formats a sequence and cue as the operator-facing `sequence.cue` number, if both exist. */
function sequenceCueRef(
  index: ActionTargetIndex,
  sequenceUid: string | undefined,
  cueUid: string | undefined,
): string | undefined {
  if (!sequenceUid || !cueUid) return undefined;
  const sequenceId = index.sequenceMapByUid.get(
    normalizeActionTargetUid(sequenceUid),
  )?.identifiers.id;
  const cueId = index.cueMapByUid.get(normalizeActionTargetUid(cueUid))
    ?.identifiers.id;
  return sequenceId !== undefined && cueId !== undefined
    ? `${sequenceId}.${cueId}`
    : undefined;
}

/** Returns the cue UID at a 1-based step position of a clip's sequence. */
function sequenceStepCueUid(
  index: ActionTargetIndex,
  clipUid: string,
  cueIndex: number,
): string | undefined {
  const source = index.clipMapByUid.get(normalizeActionTargetUid(clipUid))?.[0]
    .source;
  if (source?.type !== "Sequence") return undefined;
  return index.sequenceMapByUid.get(normalizeActionTargetUid(source.data))
    ?.steps[Math.max(0, cueIndex - 1)];
}

/**
 * Resolves the editor panel that best matches the timeline action target.
 *
 * Go, Back, and jump open the cue the backend resolved for the action's timeline position; Go
 * and Back fall back to the clip's sequence editor while that cue is unknown.
 */
export function resolveActionEditorTarget(
  action: TimelineActionKind,
  index: ActionTargetIndex,
  plannedCue?: types.TimelinePlannedCue,
): ActionEditorTarget | undefined {
  switch (action.type) {
    case "FireCue":
      return cueEditorTarget(index, action.data);
    case "StartClip":
    case "StopClip":
      return clipEditorTarget(index, action.data);
    case "SetClipSpeed":
      return clipEditorTarget(index, action.data.uid);
    case "JumpToCue":
      return sequenceCueEditorTarget(
        index,
        action.data.uid,
        plannedCue?.cue_uid ??
          sequenceStepCueUid(index, action.data.uid, action.data.cue_index),
      );
    case "AdvanceSequence":
    case "BackSequence":
      return sequenceCueEditorTarget(index, action.data, plannedCue?.cue_uid);
    default:
      return undefined;
  }
}

/**
 * Resolves the visible chip label for a timeline action target.
 *
 * Go and Back show the sequence cue the backend resolved for the action's timeline position,
 * so the number follows the action when it is moved; without one they show only the clip.
 * Jump shows the cue currently at its stored step, so it stays right when the sequence is
 * reordered.
 */
export function resolveActionDisplayLabel(
  action: TimelineActionKind,
  fallbackLabel: string,
  index: ActionTargetIndex,
  plannedCue?: types.TimelinePlannedCue,
): string {
  switch (action.type) {
    case "FireCue": {
      const cueUid = action.data;
      const cue = index.cueMapByUid.get(normalizeActionTargetUid(cueUid));
      if (!cue) return fallbackLabel;
      const cueLabel =
        cue.identifiers.label.trim() || `Cue ${cue.identifiers.id}`;
      const ref = index.cueSequenceRefByUid.get(
        normalizeActionTargetUid(cueUid),
      );
      if (ref) {
        return `Cue ${ref.sequenceId}.${ref.cueId}: ${cueLabel}`;
      }
      return `Cue ${cue.identifiers.id}: ${cueLabel}`;
    }
    case "StartClip":
    case "StopClip": {
      const clipUid = action.data;
      const clipTuple = index.clipMapByUid.get(
        normalizeActionTargetUid(clipUid),
      );
      if (!clipTuple) return fallbackLabel;
      const clip = clipTuple[0];
      return `Exec ${clip.identifiers.id}: ${clip.identifiers.label}`;
    }
    case "SetClipSpeed": {
      const clipTuple = index.clipMapByUid.get(
        normalizeActionTargetUid(action.data.uid),
      );
      if (!clipTuple) return fallbackLabel;
      const clip = clipTuple[0];
      return `Speed ${action.data.speed.toFixed(2)}x: ${clip.identifiers.label}`;
    }
    case "AdvanceSequence":
    case "BackSequence": {
      const clipUid = action.data;
      const clipTuple = index.clipMapByUid.get(
        normalizeActionTargetUid(clipUid),
      );
      if (!clipTuple) return fallbackLabel;
      const clip = clipTuple[0];
      const verb = action.type === "AdvanceSequence" ? "Go" : "Back";
      const cueRef = sequenceCueRef(
        index,
        plannedCue?.sequence_uid,
        plannedCue?.cue_uid,
      );
      return cueRef
        ? `${verb} ${cueRef}: ${clip.identifiers.label}`
        : `${verb}: ${clip.identifiers.label}`;
    }
    case "JumpToCue": {
      const clipTuple = index.clipMapByUid.get(
        normalizeActionTargetUid(action.data.uid),
      );
      const source = clipTuple?.[0].source;
      if (!clipTuple || source?.type !== "Sequence") return fallbackLabel;
      const cueRef = sequenceCueRef(
        index,
        plannedCue?.sequence_uid ?? source.data,
        plannedCue?.cue_uid ??
          sequenceStepCueUid(index, action.data.uid, action.data.cue_index),
      );
      return cueRef
        ? `Jump ${cueRef}: ${clipTuple[0].identifiers.label}`
        : fallbackLabel;
    }
    case "DeskEval":
      return `Eval: ${action.data}`;
    default:
      return fallbackLabel;
  }
}
