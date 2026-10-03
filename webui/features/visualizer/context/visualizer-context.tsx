// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import {
  type Accessor,
  createContext,
  createSignal,
  type ParentProps,
  useContext,
} from "solid-js";
import { commandEnvelope } from "../../../lib/command-envelope";
import { engineRuntime } from "../../../lib/engine-runtime";
import { setStoreAction } from "../../../lib/nanostore-action";
import type * as types from "../../../types";
import type { VisualizerInteractionMode } from "../rendering/renderers/renderer-api";
import {
  type VisualizerQualityPreset,
  visualizerEffectiveQuality,
  visualizerQualityOverride,
  visualizerQualityPreset,
  visualizerSnapPointsEnabled,
} from "../state/settings";

const DEFAULT_VISUALIZER_TOOL_MODE: VisualizerInteractionMode = "camera";
export type QualityPreset = VisualizerQualityPreset;
/** Quality currently rendering, so Settings reflects a diagnostic URL override rather than only the saved preset. */
export const visualizerQuality = visualizerEffectiveQuality;

/**
 * Saves the user's quality choice and drops any diagnostic URL override, so the
 * chosen preset renders even when it equals the already-saved preset.
 */
export function setVisualizerQuality(quality: QualityPreset): void {
  visualizerQualityOverride.set(undefined);
  setStoreAction(visualizerQualityPreset, "Set Visualizer Quality", quality);
}

interface VisualizerSelectionModifiers {
  shiftKey: boolean;
  ctrlOrMetaKey: boolean;
}

/**
 * Deduplicates selected fixture UIDs while preserving their first-seen order.
 */
function toUniqueUids(uids: readonly string[]): string[] {
  return Array.from(new Set(uids));
}

function createResolvedSelectionExpr(
  uids: readonly string[],
): types.SelectionExpr {
  const uniqueUids = toUniqueUids(uids);
  return {
    type: "Resolved",
    data: uniqueUids.map((uid) => ({
      fixture_uid: uid,
    })),
  };
}

function buildProgrammerSelectionCommand(
  uids: readonly string[],
  modifiers: VisualizerSelectionModifiers,
): types.ProgrammerCommand | null {
  const uniqueUids = toUniqueUids(uids);
  const selectionExpr = createResolvedSelectionExpr(uniqueUids);

  if (modifiers.ctrlOrMetaKey) {
    if (uniqueUids.length === 0) return null;
    return {
      type: "RemoveProgrammerSelection",
      data: selectionExpr,
    };
  }

  if (modifiers.shiftKey) {
    if (uniqueUids.length === 0) return null;
    return {
      type: "AddProgrammerSelection",
      data: selectionExpr,
    };
  }

  return {
    type: "SetProgrammerSelection",
    data: selectionExpr,
  };
}

export type VisualizerContextType = {
  panelId: string;
  toolMode: Accessor<VisualizerInteractionMode>;
  setToolMode: (mode: VisualizerInteractionMode) => void;
  showEmitters: Accessor<boolean>;
  setShowEmitters: (enabled: boolean) => void;
  showGrid: Accessor<boolean>;
  setShowGrid: (enabled: boolean) => void;
  showLabels: Accessor<boolean>;
  setShowLabels: (enabled: boolean) => void;
  toggleShowLabels: () => void;
  sendProgrammerCommand: (
    command: types.ProgrammerCommand,
    batchId?: string,
  ) => void;
  dispatchProgrammerSelectionCommand: (
    uids: readonly string[],
    modifiers: VisualizerSelectionModifiers,
  ) => void;
};

export type VisualizerContextValueOptions = {
  panelId: string;
  initialToolMode?: VisualizerInteractionMode;
  initialShowEmitters?: boolean;
  initialShowGrid?: boolean;
};

const VisualizerContext = createContext<VisualizerContextType>();

export type VisualizerContextProviderProps = ParentProps<{
  value: VisualizerContextType;
}>;

/**
 * Creates panel-scoped VIS2 UI/tool state and actions.
 * Must be called within component/createRoot scope.
 */
export function createVisualizerContextValue(
  options: VisualizerContextValueOptions,
): VisualizerContextType {
  const [toolMode, setToolMode] = createSignal<VisualizerInteractionMode>(
    options.initialToolMode ?? DEFAULT_VISUALIZER_TOOL_MODE,
  );
  const [showEmitters, setShowEmitters] = createSignal(
    options.initialShowEmitters ?? false,
  );
  const [showGrid, setShowGrid] = createSignal(options.initialShowGrid ?? true);
  const $showLabels = useStore(visualizerSnapPointsEnabled);

  const setShowLabels = (enabled: boolean) => {
    setStoreAction(
      visualizerSnapPointsEnabled,
      "Set Visualizer Snap Points",
      enabled,
    );
  };

  const toggleShowLabels = () => {
    setStoreAction(
      visualizerSnapPointsEnabled,
      "Toggle Visualizer Snap Points",
      !$showLabels(),
    );
  };

  /** Sends a programmer command, optionally grouped with related undo commands. */
  const sendProgrammerCommand = (
    command: types.ProgrammerCommand,
    batchId?: string,
  ) => {
    engineRuntime.sendCommand(
      commandEnvelope("ProgrammerCommand", command, batchId),
    );
  };

  const dispatchProgrammerSelectionCommand = (
    uids: readonly string[],
    modifiers: VisualizerSelectionModifiers,
  ) => {
    const command = buildProgrammerSelectionCommand(uids, modifiers);
    if (!command) return;
    sendProgrammerCommand(command);
  };

  return {
    panelId: options.panelId,
    toolMode,
    setToolMode,
    showEmitters,
    setShowEmitters,
    showGrid,
    setShowGrid,
    showLabels: () => $showLabels(),
    setShowLabels,
    toggleShowLabels,
    sendProgrammerCommand,
    dispatchProgrammerSelectionCommand,
  };
}

export function VisualizerContextProvider(
  props: VisualizerContextProviderProps,
) {
  return (
    <VisualizerContext.Provider value={props.value}>
      {props.children}
    </VisualizerContext.Provider>
  );
}

export function useVisualizerContext(): VisualizerContextType {
  const context = useContext(VisualizerContext);
  if (!context) {
    throw new Error(
      "useVisualizerContext must be used within a VisualizerContextProvider",
    );
  }
  return context;
}
