// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import {
  type Accessor,
  createEffect,
  createMemo,
  createSignal,
} from "solid-js";
import { useSharedStore } from "../../../lib/use-shared-store";
import { resolveSpatialSelection } from "../../../lib/wasm-bridge";
import {
  fixtures as fixturesStore,
  groups as groupsStore,
} from "../../../state/appStores";
import type * as types from "../../../types";
import { getTargetFixtureAttributes } from "../model/fixture-attributes";
import {
  type StepFxPhaseMarker,
  stepFxAttributeName,
  stepFxFixtureRefLabel,
  stepFxPhaseOffset,
  stepFxSelectionProjectionToken,
  stepFxStartPositionMode,
} from "../model/step-fx-editor-model";
import type { StepFxEditorViewportState } from "../model/step-fx-editor-viewport";

interface StepFxSelectionProjectionInput {
  selection: types.SpatialSelection | undefined;
  fixtures: Record<string, types.Fixture>;
  groups: Record<string, types.Group>;
  token: string;
}

interface StepFxEditorPhaseControllerOptions {
  draft: Accessor<types.StepFx | undefined>;
  activeLane: Accessor<types.FxLane | undefined>;
  initialViewport: StepFxEditorViewportState;
}

/**
 * Resolves the draft's spatial selection into phase markers and owns the
 * waveform preview index and playhead display options derived from them.
 */
export function createStepFxEditorPhaseController(
  options: StepFxEditorPhaseControllerOptions,
) {
  const { draft, activeLane, initialViewport } = options;
  const $fixtures = useSharedStore(fixturesStore);
  const $groups = useStore(groupsStore);
  const [phaseMarkers, setPhaseMarkers] = createSignal<StepFxPhaseMarker[]>([]);
  const [phaseIssues, setPhaseIssues] = createSignal<string[]>([]);
  const [targetFixtureRefs, setTargetFixtureRefs] = createSignal<
    types.FixtureRef[]
  >([]);
  const [previewIndex, setPreviewIndex] = createSignal(0);
  const [showAllPlayheads, setShowAllPlayheads] = createSignal(
    initialViewport.showAllPlayheads,
  );
  const [spreadEditing, setSpreadEditing] = createSignal(false);
  const [centerSelectedFixture, setCenterSelectedFixture] = createSignal(
    initialViewport.centerSelectedFixture,
  );
  let previewIndexRestored = initialViewport.previewIndex === 0;

  /** Resolves the overall or lane-specific phase applied to the active graph. */
  const effectivePhase = createMemo(
    () => activeLane()?.phase_override ?? draft()?.phase,
  );

  /** Resolves the selected index's normalized cycle phase for live sampling. */
  const previewPhaseOffset = createMemo(() => {
    const phase = effectivePhase();
    return phase
      ? stepFxPhaseOffset(phase, previewIndex(), phaseMarkers().length)
      : 0;
  });

  /** Resolves every selection index's normalized cycle phase for waveform overlays. */
  const previewPhaseOffsets = createMemo(() => {
    const phase = effectivePhase();
    const count = phaseMarkers().length;
    return phase
      ? Array.from({ length: count }, (_, index) =>
          stepFxPhaseOffset(phase, index, count),
        )
      : [];
  });

  /** Reports whether authored phase waypoints span at least one complete cycle. */
  const previewPhaseWrapsCycle = createMemo(() => {
    const waypoints = effectivePhase()?.waypoints ?? [];
    if (waypoints.length < 2) return false;
    return Math.max(...waypoints) - Math.min(...waypoints) >= 1 - 1e-6;
  });

  /** Reports whether phase positions produce distinct fixture playheads. */
  const phaseHasSpread = createMemo(
    () =>
      stepFxStartPositionMode(effectivePhase() ?? { waypoints: [] }) !==
      "together",
  );

  /** Returns the signed distance between the first and last authored phase positions. */
  const phaseSpread = createMemo(() => {
    const waypoints = effectivePhase()?.waypoints ?? [];
    return waypoints.length > 1
      ? waypoints[waypoints.length - 1] - waypoints[0]
      : 0;
  });

  /** Temporarily reveals every phase playhead while a spread is being authored. */
  const effectiveShowAllPlayheads = createMemo(
    () => spreadEditing() || (phaseHasSpread() && showAllPlayheads()),
  );

  /** Snapshots only the draft and show data that can change concrete fixture targets. */
  const selectionProjectionInput = createMemo(
    (): StepFxSelectionProjectionInput => {
      const selection = draft()?.selection;
      const fixtures = $fixtures();
      const groups = $groups();
      return {
        selection,
        fixtures,
        groups,
        token: stepFxSelectionProjectionToken(selection, fixtures, groups),
      };
    },
    undefined,
    {
      equals: (previous, current) => previous.token === current.token,
    },
  );

  /** Lists target-fixture and already-authored attributes without duplicates. */
  const availableAttributes = createMemo(() => {
    const names = new Set(
      getTargetFixtureAttributes(
        Object.values($fixtures()),
        targetFixtureRefs(),
      ),
    );
    for (const lane of draft()?.lanes ?? [])
      names.add(stepFxAttributeName(lane.attribute));
    return Array.from(names).sort();
  });

  /** Keeps the waveform preview index valid as the resolved selection changes. */
  createEffect(() => {
    const count = phaseMarkers().length;
    const clamped = Math.max(0, Math.min(count - 1, previewIndex()));
    if (clamped !== previewIndex()) setPreviewIndex(clamped);
  });

  /** Resolves the draft selection into representative phase markers. */
  createEffect(() => {
    const { selection, fixtures, groups, token } = selectionProjectionInput();
    setTargetFixtureRefs([]);
    if (!selection) return;
    void projectStepFxSelection(selection, fixtures, groups).then((result) => {
      if (token !== selectionProjectionInput().token) return;
      setPhaseMarkers(result.markers);
      setPhaseIssues(result.issues);
      setTargetFixtureRefs(result.targets);
      if (!previewIndexRestored && result.markers.length > 0) {
        previewIndexRestored = true;
        setPreviewIndex(
          Math.min(initialViewport.previewIndex, result.markers.length - 1),
        );
      }
    });
  });

  /**
   * Returns the preview index to persist: the stored index until the first
   * projection restores it, then the live index. Reads the live signal only
   * once restored so callers track it under the same conditions.
   */
  const persistedPreviewIndex = (): number =>
    previewIndexRestored ? previewIndex() : initialViewport.previewIndex;

  return {
    phaseMarkers,
    phaseIssues,
    previewIndex,
    setPreviewIndex,
    showAllPlayheads,
    setShowAllPlayheads,
    spreadEditing,
    setSpreadEditing,
    centerSelectedFixture,
    setCenterSelectedFixture,
    effectivePhase,
    previewPhaseOffset,
    previewPhaseOffsets,
    previewPhaseWrapsCycle,
    phaseHasSpread,
    phaseSpread,
    effectiveShowAllPlayheads,
    availableAttributes,
    persistedPreviewIndex,
  };
}

/** Phase projection and waveform preview state for one Step FX editor. */
export type StepFxEditorPhaseController = ReturnType<
  typeof createStepFxEditorPhaseController
>;

/** Resolves concrete targets and representative phase markers for one stored selection. */
async function projectStepFxSelection(
  selection: types.SpatialSelection,
  fixtures: Record<string, types.Fixture>,
  groups: Record<string, types.Group>,
): Promise<{
  markers: StepFxPhaseMarker[];
  issues: string[];
  targets: types.FixtureRef[];
}> {
  const projected = await resolveSpatialSelection(selection, fixtures, groups);
  const indexes = projected?.resolved.indexes ?? [];
  return {
    markers: indexes
      .filter((index) => index.members.length > 0)
      .map((index) => ({
        index: index.index,
        memberCount: index.members.length,
        members: index.members
          .map((member) => stepFxFixtureRefLabel(member.fixture, fixtures))
          .join(", "),
      })),
    issues: projected?.issues ?? ["Selection projection failed"],
    targets: indexes.flatMap((index) =>
      index.members.map((member) => ({ ...member.fixture })),
    ),
  };
}
