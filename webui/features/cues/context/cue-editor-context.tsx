// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Context provider for cue editor state management.
 *
 * Handles the race condition where dockview restores panel layout
 * before WebSocket cue data arrives. Provides unified loading state
 * and reactive cue data to both the editor grid and properties panel.
 *
 * Also centralizes backend communication for cue updates and preview state.
 *
 * Two usage patterns:
 * 1. Use CueEditorContextProvider with cueUid to create a new context
 * 2. Use createCueEditorContextValue() and pass the value via props to share state
 */

import { useStore } from "@nanostores/solid";
import {
  type Accessor,
  createContext,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  type ParentProps,
  useContext,
} from "solid-js";
import { normalizeFixtureUid } from "../../../lib/binding-utils";
import { formatCueEditorTitle } from "../../../lib/cue-editor-title";
import {
  previewCue,
  sendCueUpdate,
  sendSequenceUpdate,
  stopPreviewInstance,
} from "../../../lib/cue-service";
import { getLogger } from "../../../lib/logger";
import { setStoreAction } from "../../../lib/nanostore-action";
import {
  hasCueInstructionRows,
  projectReleaseCueFromSequence,
  releaseCueProjectionSignature,
} from "../../../lib/release-cue-scaffold";
import {
  activeInstances,
  cueDefinitionsLoaded,
  cues,
  sequenceDefinitionsLoaded,
  sequences,
} from "../../../state/appStores";
import type * as types from "../../../types";

const log = getLogger(import.meta.url);

export { formatCueEditorTitle } from "../../../lib/cue-editor-title";

type CueLoadingState =
  | { status: "loading" }
  | { status: "loaded"; cue: types.Cue }
  | { status: "not_found"; cueUid: string };

export interface CueEditorContextType {
  /** The cue UID being edited */
  cueUid: string;
  /** Sequence ID containing the cue, when known. */
  sequenceId: Accessor<number | undefined>;
  /** Part ID being edited. Part 0 maps to legacy cue instructions. */
  partId: number;
  /** Current loading state with cue data when loaded */
  loadingState: Accessor<CueLoadingState>;
  /** Convenience accessor for the cue (undefined if not loaded) */
  cue: Accessor<types.Cue | undefined>;
  /** Whether this editor is editing the built-in setup cue for a sequence. */
  isSetupCue: boolean;
  /** Whether this editor is projecting the built-in release cue for a sequence. */
  isReleaseCue: boolean;
  /** Sequence UID whose built-in release cue is being edited, if applicable. */
  releaseSequenceUid?: string;
  /** Live-projected release cue rows that should be persisted when they change. */
  releaseCueProjection: Accessor<types.Cue | undefined>;
  /** Projected release cue payload when it differs from stored sequence data. */
  releaseCueProjectionUpdate: Accessor<types.Cue | undefined>;
  /** Label for the active part. */
  partLabel: Accessor<string>;
  /** Label for the properties panel header */
  label: Accessor<string>;

  // Backend communication
  /** Send a cue update to the backend */
  updateCue: (cue: types.Cue) => void;
  /** Commit an edited cue after the editor UI has yielded. */
  commitEditedCue: (cue: types.Cue) => void;

  // Preview state
  /** Whether preview mode is active */
  previewActive: Accessor<boolean>;
  activePreviewPlayback: Accessor<types.InstanceInfo | undefined>;
  /** Whether preview should apply cue transitions */
  previewApplyTransitions: Accessor<boolean>;
  /** Timestamp for the current preview transition span, if transitions apply */
  previewStartedAtMs: Accessor<number | undefined>;
  /** Toggle preview mode on/off */
  setPreviewActive: (active: boolean) => void;
  /** Toggle whether preview applies cue transitions */
  setPreviewApplyTransitions: (enabled: boolean) => void;
  /** Retrigger the current cue preview from the start */
  previewReplayActiveCue: () => void;
  /** Finish the current cue preview immediately without transitions */
  previewTerminateTransitions: () => void;
  /** Update the preview with modified cue data (only if preview is active) */
  updatePreview: (cue: types.Cue) => void;
}

const CueEditorContext = createContext<CueEditorContextType>();

/**
 * Creates the cue editor context value with state management.
 * Can be used directly without the Provider component.
 *
 * Must be called within a reactive context (component or createRoot) for
 * cleanup to work properly.
 */
export function createCueEditorContextValue(
  cueUid: string,
  options: {
    initialPartId?: number;
    initialSequenceId?: number;
    initialSequenceUid?: string;
    closeOnSequenceDelete?: boolean;
    setupSequenceUid?: string;
    releaseSequenceUid?: string;
  } = {},
): CueEditorContextType {
  log.trace("creating CueEditorContextValue", cueUid, options);

  const $activeInstances = useStore(activeInstances);
  const $cueDefinitionsLoaded = useStore(cueDefinitionsLoaded);
  const $sequenceDefinitionsLoaded = useStore(sequenceDefinitionsLoaded);
  const partId = options.initialPartId ?? 0;
  const [cueStoreRevision, setCueStoreRevision] = createSignal(0);
  const [sequenceStoreRevision, setSequenceStoreRevision] = createSignal(0);
  const [previewActiveSignal, setPreviewActiveSignal] = createSignal(false);
  const [previewPending, setPreviewPending] = createSignal(false);
  const [previewPlaybackSeen, setPreviewPlaybackSeen] = createSignal(false);
  const [activePreviewInstanceId, setActivePreviewInstanceId] =
    createSignal<types.InstanceId>();
  const [previewApplyTransitions, setPreviewApplyTransitionsSignal] =
    createSignal(true);
  const [previewStartedAtMs, setPreviewStartedAtMs] = createSignal<number>();
  let previewLifecycleToken = 0;
  let previewStartInFlight = false;
  let queuedPreviewCue: types.Cue | undefined;

  /** Tracks cue store broadcasts that replace data under an existing cue UID. */
  const unsubscribeFromCueStore = cues.listen(() => {
    setCueStoreRevision((revision) => revision + 1);
  });

  /** Tracks sequence broadcasts that replace embedded setup/release cue data. */
  const unsubscribeFromSequenceStore = sequences.listen(() => {
    setSequenceStoreRevision((revision) => revision + 1);
  });

  /** Returns the sequence that owns this editor's built-in setup cue. */
  const setupSequence = createMemo(() => {
    sequenceStoreRevision();
    return options.setupSequenceUid
      ? sequences.get()[options.setupSequenceUid]
      : undefined;
  });

  /** Returns the sequence that owns this editor's built-in release cue. */
  const releaseSequence = createMemo(() => {
    sequenceStoreRevision();
    return options.releaseSequenceUid
      ? sequences.get()[options.releaseSequenceUid]
      : undefined;
  });

  const isSetupCue = options.setupSequenceUid !== undefined;
  const isReleaseCue = options.releaseSequenceUid !== undefined;

  /** Returns the sequence that explicitly owns this editor's cue, if known. */
  const owningSequence = createMemo(() => {
    sequenceStoreRevision();
    if (options.initialSequenceUid) {
      return sequences.get()[options.initialSequenceUid];
    }
    if (options.setupSequenceUid) {
      return sequences.get()[options.setupSequenceUid];
    }
    if (options.releaseSequenceUid) {
      return sequences.get()[options.releaseSequenceUid];
    }
    return undefined;
  });

  /** Derives value-bearing release cue rows from the owning sequence. */
  const releaseCueProjection = createMemo(() => {
    cueStoreRevision();
    const releaseOwner = releaseSequence();
    if (!releaseOwner) return undefined;

    const projectedCue = projectReleaseCueFromSequence(
      releaseOwner,
      cues.get(),
    );
    return hasCueInstructionRows(projectedCue) ? projectedCue : undefined;
  });

  /** Returns the projected release cue only when stored sequence data is stale. */
  const releaseCueProjectionUpdate = createMemo(() => {
    const releaseOwner = releaseSequence();
    const projectedCue = releaseCueProjection();
    if (!releaseOwner || !projectedCue) return undefined;
    return releaseCueProjectionSignature(projectedCue) ===
      releaseCueProjectionSignature(releaseOwner.release_cue)
      ? undefined
      : projectedCue;
  });

  /** Stops any active cue preview when the shared editor context is disposed. */
  onCleanup(() => {
    log.trace("cleaning up CueEditorContextValue");
    unsubscribeFromCueStore();
    unsubscribeFromSequenceStore();
    const instanceId = activePreviewInstanceId();
    if (instanceId) {
      void stopPreviewInstance(instanceId);
    }
    previewLifecycleToken += 1;
    previewStartInFlight = false;
    queuedPreviewCue = undefined;
  });

  /** Finds the active playback owned by this cue editor context. */
  const activePreviewPlayback = createMemo(() => {
    const instanceId = activePreviewInstanceId();
    if (!instanceId) return undefined;
    const normalizedInstanceId = normalizeFixtureUid(instanceId).toLowerCase();
    return Object.values($activeInstances()).find(
      (playback) =>
        normalizeFixtureUid(playback.instance_id).toLowerCase() ===
        normalizedInstanceId,
    );
  });

  /** Reports preview activity from local pending state and server playback state. */
  const previewActive = createMemo(
    () => previewPending() || activePreviewPlayback() !== undefined,
  );

  /** Clears local preview UI state when the server-side preview instance stops. */
  createEffect(() => {
    const playback = activePreviewPlayback();
    const pending = previewPending();
    if (playback) {
      setPreviewPlaybackSeen(true);
      if (pending) {
        setPreviewPending(false);
      }
      return;
    }
    if (!previewActiveSignal()) return;
    if (pending && !previewPlaybackSeen()) return;
    setPreviewPending(false);
    setPreviewPlaybackSeen(false);
    setPreviewActiveSignal(false);
    setActivePreviewInstanceId(undefined);
    setPreviewStartedAtMs(undefined);
  });

  /** Tracks whether cue data is still loading, loaded, or absent from the store. */
  const loadingState = createMemo((): CueLoadingState => {
    cueStoreRevision();
    const cueMap = cues.get();
    if (isSetupCue || isReleaseCue) {
      if (!$sequenceDefinitionsLoaded()) {
        return { status: "loading" };
      }
    } else if (!$cueDefinitionsLoaded()) {
      return { status: "loading" };
    }

    if (
      options.closeOnSequenceDelete &&
      options.initialSequenceUid &&
      $sequenceDefinitionsLoaded() &&
      !owningSequence()
    ) {
      return { status: "not_found", cueUid };
    }

    const setupOwner = setupSequence();
    if (setupOwner) {
      return {
        status: "loaded",
        cue: setupOwner.setup_cue,
      };
    }

    if (options.setupSequenceUid) {
      return { status: "not_found", cueUid };
    }

    const releaseOwner = releaseSequence();
    if (releaseOwner) {
      return {
        status: "loaded",
        cue: releaseCueProjection() ?? releaseOwner.release_cue,
      };
    }

    if (options.releaseSequenceUid) {
      return { status: "not_found", cueUid };
    }

    const cue = cueMap[cueUid];
    if (cue) {
      return { status: "loaded", cue };
    }

    // Cues have loaded but this one wasn't found
    return { status: "not_found", cueUid };
  });

  /** Returns the loaded cue while keeping callers independent from loading state shape. */
  const cue = createMemo(() => {
    const state = loadingState();
    return state.status === "loaded" ? state.cue : undefined;
  });

  /** Resolves the containing sequence ID from explicit panel state or store membership. */
  const sequenceId = createMemo(() => {
    sequenceStoreRevision();
    const owner = owningSequence();
    if (owner) {
      return owner.identifiers.id;
    }

    for (const sequence of Object.values(sequences.get())) {
      if (sequence.steps.includes(cueUid)) {
        return sequence.identifiers.id;
      }
    }

    if (options.initialSequenceId !== undefined) {
      return options.initialSequenceId;
    }

    return undefined;
  });

  /** Builds the display label for the active cue part. */
  const partLabel = createMemo(() => {
    const currentCue = cue();
    if (!currentCue) return `p${partId}`;
    if (partId === 0) {
      return currentCue.identifiers.label || "Part 0";
    }
    return (
      currentCue.parts?.find((part) => part.identifiers.id === partId)
        ?.identifiers.label || `Part ${partId}`
    );
  });

  /** Builds the properties-panel label from the current load state. */
  const label = createMemo(() => {
    const state = loadingState();
    switch (state.status) {
      case "loading":
        return "Cue Loading...";
      case "loaded":
        return formatCueEditorTitle({
          cueId: state.cue.identifiers.id,
          sequenceId: sequenceId(),
          partId,
          hasAdditionalParts: (state.cue.parts?.length ?? 0) > 0,
          isSetupCue: options.setupSequenceUid !== undefined,
          isReleaseCue: options.releaseSequenceUid !== undefined,
        });
      case "not_found":
        return "Cue Not Found";
    }
  });

  /** Optimistically updates the cue store and sends the cue definition to the backend. */
  const updateCue = (updatedCue: types.Cue) => {
    const setupOwner = setupSequence();
    if (setupOwner) {
      const updatedSequence = {
        ...setupOwner,
        setup_cue: updatedCue,
      };
      setStoreAction(sequences, "Update Setup Cue Sequence", {
        ...sequences.get(),
        [updatedSequence.identifiers.uid]: updatedSequence,
      });
      sendSequenceUpdate(updatedSequence);
      return;
    }

    const releaseOwner = releaseSequence();
    if (releaseOwner) {
      const updatedSequence = {
        ...releaseOwner,
        release_cue: updatedCue,
      };
      setStoreAction(sequences, "Update Release Cue Sequence", {
        ...sequences.get(),
        [updatedSequence.identifiers.uid]: updatedSequence,
      });
      sendSequenceUpdate(updatedSequence);
      return;
    }

    setStoreAction(cues, "Update Cue", {
      ...cues.get(),
      [updatedCue.identifiers.uid]: updatedCue,
    });
    sendCueUpdate(updatedCue);
  };

  let pendingEditedCue: types.Cue | undefined;
  let pendingEditedCueFrame: number | undefined;

  /** Cancels any scheduled edited-cue commit. */
  const cancelPendingEditedCueCommit = () => {
    if (pendingEditedCueFrame === undefined) return;
    cancelAnimationFrame(pendingEditedCueFrame);
    pendingEditedCueFrame = undefined;
  };

  /** Schedules optimistic persistence after inline editor teardown can paint. */
  const commitEditedCue = (updatedCue: types.Cue) => {
    pendingEditedCue = updatedCue;
    cancelPendingEditedCueCommit();
    pendingEditedCueFrame = requestAnimationFrame(() => {
      pendingEditedCueFrame = undefined;
      const cueToCommit = pendingEditedCue;
      pendingEditedCue = undefined;
      if (!cueToCommit) return;
      updateCue(cueToCommit);
      updatePreview(cueToCommit);
    });
  };

  onCleanup(() => {
    cancelPendingEditedCueCommit();
    pendingEditedCue = undefined;
  });

  /** Returns a cue payload suitable for preview, optionally stripping transitions. */
  const toPreviewCue = (
    cue: types.Cue,
    options: { applyTransitions?: boolean } = {},
  ): types.Cue => {
    if (options.applyTransitions ?? previewApplyTransitions()) return cue;

    const zeroTransitionMode: types.TransitionMode = {
      type: "Fixed",
      data: { secs: 0, nanos: 0 },
    };
    const previewCue: types.Cue = JSON.parse(JSON.stringify(cue));
    previewCue.transitions = {
      ...previewCue.transitions,
      fade_in: zeroTransitionMode,
      delay_in: zeroTransitionMode,
      fade_out: zeroTransitionMode,
      delay_out: zeroTransitionMode,
    };
    previewCue.transitions_by_attribute = {};
    for (const instruction of previewCue.instructions) {
      instruction.cue_instruction.transitions = {};
      instruction.cue_instruction.transitions_by_attribute = {};
      instruction.cue_instruction.transitions_by_fixture_attribute = [];
    }
    for (const part of previewCue.parts ?? []) {
      part.transitions = {
        ...part.transitions,
        fade_in: zeroTransitionMode,
        delay_in: zeroTransitionMode,
        fade_out: zeroTransitionMode,
        delay_out: zeroTransitionMode,
      };
      part.transitions_by_attribute = {};
      for (const instruction of part.instructions) {
        instruction.cue_instruction.transitions = {};
        instruction.cue_instruction.transitions_by_attribute = {};
        instruction.cue_instruction.transitions_by_fixture_attribute = [];
      }
    }
    return previewCue;
  };

  /** Starts or stops live cue preview and resets the preview progress clock. */
  const publishPreviewCue = (previewCuePayload: types.Cue) => {
    const instanceId = activePreviewInstanceId();
    setPreviewPending(true);
    if (!instanceId && previewStartInFlight) {
      queuedPreviewCue = previewCuePayload;
      return;
    }

    const token = previewLifecycleToken;
    previewStartInFlight = instanceId ? previewStartInFlight : true;
    previewCue(previewCuePayload, instanceId)
      .then((returnedInstanceId) => {
        if (!instanceId) {
          previewStartInFlight = false;
        }
        if (token !== previewLifecycleToken) {
          void stopPreviewInstance(returnedInstanceId);
          return;
        }
        setActivePreviewInstanceId(returnedInstanceId);
        const queuedCue = queuedPreviewCue;
        queuedPreviewCue = undefined;
        if (queuedCue) {
          previewCue(queuedCue, returnedInstanceId).catch((error) => {
            log.error("Failed to update queued cue preview", error);
          });
        }
      })
      .catch((error) => {
        if (!instanceId) {
          previewStartInFlight = false;
        }
        if (token !== previewLifecycleToken) return;
        log.error("Failed to update cue preview", error);
        setPreviewPending(false);
        setPreviewActiveSignal(false);
      });
  };

  /** Starts or stops live cue preview and resets the preview progress clock. */
  const setPreviewActive = (active: boolean) => {
    const currentCue = cue();
    if (active && currentCue) {
      setPreviewActiveSignal(true);
      setPreviewPlaybackSeen(false);
      publishPreviewCue(toPreviewCue(currentCue));
      setPreviewStartedAtMs(
        previewApplyTransitions() ? performance.now() : undefined,
      );
    } else if (!active) {
      previewLifecycleToken += 1;
      previewStartInFlight = false;
      queuedPreviewCue = undefined;
      const instanceId = activePreviewInstanceId();
      setPreviewPending(false);
      setPreviewPlaybackSeen(false);
      setPreviewActiveSignal(false);
      setActivePreviewInstanceId(undefined);
      if (instanceId) {
        void stopPreviewInstance(instanceId);
      }
      setPreviewStartedAtMs(undefined);
    }
  };

  /** Pushes edited cue data into an already-running preview. */
  const updatePreview = (updatedCue: types.Cue) => {
    if (previewActive()) {
      publishPreviewCue(toPreviewCue(updatedCue));
      setPreviewStartedAtMs(
        previewApplyTransitions() ? performance.now() : undefined,
      );
    }
  };

  /** Toggles preview transition handling and restarts preview timing if active. */
  const setPreviewApplyTransitions = (enabled: boolean) => {
    setPreviewApplyTransitionsSignal(enabled);
    const currentCue = cue();
    if (!previewActive() || !currentCue) return;
    publishPreviewCue(toPreviewCue(currentCue));
    setPreviewStartedAtMs(enabled ? performance.now() : undefined);
  };

  /** Retriggers the active cue preview from the beginning. */
  const previewReplayActiveCue = () => {
    const currentCue = cue();
    if (!currentCue) return;
    const previewCuePayload = toPreviewCue(currentCue);
    if (!previewActive()) {
      setPreviewActiveSignal(true);
      setPreviewPlaybackSeen(false);
    }
    publishPreviewCue(previewCuePayload);
    setPreviewStartedAtMs(
      previewApplyTransitions() ? performance.now() : undefined,
    );
  };

  /** Forces the preview to its no-transition end state. */
  const previewTerminateTransitions = () => {
    const currentCue = cue();
    if (!previewActive() || !currentCue) return;
    publishPreviewCue(toPreviewCue(currentCue, { applyTransitions: false }));
    setPreviewStartedAtMs(undefined);
  };

  return {
    cueUid,
    sequenceId,
    partId,
    loadingState,
    cue,
    isSetupCue,
    isReleaseCue,
    releaseSequenceUid: options.releaseSequenceUid,
    releaseCueProjection,
    releaseCueProjectionUpdate,
    partLabel,
    label,
    updateCue,
    commitEditedCue,
    previewActive,
    activePreviewPlayback,
    previewApplyTransitions,
    previewStartedAtMs,
    setPreviewActive,
    setPreviewApplyTransitions,
    previewReplayActiveCue,
    previewTerminateTransitions,
    updatePreview,
  };
}

export type CueEditorContextProviderProps = ParentProps<
  | {
      /** Pre-created context value to use (for sharing between multiple consumers) */
      value: CueEditorContextType;
    }
  | {
      /** Cue UID to create a new context for */
      cueUid: string;
    }
>;

/**
 * Provider component that wraps children with CueEditorContext.
 *
 * Can accept either:
 * - A pre-created context value via `value` prop (for sharing between multiple consumers)
 * - A `cueUid` prop to create a new context value
 */
export function CueEditorContextProvider(props: CueEditorContextProviderProps) {
  log.trace("mounting CueEditorContextProvider");
  onCleanup(() => log.trace("unmounting CueEditorContextProvider"));

  const contextValue =
    "value" in props ? props.value : createCueEditorContextValue(props.cueUid);

  return (
    <CueEditorContext.Provider value={contextValue}>
      {props.children}
    </CueEditorContext.Provider>
  );
}

/** Reads the cue editor context from the nearest provider. */
export function useCueEditorContext(): CueEditorContextType {
  const context = useContext(CueEditorContext);
  if (!context) {
    throw new Error(
      "useCueEditorContext must be used within CueEditorContextProvider",
    );
  }
  return context;
}
