// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { debounce } from "@solid-primitives/scheduled";
import {
  type Accessor,
  createContext,
  createEffect,
  createSignal,
  type JSX,
  onCleanup,
  useContext,
} from "solid-js";
import {
  connectionStatus,
  EngineRuntimeStatus,
  resyncComplete,
} from "../../../lib/engine-runtime";
import {
  flowWaveformToFxWaveform,
  fxWaveformToFlowWaveform,
  startFxPreview,
  stopFxPreview,
  storeFx,
  updateFxPreview,
} from "../../../lib/fx-service";
import { getLogger } from "../../../lib/logger";
import { fx } from "../../../state/appStores";
import type * as types from "../../../types";
import type { FlowWaveform, WaveformKind } from "../../../types";

const log = getLogger(import.meta.url);

export interface FxEditorContextType {
  /** Current FX UID */
  uid: Accessor<string>;
  /** Get waveform for an attribute (FlowWaveform format) */
  getWaveform: (attr: string) => FlowWaveform | undefined;
  /** Get all attribute names */
  getAttributeKeys: () => string[];
  /** Get is_relative flag for an attribute */
  getIsRelative: (attr: string) => boolean;
  /** Update waveform parameters for a specific attribute */
  updateWaveform: (attr: string, updates: Partial<FlowWaveform>) => void;
  /** Change the waveform kind for an attribute */
  setKind: (attr: string, kind: WaveformKind) => void;
  /** Set is_relative flag for an attribute */
  setIsRelative: (attr: string, relative: boolean) => void;
  /** Add a new attribute mapping to the FX */
  addAttribute: (
    attr: string,
    waveform: FlowWaveform,
    isRelative?: boolean,
  ) => void;
  /** Remove an attribute mapping from the FX */
  removeAttribute: (attr: string) => void;
  /** Get current spatial selection */
  selection: Accessor<types.SpatialSelection | undefined>;
  /** Update the FX spatial selection */
  setSelection: (selection: types.SpatialSelection) => void;
  /** Whether local state differs from stored state */
  isDirty: Accessor<boolean>;
  /** Save current state to backend */
  save: () => void;
  /** Whether preview mode is active */
  previewActive: Accessor<boolean>;
  /** Toggle preview mode */
  setPreviewActive: (active: boolean) => void;
}

const FxEditorContext = createContext<FxEditorContextType>();

export interface FxEditorProviderProps {
  children: JSX.Element;
  initialFxUid: string;
}

export function FxEditorProvider(props: FxEditorProviderProps) {
  log.trace("mounting");
  const $fx = useStore(fx);

  // Internal state: FlowWaveform per attribute + is_relative flags
  const [localIdentifiers, setLocalIdentifiers] = createSignal<
    types.Identifiers | undefined
  >();
  const [localUid, setLocalUid] = createSignal<string>("");
  const [localWaveforms, setLocalWaveforms] = createSignal<
    Record<string, FlowWaveform>
  >({});
  const [localIsRelative, setLocalIsRelative] = createSignal<
    Record<string, boolean>
  >({});
  const [localSelection, setLocalSelection] =
    createSignal<types.SpatialSelection>();
  const [isDirty, setIsDirty] = createSignal(false);
  const [previewActive, setPreviewActive] = createSignal(false);
  const [pendingSavedFx, setPendingSavedFx] = createSignal<types.Fx>();

  const fxWaveformEquals = (
    left: types.FxWaveform,
    right: types.FxWaveform,
  ): boolean => {
    return (
      left.params.kind === right.params.kind &&
      left.params.min === right.params.min &&
      left.params.max === right.params.max &&
      left.params.duty_cycle === right.params.duty_cycle &&
      left.phase_range[0] === right.phase_range[0] &&
      left.phase_range[1] === right.phase_range[1] &&
      left.rate.secs === right.rate.secs &&
      left.rate.nanos === right.rate.nanos &&
      left.width === right.width &&
      left.is_relative === right.is_relative
    );
  };

  const fxEquals = (left: types.Fx, right: types.Fx): boolean => {
    if (
      left.identifiers.uid !== right.identifiers.uid ||
      left.identifiers.id !== right.identifiers.id ||
      left.identifiers.label !== right.identifiers.label
    ) {
      return false;
    }

    if (JSON.stringify(left.selection) !== JSON.stringify(right.selection)) {
      return false;
    }

    const leftKeys = Object.keys(left.attributes).sort();
    const rightKeys = Object.keys(right.attributes).sort();
    if (leftKeys.length !== rightKeys.length) {
      return false;
    }

    for (let i = 0; i < leftKeys.length; i++) {
      if (leftKeys[i] !== rightKeys[i]) {
        return false;
      }
      const key = leftKeys[i];
      if (!fxWaveformEquals(left.attributes[key], right.attributes[key])) {
        return false;
      }
    }

    return true;
  };

  // Convert stored Fx to internal format when UID changes or store updates
  createEffect(() => {
    const stored = $fx()[props.initialFxUid];
    const pending = pendingSavedFx();

    // Avoid clobbering local editor state from stale store values immediately
    // after save. Only resume store sync once backend/store reflect the save.
    if (stored && pending) {
      if (!fxEquals(stored, pending)) {
        return;
      }
      setPendingSavedFx(undefined);
    }

    if (stored && !isDirty()) {
      // Convert FxWaveform attributes to FlowWaveform + is_relative
      const waveforms: Record<string, FlowWaveform> = {};
      const isRelative: Record<string, boolean> = {};

      for (const [attr, fxWaveform] of Object.entries(stored.attributes)) {
        waveforms[attr] = fxWaveformToFlowWaveform(fxWaveform);
        isRelative[attr] = fxWaveform.is_relative;
      }

      setLocalIdentifiers(stored.identifiers);
      setLocalUid(stored.identifiers.uid);
      setLocalWaveforms(waveforms);
      setLocalIsRelative(isRelative);
      setLocalSelection(stored.selection);
    }
  });

  /** Build Fx from internal state (for preview/save) */
  const buildFx = (): types.Fx | undefined => {
    const identifiers = localIdentifiers();
    const selection = localSelection();
    if (!identifiers || !selection) return undefined;

    const attributes: Record<string, types.FxWaveform> = {};
    const waveforms = localWaveforms();
    const isRelativeMap = localIsRelative();

    for (const [attr, flowWaveform] of Object.entries(waveforms)) {
      attributes[attr] = flowWaveformToFxWaveform(
        flowWaveform,
        isRelativeMap[attr] ?? false,
      );
    }

    return { identifiers, selection, attributes };
  };

  // Auto-start preview when FX is first loaded
  let hasInitialized = false;

  createEffect(() => {
    const uid = localUid();
    if (uid && !previewActive() && !hasInitialized) {
      hasInitialized = true;
      setPreviewActive(true);
      const built = buildFx();
      if (built) startFxPreview(built);
    }
  });

  // Re-trigger preview upon reconnection after resync is complete
  let wasConnected = connectionStatus() === EngineRuntimeStatus.Connected;
  let shouldRestartPreview = false;

  createEffect(() => {
    const status = connectionStatus();
    const isConnected = status === EngineRuntimeStatus.Connected;

    if (isConnected && !wasConnected) {
      if (previewActive()) {
        shouldRestartPreview = true;
      }
    }

    wasConnected = isConnected;
  });

  createEffect(() => {
    if (resyncComplete() && shouldRestartPreview) {
      const built = buildFx();
      if (built) {
        startFxPreview(built);
        shouldRestartPreview = false;
      }
    }
  });

  // Stop preview when panel is closed
  onCleanup(() => {
    log.trace("unmounting");
    if (previewActive()) {
      stopFxPreview();
    }
  });

  // Debounced preview update (150ms delay for real-time feedback)
  const debouncedPreview = debounce(() => {
    const built = buildFx();
    if (built) {
      updateFxPreview(built);
    }
  }, 150);

  const triggerPreview = () => {
    if (!localUid() || !previewActive()) return;
    debouncedPreview();
  };

  const getWaveform = (attr: string): FlowWaveform | undefined => {
    return localWaveforms()[attr];
  };

  const getAttributeKeys = (): string[] => {
    return Object.keys(localWaveforms());
  };

  const getIsRelative = (attr: string): boolean => {
    return localIsRelative()[attr] ?? false;
  };

  const updateWaveform = (attr: string, updates: Partial<FlowWaveform>) => {
    setLocalWaveforms((prev) => {
      const current = prev[attr];
      if (!current) return prev;
      return { ...prev, [attr]: { ...current, ...updates } };
    });
    setIsDirty(true);
    triggerPreview();
  };

  const setKind = (attr: string, kind: WaveformKind) => {
    updateWaveform(attr, { kind });
  };

  const setIsRelative = (attr: string, relative: boolean) => {
    setLocalIsRelative((prev) => ({ ...prev, [attr]: relative }));
    setIsDirty(true);
    triggerPreview();
  };

  const addAttribute = (
    attr: string,
    waveform: FlowWaveform,
    isRelative = false,
  ) => {
    setLocalWaveforms((prev) => ({ ...prev, [attr]: waveform }));
    setLocalIsRelative((prev) => ({ ...prev, [attr]: isRelative }));
    setIsDirty(true);
    triggerPreview();
  };

  const removeAttribute = (attr: string) => {
    setLocalWaveforms((prev) => {
      const next = { ...prev };
      delete next[attr];
      return next;
    });
    setLocalIsRelative((prev) => {
      const next = { ...prev };
      delete next[attr];
      return next;
    });
    setIsDirty(true);
    triggerPreview();
  };

  const setSelection = (selection: types.SpatialSelection) => {
    setLocalSelection(selection);
    setIsDirty(true);
    triggerPreview();
  };

  const save = () => {
    const built = buildFx();
    if (built) {
      setPendingSavedFx(built);
      storeFx(built);
      setIsDirty(false);
    }
  };

  const handleSetPreviewActive = (active: boolean) => {
    setPreviewActive(active);
    const built = buildFx();
    if (active && built) {
      startFxPreview(built);
    } else {
      stopFxPreview();
    }
  };

  return (
    <FxEditorContext.Provider
      value={{
        uid: localUid,
        getWaveform,
        getAttributeKeys,
        getIsRelative,
        updateWaveform,
        setKind,
        setIsRelative,
        addAttribute,
        removeAttribute,
        selection: localSelection,
        setSelection,
        isDirty,
        save,
        previewActive,
        setPreviewActive: handleSetPreviewActive,
      }}
    >
      {props.children}
    </FxEditorContext.Provider>
  );
}

export function useFxEditor(): FxEditorContextType {
  const context = useContext(FxEditorContext);
  if (!context) {
    throw new Error("useFxEditor must be used within FxEditorProvider");
  }
  return context;
}
