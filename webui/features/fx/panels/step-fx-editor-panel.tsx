// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { ArrowDownIcon } from "@squidlab/phosphor-solid/arrow-down";
import { ArrowLeftIcon } from "@squidlab/phosphor-solid/arrow-left";
import { ArrowRightIcon } from "@squidlab/phosphor-solid/arrow-right";
import { ArrowUpIcon } from "@squidlab/phosphor-solid/arrow-up";
import { ArrowsLeftRightIcon } from "@squidlab/phosphor-solid/arrows-left-right";
import { CaretDownIcon } from "@squidlab/phosphor-solid/caret-down";
import { CaretLeftIcon } from "@squidlab/phosphor-solid/caret-left";
import { CaretRightIcon } from "@squidlab/phosphor-solid/caret-right";
import { CopySimpleIcon } from "@squidlab/phosphor-solid/copy-simple";
import { DivideIcon } from "@squidlab/phosphor-solid/divide";
import { MouseScrollIcon } from "@squidlab/phosphor-solid/mouse-scroll";
import { PlayIcon } from "@squidlab/phosphor-solid/play";
import { PlusIcon } from "@squidlab/phosphor-solid/plus";
import { SelectionIcon } from "@squidlab/phosphor-solid/selection";
import { StopIcon } from "@squidlab/phosphor-solid/stop";
import { TrashIcon } from "@squidlab/phosphor-solid/trash";
import { WarningIcon } from "@squidlab/phosphor-solid/warning";
import type { DockviewPanelApi } from "dockview-core";
import {
  batch,
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { Dynamic } from "solid-js/web";
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "../../../components/ui/dropdown-menu";
import {
  Checkbox,
  Input,
  NativeSelect,
  Radio,
} from "../../../components/ui/form-controls";
import PanelToolbar from "../../../components/ui/panel-toolbar";
import { RangeSlider } from "../../../components/ui/range-slider";
import { Table } from "../../../components/ui/table";
import {
  ToggleToolbarButton,
  ToolbarButton,
} from "../../../components/ui/toolbar-button";
import Tooltip from "../../../components/ui/tooltip";
import VerticalLayoutSplitter from "../../../components/ui/vertical-layout-splitter";
import CrudLabelProperties from "../../../components/widgets/crud/crud-label-properties";
import DeleteConfirmModal from "../../../components/widgets/delete-confirm-dialog";
import { getAttributeMetadata } from "../../../lib/attribute-metadata";
import { durationToSeconds } from "../../../lib/duration";
import {
  registerComponentFocus,
  useKeyboardShortcut,
} from "../../../lib/keyboardShortcuts";
import { getLogger } from "../../../lib/logger";
import type { BasePanelComponentProps } from "../../../lib/panel-registry";
import { usePanelTabStatus } from "../../../lib/panel-tab-status";
import { resolveSpatialSelection } from "../../../lib/wasm-bridge";
import {
  fixtures as fixturesStore,
  groups as groupsStore,
} from "../../../state/appStores";
import { reducedMotion } from "../../../state/reduced-motion";
import type * as types from "../../../types";
import { FxDirection, type SpatialSelection } from "../../../types";
import { usePropertiesInspector } from "../../property-inspector";
import { SpatialSelectionField } from "../../selection";
import { FxAttributePicker } from "../components/fx-attribute-picker";
import { StepFxPhaseField } from "../components/step-fx-phase-field";
import {
  StepFxWaveform,
  type StepFxWaveformDragTarget,
  type StepFxWaveformSelectionModifiers,
} from "../components/step-fx-waveform";
import { createStepFxEditorController } from "../controllers/step-fx-editor-controller";
import { getTargetFixtureAttributes } from "../model/fixture-attributes";
import {
  createDefaultStepFxLane,
  createDefaultStepFxTrack,
  deleteStepFxSteps,
  distributeStepFxWidthsEvenly,
  duplicateStepFxSteps,
  editStepFxSteps,
  formatStepFxBeatCount,
  formatStepFxTarget,
  formatStepFxWidthBeats,
  insertStepFxStep,
  parseStepFxTarget,
  reorderStepFxSteps,
  roundStepFxWidthBeats,
  type StepFxPositionUnit,
  type StepFxSpeedUnit,
  type StepFxTrackKind,
  setStepFxTargetValue,
  stepFxAttributeName,
  stepFxAuthoredPassBeats,
  stepFxCycleBeats,
  stepFxPasteInsertionIndex,
  stepFxPhaseOffset,
  stepFxPositionUnitScale,
  stepFxPositionUnitSuffix,
  stepFxSpeedValue,
  stepFxStepsFromClipboard,
  stepFxTimingFromSpeed,
  stepFxTrack,
} from "../model/step-fx-editor-model";
import {
  loadStepFxEditorViewportState,
  saveStepFxEditorViewportState,
} from "../model/step-fx-editor-viewport";

const log = getLogger(import.meta.url);
const FIELD_CLASS = "nf-form-control min-w-0";
const BUTTON_CLASS =
  "nf-button text-xs disabled:cursor-not-allowed disabled:opacity-40";
const TAB_BUTTON_CLASS =
  "rounded px-2 py-1 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-0";
const CONTRIBUTION_SLIDE_DURATION_MS = 140;

/** Canonicalizes backend and browser UUID spellings for row selection matching. */
const stepSelectionIdentity = (uid: string): string =>
  uid.replace(/-/g, "").toLowerCase();

export interface StepFxEditorPanelProps extends BasePanelComponentProps {
  initialPanelId: string;
  initialStepFxUid?: string;
  initialDraft?: types.StepFx;
  panelApi?: DockviewPanelApi;
}

interface PhaseMarker {
  index: number;
  memberCount: number;
  members: string;
}

interface StepFxSelectionProjectionInput {
  selection: SpatialSelection | undefined;
  fixtures: Record<string, types.Fixture>;
  groups: Record<string, types.Group>;
  token: string;
}

type StepFxEditorPopover = "timing" | "start-position" | "overrides";

/** Presents Step FX authoring controls and integrates the editor session with docking. */
export default function StepFxEditorPanel(props: StepFxEditorPanelProps) {
  log.trace("mounting");
  const $fixtures = useStore(fixturesStore);
  const $groups = useStore(groupsStore);
  const initialDraft = props.initialDraft;
  const initialUid = (
    props.initialStepFxUid ??
    initialDraft?.identifiers.uid ??
    ""
  )
    .replace(/-/g, "")
    .toLowerCase();
  const initialViewport = loadStepFxEditorViewportState(initialUid);
  const {
    draft,
    saving,
    conflict,
    deletedExternally,
    previewActive,
    previewSessionId,
    previewStatus,
    isDirty,
    issues,
    mutate,
    canTogglePreview,
    togglePreview,
    reloadStored,
    overwriteConflict,
  } = createStepFxEditorController({
    initialUid,
    initialDraft,
    initialPreviewActive: initialViewport.previewActive,
    onCleanDeletion: props.panelApi ? () => props.panelApi?.close() : undefined,
  });
  const [selectedLane, setSelectedLane] = createSignal(0);
  const [trackKind, setTrackKind] = createSignal<StepFxTrackKind>(
    initialViewport.trackKind,
  );
  const [selectedStepUids, setSelectedStepUidsSignal] = createSignal<
    Set<string>
  >(new Set());
  const [selectionMode, setSelectionMode] = createSignal(false);
  const [liveStepUid, setLiveStepUid] = createSignal<string>();
  const [waveformDragTarget, setWaveformDragTarget] =
    createSignal<StepFxWaveformDragTarget>();
  const [speedUnit, setSpeedUnit] = createSignal<StepFxSpeedUnit>("BPM");
  const [positionUnit, setPositionUnit] =
    createSignal<StepFxPositionUnit>("percent");
  const [openPopover, setOpenPopover] = createSignal<StepFxEditorPopover>();
  const [attributeSearchFocusRequest, setAttributeSearchFocusRequest] =
    createSignal(0);
  const [attributePickerDismissRequest, setAttributePickerDismissRequest] =
    createSignal(0);
  const [advancedPhaseFocusRequest, setAdvancedPhaseFocusRequest] =
    createSignal(0);
  const [phaseMarkers, setPhaseMarkers] = createSignal<PhaseMarker[]>([]);
  const [phaseIssues, setPhaseIssues] = createSignal<string[]>([]);
  const [targetFixtureRefs, setTargetFixtureRefs] = createSignal<
    types.FixtureRef[]
  >([]);
  const [previewIndex, setPreviewIndex] = createSignal(0);
  const [showAllPlayheads, setShowAllPlayheads] = createSignal(
    initialViewport.showAllPlayheads,
  );
  const [spreadEditing, setSpreadEditing] = createSignal(false);
  const [centerSelectedFixture, _setCenterSelectedFixture] = createSignal(
    initialViewport.centerSelectedFixture,
  );
  const [viewportHydrated, setViewportHydrated] = createSignal(false);
  const [isCloseConfirmOpen, setIsCloseConfirmOpen] = createSignal(false);
  const [pendingContributionTrack, setPendingContributionTrack] =
    createSignal<StepFxTrackKind>();
  const [contributionSlidePhase, setContributionSlidePhase] = createSignal<
    "idle" | "outgoing" | "incoming"
  >("idle");
  const [contributionSlideDirection, setContributionSlideDirection] =
    createSignal<"left" | "right">();
  const panelId = props.initialPanelId ?? props.id;
  let previewIndexRestored = initialViewport.previewIndex === 0;
  let bypassCloseGuard = false;
  let contributionPanelElement: HTMLDivElement | undefined;
  let editorRootElement: HTMLDivElement | undefined;
  let contributionSlideAnimation: Animation | undefined;
  let contributionSlideToken = 0;
  const trackSelections = new Map<string, Set<string>>();

  usePanelTabStatus(panelId, () => (saving() ? "saving" : undefined));

  /** Returns the stable editor-local selection key for one lane contribution track. */
  const trackSelectionKey = (
    lane = selectedLane(),
    kind = trackKind(),
  ): string => `${lane}:${kind}`;

  /** Updates the active selection and remembers it independently for this track. */
  const setSelectedStepUids = (
    update: Set<string> | ((current: Set<string>) => Set<string>),
  ): void => {
    const next =
      typeof update === "function" ? update(selectedStepUids()) : update;
    const stored = new Set(next);
    trackSelections.set(trackSelectionKey(), stored);
    setSelectedStepUidsSignal(stored);
  };

  /** Toggles the explicit row-selection controls without discarding the active edit selection. */
  const toggleSelectionMode = (): void => {
    setSelectionMode((enabled) => !enabled);
  };

  /** Switches tracks while restoring that track's most recent row selection. */
  const selectTrack = (lane: number, kind: StepFxTrackKind): void => {
    batch(() => {
      setSelectedLane(lane);
      setTrackKind(kind);
      setSelectedStepUidsSignal(
        new Set(trackSelections.get(trackSelectionKey(lane, kind)) ?? []),
      );
    });
  };

  /** Slides the active contribution out and its horizontal neighbor into view. */
  const selectContributionTrack = (kind: StepFxTrackKind): void => {
    if (
      kind === trackKind() ||
      pendingContributionTrack() !== undefined ||
      !contributionPanelElement
    )
      return;
    if (reducedMotion.get()) {
      selectTrack(selectedLane(), kind);
      return;
    }

    const direction = kind === "relative" ? "right" : "left";
    const outgoingX = direction === "right" ? "-100%" : "100%";
    const incomingX = direction === "right" ? "100%" : "-100%";
    const token = ++contributionSlideToken;
    setPendingContributionTrack(kind);
    setContributionSlideDirection(direction);
    setContributionSlidePhase("outgoing");
    const outgoing = contributionPanelElement.animate(
      [
        { transform: "translateX(0)" },
        { transform: `translateX(${outgoingX})` },
      ],
      {
        duration: CONTRIBUTION_SLIDE_DURATION_MS,
        easing: "cubic-bezier(0.4, 0, 1, 1)",
        fill: "forwards",
      },
    );
    contributionSlideAnimation = outgoing;

    void outgoing.finished
      .then(() => {
        if (token !== contributionSlideToken || !contributionPanelElement)
          return undefined;
        outgoing.cancel();
        selectTrack(selectedLane(), kind);
        setContributionSlidePhase("incoming");
        const incoming = contributionPanelElement.animate(
          [
            { transform: `translateX(${incomingX})` },
            { transform: "translateX(0)" },
          ],
          {
            duration: CONTRIBUTION_SLIDE_DURATION_MS,
            easing: "cubic-bezier(0, 0, 0.2, 1)",
          },
        );
        contributionSlideAnimation = incoming;
        return incoming.finished;
      })
      .then(() => {
        if (token !== contributionSlideToken) return;
        contributionSlideAnimation = undefined;
        setPendingContributionTrack(undefined);
        setContributionSlidePhase("idle");
      })
      .catch(() => undefined);
  };

  /** Returns the operator-facing label used by the panel and Properties heading. */
  const propertiesLabel = createMemo(
    () => draft()?.identifiers.label ?? "Step FX",
  );

  /** Returns the editor tab title for the current draft identity. */
  const panelTitle = createMemo(() => {
    const current = draft();
    return current
      ? `Step FX ${current.identifiers.id}: ${current.identifiers.label}`
      : "Step FX Editor";
  });

  /** Indexes errors by field path so controls can expose localized feedback. */
  const issuesByPath = createMemo(() => {
    const byPath = new Map<string, string[]>();
    for (const issue of issues()) {
      const current = byPath.get(issue.path) ?? [];
      current.push(issue.message);
      byPath.set(issue.path, current);
    }
    return byPath;
  });

  /** Returns the currently selected lane after clamping structural edits. */
  const activeLane = createMemo(() => {
    const lanes = draft()?.lanes ?? [];
    return lanes[Math.min(selectedLane(), Math.max(lanes.length - 1, 0))];
  });

  /** Returns the absolute or relative track selected in the sheet. */
  const activeTrack = createMemo(() => {
    const lane = activeLane();
    return lane ? stepFxTrack(lane, trackKind()) : undefined;
  });

  /** Formats the active track's effective cycle after optional fixed scaling. */
  const activeCycleBeatText = createMemo(() => {
    const current = draft();
    const beats = current ? stepFxCycleBeats(current, activeTrack()) : null;
    return beats === null ? null : formatStepFxBeatCount(beats);
  });

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
        token: selectionProjectionToken(selection, fixtures, groups),
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

  /** Restores the selected attribute after the effect draft becomes available. */
  createEffect(() => {
    const current = draft();
    if (!current || viewportHydrated()) return;
    const laneIndex = initialViewport.selectedAttribute
      ? current.lanes.findIndex(
          (lane) =>
            stepFxAttributeName(lane.attribute) ===
            initialViewport.selectedAttribute,
        )
      : 0;
    selectTrack(Math.max(0, laneIndex), initialViewport.trackKind);
    setViewportHydrated(true);
  });

  /** Persists editor-only controls independently for the active Step FX. */
  createEffect(() => {
    if (!viewportHydrated()) return;
    const lane = activeLane();
    saveStepFxEditorViewportState(initialUid, {
      selectedAttribute: lane ? stepFxAttributeName(lane.attribute) : undefined,
      trackKind: trackKind(),
      centerSelectedFixture: centerSelectedFixture(),
      showAllPlayheads: showAllPlayheads(),
      previewIndex: previewIndexRestored
        ? previewIndex()
        : initialViewport.previewIndex,
      previewActive: previewActive(),
    });
  });

  /** Keeps the waveform preview index valid as the resolved selection changes. */
  createEffect(() => {
    const count = phaseMarkers().length;
    const clamped = Math.max(0, Math.min(count - 1, previewIndex()));
    if (clamped !== previewIndex()) setPreviewIndex(clamped);
  });

  /** Keeps step selection valid when lanes, tracks, or rows change. */
  createEffect(() => {
    const track = activeTrack();
    const selectedIdentities = new Set(
      Array.from(selectedStepUids(), stepSelectionIdentity),
    );
    const retained = new Set(
      track?.steps
        .filter((step) =>
          selectedIdentities.has(stepSelectionIdentity(step.uid)),
        )
        .map((step) => step.uid) ?? [],
    );
    if (!setsEqual(retained, selectedStepUids())) setSelectedStepUids(retained);
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

  onMount(() => {
    if (editorRootElement) {
      const unregisterFocus = registerComponentFocus(
        panelId,
        editorRootElement,
      );
      onCleanup(unregisterFocus);
    }
    const panelApi = props.panelApi;
    if (!panelApi) return;
    const originalClose = panelApi.close.bind(panelApi);
    panelApi.close = () => {
      if (bypassCloseGuard || !isDirty()) originalClose();
      else setIsCloseConfirmOpen(true);
    };
    onCleanup(() => {
      panelApi.close = originalClose;
    });
  });

  onCleanup(() => {
    log.trace("unmounting");
    contributionSlideToken += 1;
    contributionSlideAnimation?.cancel();
    contributionSlideAnimation = undefined;
  });

  /** Renames the active Step FX through the shared draft mutation pipeline. */
  const renameStepFx = (stepFx: types.StepFx, label: string): void => {
    if (label === stepFx.identifiers.label) return;
    mutate((next) => {
      next.identifiers.label = label;
    });
  };

  /** Keeps the retained panel title aligned with its Step FX draft label. */
  createEffect(() => {
    props.panelApi?.setTitle(panelTitle());
  });

  usePropertiesInspector(
    panelId,
    propertiesLabel,
    () => (
      <StepFxProperties
        stepFx={draft()}
        onLabelCommit={renameStepFx}
        onSelectionChange={(selection) =>
          mutate((next) => (next.selection = selection))
        }
      />
    ),
    { priority: 10 },
  );

  /** Replaces the active track while preserving every other lane field. */
  const replaceTrack = (track: types.FxTrack): void => {
    mutate((next) => {
      const lane = next.lanes[selectedLane()];
      if (!lane) return;
      if (trackKind() === "absolute") lane.absolute = track;
      else lane.relative = track;
    });
  };

  /** Returns the row selection affected by a cell edit. */
  const editSelectionFor = (uid: string): Set<string> => {
    return selectedStepUids().has(uid) ? selectedStepUids() : new Set([uid]);
  };

  /** Closes after the operator explicitly confirms discarding the local draft. */
  const confirmClose = (): void => {
    setIsCloseConfirmOpen(false);
    if (!props.panelApi) return;
    bypassCloseGuard = true;
    try {
      props.panelApi.close();
    } finally {
      bypassCloseGuard = false;
    }
  };

  /** Adds and selects a lane for a newly chosen fixture attribute. */
  const addLane = (name: string): void => {
    mutate((next) => {
      const attribute = getAttributeMetadata(name)?.attribute ?? {
        type: "Custom" as const,
        data: { label: name },
      };
      next.lanes.push(createDefaultStepFxLane(attribute));
      selectTrack(next.lanes.length - 1, "absolute");
    });
  };

  /** Removes one lane and keeps the nearest surviving lane selected. */
  const removeLane = (index: number): void => {
    mutate((next) => next.lanes.splice(index, 1));
    trackSelections.clear();
    selectTrack(
      Math.max(0, Math.min(selectedLane(), (draft()?.lanes.length ?? 1) - 2)),
      trackKind(),
    );
  };

  /** Adds the currently selected absolute or relative contribution track. */
  const addTrack = (): void => {
    replaceTrack(createDefaultStepFxTrack(trackKind()));
  };

  /** Removes one contribution track while retaining its attribute lane. */
  const removeTrack = (kind = trackKind()): void => {
    mutate((next) => {
      const lane = next.lanes[selectedLane()];
      if (!lane) return;
      if (kind === "absolute") lane.absolute = undefined;
      else lane.relative = undefined;
    });
  };

  /** Inserts one step after the active selection and selects its fresh identity. */
  const insertStep = (): void => {
    const track = activeTrack();
    if (!track) return;
    const selectedIndex = Math.max(
      0,
      track.steps.findIndex((step) => selectedStepUids().has(step.uid)),
    );
    const inserted = insertStepFxStep(track, selectedIndex);
    if (trackKind() === "relative") {
      const step = inserted.track.steps.find(
        (candidate) => candidate.uid === inserted.uid,
      );
      if (step) {
        step.target = setStepFxTargetValue(step.target, 0, "relative");
        step.blueprint_uid = undefined;
      }
    }
    replaceTrack(inserted.track);
    setSelectedStepUids(new Set([inserted.uid]));
  };

  /** Duplicates all selected rows as independent authored steps. */
  const duplicateSteps = (): void => {
    const track = activeTrack();
    if (!track) return;
    const duplicated = duplicateStepFxSteps(track, selectedStepUids());
    replaceTrack(duplicated.track);
    setSelectedStepUids(duplicated.selectedUids);
  };

  /** Shares the selected steps' total duration, or the whole track when selection is singular. */
  const distributeWidthsEvenly = (): void => {
    const track = activeTrack();
    if (!track) return;
    replaceTrack(distributeStepFxWidthsEvenly(track, selectedStepUids()));
  };

  /** Deletes selected rows and chooses the nearest surviving row. */
  const deleteSteps = (): void => {
    const track = activeTrack();
    if (!track) return;
    const deleted = deleteStepFxSteps(track, selectedStepUids());
    replaceTrack(deleted.track);
    setSelectedStepUids(deleted.selectedUids);
  };

  /** Deletes selected rows for a panel shortcut that was not handled locally. */
  const handleDeleteStepsShortcut = (event?: KeyboardEvent): void => {
    if (event?.defaultPrevented) return;
    event?.preventDefault();
    deleteSteps();
  };

  /** Moves the selected authored rows by one position. */
  const moveSteps = (direction: -1 | 1): void => {
    const track = activeTrack();
    if (track)
      replaceTrack(reorderStepFxSteps(track, selectedStepUids(), direction));
  };

  /** Copies selected rows as portable JSON step data. */
  const copySteps = async (): Promise<void> => {
    const selected =
      activeTrack()?.steps.filter((step) => selectedStepUids().has(step.uid)) ??
      [];
    if (selected.length === 0) return;
    await navigator.clipboard.writeText(JSON.stringify(selected, null, 2));
  };

  /** Pastes serialized steps or line-separated numeric targets after the selection. */
  const pasteSteps = async (): Promise<void> => {
    const track = activeTrack();
    if (!track) return;
    const text = await navigator.clipboard.readText();
    const incoming = stepFxStepsFromClipboard(
      text,
      trackKind(),
      track.steps[0],
    );
    if (incoming.length === 0) return;
    const fresh = incoming.map((step) => ({
      ...structuredClone(step),
      uid: crypto.randomUUID(),
      target: setStepFxTargetValue(
        step.target,
        stepFxNumericTarget(step.target),
        trackKind(),
      ),
    }));
    const insertionIndex = stepFxPasteInsertionIndex(track, selectedStepUids());
    const steps = track.steps.map((step) => structuredClone(step));
    steps.splice(insertionIndex, 0, ...fresh);
    replaceTrack({ steps });
    setSelectedStepUids(new Set(fresh.map((step) => step.uid)));
  };

  /** Applies shared single, range, or toggle selection from visual step controls. */
  const selectStep = (
    stepUid: string,
    modifiers: StepFxWaveformSelectionModifiers,
  ): void => {
    const track = activeTrack();
    if (!track) return;
    const targetIndex = track.steps.findIndex((step) => step.uid === stepUid);
    if (targetIndex < 0) return;
    if (modifiers.extend) {
      const anchor = track.steps.findIndex((step) =>
        selectedStepUids().has(step.uid),
      );
      const start = Math.min(anchor < 0 ? targetIndex : anchor, targetIndex);
      const end = Math.max(anchor < 0 ? targetIndex : anchor, targetIndex);
      setSelectedStepUids(
        new Set(track.steps.slice(start, end + 1).map((step) => step.uid)),
      );
      return;
    }
    const next = modifiers.toggle
      ? new Set(selectedStepUids())
      : new Set<string>();
    if (next.has(stepUid)) next.delete(stepUid);
    else next.add(stepUid);
    setSelectedStepUids(next);
  };

  /** Replaces the authored fields controlled by one dragged ramp endpoint. */
  const replaceWaveformControlPoint = (
    stepUid: string,
    point: "ramp-start" | "ramp-end",
    transitionPosition: number,
    value?: number,
  ): void => {
    const track = activeTrack();
    if (!track || !Number.isFinite(transitionPosition)) return;
    replaceTrack({
      steps: track.steps.map((step) => {
        if (step.uid !== stepUid) return structuredClone(step);
        const replacement = structuredClone(step);
        if (point === "ramp-start") {
          replacement.transition.start = Number(transitionPosition.toFixed(4));
        } else {
          replacement.transition.end = Number(transitionPosition.toFixed(4));
          if (value !== undefined && Number.isFinite(value)) {
            replacement.target = setStepFxTargetValue(
              step.target,
              Number(value.toFixed(6)),
              trackKind(),
            );
            replacement.blueprint_uid = undefined;
          }
        }
        return replacement;
      }),
    });
  };

  /** Reallocates two adjacent widths around a dragged internal boundary. */
  const replaceWaveformStepBoundary = (
    leadingStepUid: string,
    trailingStepUid: string,
    leadingWidthBeats: number,
    trailingWidthBeats: number,
  ): void => {
    const track = activeTrack();
    if (!track) return;
    replaceTrack({
      steps: track.steps.map((step) => {
        const width =
          step.uid === leadingStepUid
            ? leadingWidthBeats
            : step.uid === trailingStepUid
              ? trailingWidthBeats
              : undefined;
        return width === undefined
          ? structuredClone(step)
          : {
              ...structuredClone(step),
              width_beats: roundStepFxWidthBeats(width),
            };
      }),
    });
  };

  /** Replaces one step width while allowing the authored cycle duration to change. */
  const replaceWaveformStepWidth = (
    stepUid: string,
    widthBeats: number,
  ): void => {
    const track = activeTrack();
    if (!track || !Number.isFinite(widthBeats)) return;
    replaceTrack({
      steps: track.steps.map((step) =>
        step.uid === stepUid
          ? {
              ...structuredClone(step),
              width_beats: roundStepFxWidthBeats(widthBeats),
            }
          : structuredClone(step),
      ),
    });
  };

  /** Moves the effective phase distribution to a dragged selected-index offset. */
  const replaceWaveformStartPosition = (selectionPhaseOffset: number): void => {
    if (!Number.isFinite(selectionPhaseOffset)) return;
    mutate((next) => {
      const lane = next.lanes[selectedLane()];
      const phase = lane?.phase_override ?? next.phase;
      const currentOffset = stepFxPhaseOffset(
        phase,
        previewIndex(),
        phaseMarkers().length,
      );
      const delta = selectionPhaseOffset - currentOffset;
      const shifted = {
        waypoints:
          phase.waypoints.length > 0
            ? phase.waypoints.map((waypoint) =>
                Number((waypoint + delta).toFixed(6)),
              )
            : [Number(selectionPhaseOffset.toFixed(6))],
      };
      if (lane?.phase_override) lane.phase_override = shifted;
      else next.phase = shifted;
    });
  };

  /** Changes phase spread around its first waypoint while preserving custom relative shape. */
  const replaceWaveformSpread = (spread: number): void => {
    if (!Number.isFinite(spread)) return;
    mutate((next) => {
      const lane = next.lanes[selectedLane()];
      const phase = lane?.phase_override ?? next.phase;
      const start = phase.waypoints[0] ?? 0;
      const currentSpread =
        phase.waypoints.length > 1
          ? phase.waypoints[phase.waypoints.length - 1] - start
          : 0;
      const waypoints =
        phase.waypoints.length <= 1
          ? [start, start + spread]
          : phase.waypoints.map((waypoint, index) => {
              if (index === 0) return start;
              if (Math.abs(currentSpread) <= Number.EPSILON) {
                return start + (spread * index) / (phase.waypoints.length - 1);
              }
              return start + ((waypoint - start) * spread) / currentSpread;
            });
      const replacement = {
        waypoints: waypoints.map((waypoint) => Number(waypoint.toFixed(6))),
      };
      if (lane?.phase_override) lane.phase_override = replacement;
      else next.phase = replacement;
    });
  };

  /** Reports whether one value cell owns the active waveform drag. */
  const isWaveformValueDrag = (stepUid: string): boolean => {
    const target = waveformDragTarget();
    return (
      target?.kind === "control-point" &&
      target.point === "ramp-end" &&
      target.stepUid === stepUid
    );
  };

  /** Reports whether one ramp range owns the active waveform drag. */
  const isWaveformRampDrag = (stepUid: string): boolean => {
    const target = waveformDragTarget();
    return target?.kind === "control-point" && target.stepUid === stepUid;
  };

  /** Returns which endpoint of one ramp range owns the active waveform drag. */
  const waveformRampDragPoint = (
    stepUid: string,
  ): "ramp-start" | "ramp-end" | undefined => {
    const target = waveformDragTarget();
    return target?.kind === "control-point" && target.stepUid === stepUid
      ? target.point
      : undefined;
  };

  /** Reports whether one width cell participates in the active boundary drag. */
  const isWaveformWidthDrag = (stepUid: string): boolean => {
    const target = waveformDragTarget();
    return target?.kind === "width" && target.stepUids.includes(stepUid);
  };

  /** Applies Step Bar keyboard navigation and selection commands to the active track. */
  const handleStepBarKeyDown = (event: KeyboardEvent): void => {
    const track = activeTrack();
    if (!track || track.steps.length === 0) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      setSelectedStepUids(new Set(track.steps.map((step) => step.uid)));
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      deleteSteps();
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const selectedIndexes = track.steps
      .map((step, index) => (selectedStepUids().has(step.uid) ? index : -1))
      .filter((index) => index >= 0);
    const anchor = selectedIndexes[selectedIndexes.length - 1] ?? 0;
    const target = Math.max(
      0,
      Math.min(
        track.steps.length - 1,
        anchor + (event.key === "ArrowLeft" ? -1 : 1),
      ),
    );
    if (!event.shiftKey) {
      setSelectedStepUids(new Set([track.steps[target].uid]));
      return;
    }
    const next = new Set(selectedStepUids());
    next.add(track.steps[target].uid);
    setSelectedStepUids(next);
  };

  /** Handles panel-level step clipboard shortcuts without overriding native fields. */
  const handleEditorClipboardKeyDown = (event: KeyboardEvent): void => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      target.matches("input, textarea, select, [contenteditable='true']")
    )
      return;
    const key = event.key.toLowerCase();
    if (key === "c" && selectedStepUids().size > 0) {
      event.preventDefault();
      void copySteps();
    } else if (key === "v" && activeTrack()) {
      event.preventDefault();
      void pasteSteps();
    }
  };

  /** Makes one editor popover visible while dismissing any peer popover. */
  const setEditorPopoverOpen = (
    popover: StepFxEditorPopover,
    isOpen: boolean,
  ): void => {
    setOpenPopover((current) =>
      isOpen ? popover : current === popover ? undefined : current,
    );
  };

  /** Opens attribute search and selects its query for immediate replacement. */
  const focusAttributeSearch = (): void => {
    setOpenPopover(undefined);
    setAttributeSearchFocusRequest((request) => request + 1);
  };

  /** Opens the start-position popover and selects its advanced expression. */
  const focusAdvancedPhaseExpression = (): void => {
    setOpenPopover("start-position");
    setAdvancedPhaseFocusRequest((request) => request + 1);
  };

  /** Dismisses all editor popovers without changing authored values. */
  const dismissEditorPopovers = (): void => {
    setOpenPopover(undefined);
    setAttributePickerDismissRequest((request) => request + 1);
  };

  useKeyboardShortcut({
    key: "b",
    handler: () => setOpenPopover("timing"),
    description: "Open BPM editor",
    componentId: panelId,
    group: "Step FX Editor",
  });
  useKeyboardShortcut({
    key: "s",
    handler: () => setOpenPopover("start-position"),
    description: "Open spread editor",
    componentId: panelId,
    group: "Step FX Editor",
  });
  useKeyboardShortcut({
    key: "a",
    handler: () => {
      if (phaseHasSpread()) setShowAllPlayheads((shown) => !shown);
    },
    description: "Toggle all waveform playheads",
    componentId: panelId,
    group: "Step FX Editor",
  });
  useKeyboardShortcut({
    key: "n",
    handler: focusAttributeSearch,
    description: "Add a new attribute",
    componentId: panelId,
    group: "Step FX Editor",
  });
  useKeyboardShortcut({
    key: "p",
    handler: togglePreview,
    description: "Play or pause preview",
    componentId: panelId,
    group: "Step FX Editor",
  });
  useKeyboardShortcut({
    key: "o",
    handler: () => setOpenPopover("overrides"),
    description: "Open overrides",
    componentId: panelId,
    group: "Step FX Editor",
  });
  useKeyboardShortcut({
    key: "Shift+s",
    handler: focusAdvancedPhaseExpression,
    description: "Edit advanced spread expression",
    componentId: panelId,
    group: "Step FX Editor",
  });
  useKeyboardShortcut({
    key: "Escape",
    handler: dismissEditorPopovers,
    description: "Close editor popovers",
    componentId: panelId,
    group: "Step FX Editor",
  });
  useKeyboardShortcut({
    key: "Delete",
    handler: handleDeleteStepsShortcut,
    description: "Delete selected steps",
    componentId: panelId,
    group: "Step FX Editor",
  });
  useKeyboardShortcut({
    key: "Backspace",
    handler: handleDeleteStepsShortcut,
    description: "Delete selected steps",
    componentId: panelId,
    group: "Step FX Editor",
  });

  /** Renders step mutations first and track-level controls against the far edge. */
  const renderStepActionToolbar = (
    lane: () => types.FxLane,
    track?: () => types.FxTrack | undefined,
  ) => (
    <div
      class="flex h-12 min-w-0 shrink-0 items-center gap-0.5 border-b border-neutral-700 bg-neutral-900 px-2"
      data-step-fx-step-actions-toolbar
      role="toolbar"
      aria-label="Step edit actions"
    >
      <ToolbarButton
        label="Add step"
        onClick={() => (track?.() ? insertStep() : addTrack())}
      >
        <PlusIcon class="size-4" weight="bold" aria-hidden />
      </ToolbarButton>
      <ToolbarButton
        label="Move selected steps up"
        onClick={() => moveSteps(-1)}
        disabled={selectedStepUids().size === 0}
        classList={{
          "cursor-not-allowed opacity-40": selectedStepUids().size === 0,
        }}
      >
        <ArrowUpIcon class="size-4" aria-hidden />
      </ToolbarButton>
      <ToolbarButton
        label="Move selected steps down"
        onClick={() => moveSteps(1)}
        disabled={selectedStepUids().size === 0}
        classList={{
          "cursor-not-allowed opacity-40": selectedStepUids().size === 0,
        }}
      >
        <ArrowDownIcon class="size-4" aria-hidden />
      </ToolbarButton>
      <ToolbarButton
        label="Duplicate selected steps"
        onClick={duplicateSteps}
        disabled={selectedStepUids().size === 0}
        classList={{
          "cursor-not-allowed opacity-40": selectedStepUids().size === 0,
        }}
      >
        <CopySimpleIcon class="size-4" aria-hidden />
      </ToolbarButton>
      <ToolbarButton
        label="Divide step widths evenly"
        onClick={distributeWidthsEvenly}
        disabled={(track?.()?.steps.length ?? 0) < 2}
        classList={{
          "cursor-not-allowed opacity-40": (track?.()?.steps.length ?? 0) < 2,
        }}
      >
        <DivideIcon class="size-4" aria-hidden />
      </ToolbarButton>
      <ToolbarButton
        label="Delete selected steps"
        onClick={deleteSteps}
        disabled={selectedStepUids().size === 0}
        classList={{
          "bg-red-500/20 text-red-100 hover:bg-red-500/30":
            selectedStepUids().size > 0,
          "cursor-not-allowed opacity-40": selectedStepUids().size === 0,
        }}
      >
        <TrashIcon class="size-4" aria-hidden />
      </ToolbarButton>
      <span
        class="mx-1 h-6 w-px shrink-0 bg-neutral-700"
        data-step-fx-selection-mode-separator
        aria-hidden
      />
      <ToggleToolbarButton
        label="Toggle selection mode"
        pressed={selectionMode()}
        onClick={toggleSelectionMode}
      >
        <SelectionIcon class="size-4" aria-hidden />
      </ToggleToolbarButton>
      <div class="ml-auto flex min-w-0 shrink-0 items-center gap-1">
        <StepFxContributionTabs
          lane={lane()}
          trackKind={pendingContributionTrack() ?? trackKind()}
          previewSessionId={previewSessionId}
          onSelectTrack={selectContributionTrack}
          onRemoveTrack={removeTrack}
        />
        <span
          class="mx-1 h-6 w-px shrink-0 bg-neutral-700"
          data-step-fx-overrides-separator
          aria-hidden
        />
        <StepFxOverridesControl
          lane={lane()}
          overall={draft()!}
          open={openPopover() === "overrides"}
          onOpenChange={(isOpen) => setEditorPopoverOpen("overrides", isOpen)}
          onLaneChange={(updated) =>
            mutate((next) => (next.lanes[selectedLane()] = updated))
          }
        />
      </div>
    </div>
  );

  /** Renders paged step navigation in a persistent overlay at the table pane's foot. */
  const renderStepNavigationToolbar = (track: () => types.FxTrack) => (
    <div
      class="absolute inset-x-0 bottom-0 z-20 flex h-12 min-w-0 items-center gap-1 border-t border-neutral-700 bg-neutral-900/95 px-2 shadow-lg backdrop-blur"
      data-step-fx-step-toolbar
      role="toolbar"
      aria-label="Step bar"
    >
      <StepFxStepPager onKeyDown={handleStepBarKeyDown}>
        <For each={track().steps}>
          {(step, index) => (
            <button
              type="button"
              class={`size-7 shrink-0 rounded border text-xs ${selectedStepUids().has(step.uid) ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]" : "border-neutral-700 bg-neutral-800 text-neutral-300"}`}
              classList={{
                "ring-1 ring-inset ring-amber-300/80":
                  liveStepUid() === step.uid,
                "border-red-500 text-red-200": Array.from(
                  issuesByPath().keys(),
                ).some((path) =>
                  path.startsWith(
                    `lanes.${selectedLane()}.${trackKind()}.steps.${index()}`,
                  ),
                ),
              }}
              onClick={(event) =>
                selectStep(step.uid, {
                  extend: event.shiftKey,
                  toggle: event.metaKey || event.ctrlKey,
                })
              }
              aria-current={liveStepUid() === step.uid ? "step" : undefined}
              data-step-fx-step-selector
              data-step-index={index()}
              data-live={liveStepUid() === step.uid ? "true" : undefined}
            >
              {index() + 1}
            </button>
          )}
        </For>
      </StepFxStepPager>
    </div>
  );

  return (
    <div
      ref={editorRootElement}
      class="flex h-full min-h-0 flex-col bg-neutral-950 text-neutral-100"
      data-step-fx-editor
      onKeyDown={handleEditorClipboardKeyDown}
    >
      <Show
        when={draft()}
        fallback={
          <div class="flex h-full items-center justify-center text-neutral-500">
            Step FX not found
          </div>
        }
      >
        {(current) => (
          <>
            <PanelToolbar
              class="shrink-0"
              leftClass="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto"
              left={
                <>
                  <StepFxDirectionControl
                    direction={current().direction}
                    onChange={(direction) =>
                      mutate((next) => (next.direction = direction))
                    }
                  />
                  <StepFxTimingControls
                    stepFx={current()}
                    open={openPopover() === "timing"}
                    onOpenChange={(isOpen) =>
                      setEditorPopoverOpen("timing", isOpen)
                    }
                    speedUnit={speedUnit()}
                    cycleBeatText={activeCycleBeatText()}
                    fixedScaleDefault={
                      stepFxAuthoredPassBeats(activeTrack()) ?? 1
                    }
                    trackKind={trackKind()}
                    speedError={issuesByPath().get("timing.beat_duration")?.[0]}
                    scaleError={issuesByPath().get("cycle_scale.data")?.[0]}
                    onSpeedUnitChange={setSpeedUnit}
                    onTimingChange={(timing) =>
                      mutate((next) => (next.timing = timing))
                    }
                    onCycleScaleChange={(cycleScale) =>
                      mutate((next) => (next.cycle_scale = cycleScale))
                    }
                  />
                  <span
                    class="h-6 w-px shrink-0 bg-neutral-700"
                    data-step-fx-start-position-separator
                    aria-hidden
                  />
                  <StepFxStartPositionControls
                    phase={current().phase}
                    open={openPopover() === "start-position"}
                    highlighted={
                      waveformDragTarget()?.kind === "start-position" ||
                      waveformDragTarget()?.kind === "spread"
                    }
                    advancedFocusRequest={advancedPhaseFocusRequest()}
                    onOpenChange={(isOpen) =>
                      setEditorPopoverOpen("start-position", isOpen)
                    }
                    selectionCount={phaseMarkers().length}
                    positionUnit={positionUnit()}
                    onPositionUnitChange={setPositionUnit}
                    onSpreadEditingChange={setSpreadEditing}
                    onChange={(phase) => mutate((next) => (next.phase = phase))}
                  />
                </>
              }
              right={
                <ToggleToolbarButton
                  label={previewActive() ? "Stop preview" : "Preview"}
                  pressed={previewActive()}
                  disabled={!canTogglePreview()}
                  classList={{
                    "cursor-not-allowed opacity-40": !canTogglePreview(),
                  }}
                  onClick={togglePreview}
                >
                  <Dynamic
                    component={previewActive() ? StopIcon : PlayIcon}
                    class="size-4"
                    aria-hidden
                  />
                </ToggleToolbarButton>
              }
            />
            <Show when={deletedExternally()}>
              <div
                class="flex shrink-0 items-center gap-2 border-b border-amber-600/60 bg-amber-950/40 px-3 py-2 text-xs text-amber-100"
                role="alert"
              >
                This Step FX was deleted elsewhere. This local draft can no
                longer be saved.
                <button
                  type="button"
                  class={BUTTON_CLASS}
                  onClick={() => props.panelApi?.close()}
                >
                  Close editor
                </button>
              </div>
            </Show>
            <Show when={conflict() && !deletedExternally()}>
              <div class="flex shrink-0 items-center gap-2 border-b border-amber-600/60 bg-amber-950/40 px-3 py-2 text-xs text-amber-100">
                This Step FX changed elsewhere while this draft has unsaved
                edits.
                <button
                  type="button"
                  class={BUTTON_CLASS}
                  onClick={reloadStored}
                >
                  Reload stored
                </button>
                <button
                  type="button"
                  class={BUTTON_CLASS}
                  onClick={overwriteConflict}
                >
                  Keep draft
                </button>
              </div>
            </Show>
            <main class="grid min-h-0 flex-1 grid-cols-[11rem_minmax(0,1fr)] overflow-hidden">
              <aside class="min-h-0 overflow-y-auto border-r border-neutral-700 bg-neutral-900/60 p-2">
                <FxAttributePicker
                  selectedAttributes={current().lanes.map((lane) =>
                    stepFxAttributeName(lane.attribute),
                  )}
                  showSelectedAttributes={false}
                  showLabel={false}
                  availableAttributes={availableAttributes()}
                  focusSearchRequest={attributeSearchFocusRequest()}
                  dismissRequest={attributePickerDismissRequest()}
                  onChange={(attributes) => {
                    const requested = new Set(attributes);
                    const removedIndex = current().lanes.findIndex(
                      (lane) =>
                        !requested.has(stepFxAttributeName(lane.attribute)),
                    );
                    if (removedIndex >= 0) {
                      removeLane(removedIndex);
                      return;
                    }
                    const existing = new Set(
                      current().lanes.map((lane) =>
                        stepFxAttributeName(lane.attribute),
                      ),
                    );
                    for (const attribute of attributes)
                      if (!existing.has(attribute)) addLane(attribute);
                  }}
                />
                <div
                  class="mt-3 flex flex-col gap-1"
                  role="tablist"
                  aria-label="Step FX attributes"
                  aria-orientation="vertical"
                >
                  <For each={current().lanes}>
                    {(lane, index) => (
                      <div
                        role="presentation"
                        class="group flex items-center rounded p-0.5 transition-colors"
                        classList={{
                          "bg-blue-600 text-white": selectedLane() === index(),
                          "bg-gray-800 text-gray-400":
                            selectedLane() !== index(),
                        }}
                      >
                        <button
                          type="button"
                          id={`step-fx-${previewSessionId}-attribute-tab-${index()}`}
                          role="tab"
                          aria-selected={selectedLane() === index()}
                          aria-controls={`step-fx-${previewSessionId}-track-panel`}
                          class="min-w-0 flex-1 rounded px-2 py-1.5 text-left text-gray-200 transition-colors hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                          onClick={() => {
                            selectTrack(
                              index(),
                              stepFxTrack(lane, trackKind())
                                ? trackKind()
                                : lane.absolute
                                  ? "absolute"
                                  : "relative",
                            );
                          }}
                        >
                          <div class="truncate text-sm">
                            {stepFxAttributeName(lane.attribute)}
                          </div>
                          <div class="text-[11px] text-neutral-500">
                            {lane.absolute
                              ? `A ${lane.absolute.steps.length}`
                              : ""}
                            {lane.absolute && lane.relative ? " · " : ""}
                            {lane.relative
                              ? `R ${lane.relative.steps.length}`
                              : ""}
                          </div>
                        </button>
                        <button
                          type="button"
                          aria-label={`Remove ${stepFxAttributeName(lane.attribute)} lane`}
                          class="self-stretch rounded px-2 text-gray-300 hover:bg-black/15 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                          onClick={() => removeLane(index())}
                        >
                          ×
                        </button>
                      </div>
                    )}
                  </For>
                </div>
              </aside>

              <section
                id={`step-fx-${previewSessionId}-track-panel`}
                role="tabpanel"
                aria-labelledby={
                  current().lanes.length > 0
                    ? `step-fx-${previewSessionId}-attribute-tab-${selectedLane()}`
                    : undefined
                }
                aria-busy={contributionSlidePhase() !== "idle"}
                class="relative flex min-h-0 min-w-0 flex-col overflow-hidden"
                data-step-fx-contribution-stage
                data-contribution-slide-phase={contributionSlidePhase()}
                data-contribution-slide-direction={contributionSlideDirection()}
              >
                <Show
                  when={activeLane()}
                  fallback={
                    <div class="m-auto text-sm text-neutral-500">
                      Add an attribute lane to begin.
                    </div>
                  }
                >
                  {(lane) => (
                    <>
                      {renderStepActionToolbar(lane, activeTrack)}
                      <div
                        ref={contributionPanelElement}
                        class="flex min-h-0 min-w-0 flex-1 flex-col"
                        data-step-fx-contribution-panel
                        data-track-kind={trackKind()}
                      >
                        <Show
                          when={activeTrack()}
                          fallback={
                            <div
                              id={`step-fx-${previewSessionId}-steps-panel`}
                              role="tabpanel"
                              aria-labelledby={`step-fx-${previewSessionId}-${trackKind()}-tab`}
                              class="flex min-h-0 flex-1 flex-col"
                            >
                              <div class="relative min-h-0 flex-1">
                                <div class="absolute inset-0 flex flex-col items-center justify-center gap-3 text-sm text-neutral-500">
                                  <span>No {trackKind()} steps.</span>
                                  <button
                                    type="button"
                                    class={BUTTON_CLASS}
                                    onClick={addTrack}
                                  >
                                    Add {trackKind()} step
                                  </button>
                                </div>
                              </div>
                            </div>
                          }
                        >
                          {(track) => (
                            <div
                              id={`step-fx-${previewSessionId}-steps-panel`}
                              role="tabpanel"
                              aria-labelledby={`step-fx-${previewSessionId}-${trackKind()}-tab`}
                              class="flex min-h-0 flex-1 flex-col"
                            >
                              <VerticalLayoutSplitter
                                class="min-h-0 flex-1"
                                topSize={62}
                                topMinSize={48}
                                separatorLabel="Resize Step FX table and waveform"
                                top={
                                  <div class="relative size-full min-h-0">
                                    <div
                                      class="size-full overflow-auto pb-12"
                                      data-step-fx-sheet-container
                                    >
                                      <Table
                                        class="w-full table-fixed border-collapse text-sm"
                                        data-step-fx-sheet
                                      >
                                        <colgroup>
                                          <Show when={selectionMode()}>
                                            <col class="w-8" />
                                          </Show>
                                          <col class="w-10" />
                                          <col class="w-28" />
                                          <col class="w-20" />
                                          <col />
                                          <col class="w-28" />
                                        </colgroup>
                                        <thead class="sticky top-0 z-10 bg-neutral-900 text-left text-xs text-neutral-400">
                                          <tr>
                                            <Show when={selectionMode()}>
                                              <th class="p-2"></th>
                                            </Show>
                                            <th class="p-2">Step</th>
                                            <th class="p-2">Value</th>
                                            <th class="p-2">Beats</th>
                                            <th class="p-2">Ramp duration</th>
                                            <th class="p-2">Curve</th>
                                          </tr>
                                        </thead>
                                        <tbody>
                                          <For each={track().steps}>
                                            {(step, index) => {
                                              /** Returns the validation prefix for this authored row. */
                                              const path = () =>
                                                `lanes.${selectedLane()}.${trackKind()}.steps.${index()}`;
                                              /** Reports whether any localized error belongs to this row. */
                                              const rowInvalid = () =>
                                                Array.from(
                                                  issuesByPath().keys(),
                                                ).some((issuePath) =>
                                                  issuePath.startsWith(path()),
                                                );
                                              return (
                                                <tr
                                                  class="border-t border-neutral-800 transition-shadow duration-200 ease-out motion-reduce:transition-none"
                                                  classList={{
                                                    "bg-[var(--accent-soft)]":
                                                      selectedStepUids().has(
                                                        step.uid,
                                                      ),
                                                    "ring-1 ring-inset ring-amber-300/70":
                                                      liveStepUid() ===
                                                      step.uid,
                                                    "bg-red-950/20":
                                                      rowInvalid(),
                                                  }}
                                                  aria-current={
                                                    liveStepUid() === step.uid
                                                      ? "step"
                                                      : undefined
                                                  }
                                                  data-step-fx-step-row
                                                  data-step-index={index()}
                                                  data-live={
                                                    liveStepUid() === step.uid
                                                      ? "true"
                                                      : undefined
                                                  }
                                                >
                                                  <Show when={selectionMode()}>
                                                    <td class="p-2 text-center">
                                                      <Checkbox
                                                        aria-label={`Select step ${index() + 1}`}
                                                        checked={selectedStepUids().has(
                                                          step.uid,
                                                        )}
                                                        onChange={(event) =>
                                                          setSelectedStepUids(
                                                            (
                                                              currentSelection,
                                                            ) => {
                                                              const next =
                                                                new Set(
                                                                  currentSelection,
                                                                );
                                                              if (
                                                                event
                                                                  .currentTarget
                                                                  .checked
                                                              )
                                                                next.add(
                                                                  step.uid,
                                                                );
                                                              else
                                                                next.delete(
                                                                  step.uid,
                                                                );
                                                              return next;
                                                            },
                                                          )
                                                        }
                                                      />
                                                    </td>
                                                  </Show>
                                                  <td class="p-2 font-mono text-neutral-400">
                                                    {index() + 1}
                                                  </td>
                                                  <td class="p-2">
                                                    <div
                                                      class="flex w-full items-stretch overflow-hidden rounded border border-neutral-700 bg-neutral-900 focus-within:border-[var(--accent)]"
                                                      data-step-fx-value-field
                                                      data-waveform-drag-active={
                                                        isWaveformValueDrag(
                                                          step.uid,
                                                        )
                                                          ? "true"
                                                          : undefined
                                                      }
                                                      classList={{
                                                        "border-red-500":
                                                          issuesByPath().has(
                                                            `${path()}.target`,
                                                          ),
                                                        "border-amber-300 bg-amber-400/15 ring-1 ring-inset ring-amber-300/70":
                                                          isWaveformValueDrag(
                                                            step.uid,
                                                          ),
                                                      }}
                                                    >
                                                      <Input
                                                        density="compact"
                                                        aria-label={`Step ${index() + 1} value`}
                                                        type="number"
                                                        step="0.1"
                                                        class="min-w-0 w-full appearance-none border-0 bg-transparent px-2 py-1.5 text-right text-sm text-neutral-100 focus:outline-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                                                        value={formatStepFxTarget(
                                                          step.target,
                                                        )}
                                                        onChange={(event) => {
                                                          const parsed =
                                                            parseStepFxTarget(
                                                              event
                                                                .currentTarget
                                                                .value,
                                                              trackKind(),
                                                            );
                                                          if (!parsed) return;
                                                          const selection =
                                                            editSelectionFor(
                                                              step.uid,
                                                            );
                                                          replaceTrack(
                                                            editStepFxSteps(
                                                              track(),
                                                              selection,
                                                              (candidate) => ({
                                                                ...candidate,
                                                                blueprint_uid:
                                                                  undefined,
                                                                target:
                                                                  setStepFxTargetValue(
                                                                    parsed,
                                                                    stepFxNumericTarget(
                                                                      parsed,
                                                                    ),
                                                                    trackKind(),
                                                                  ),
                                                              }),
                                                            ),
                                                          );
                                                        }}
                                                      />
                                                      <span class="inline-flex items-center border-l border-neutral-700 px-2 text-xs text-neutral-500">
                                                        %
                                                      </span>
                                                    </div>
                                                  </td>
                                                  <td class="p-2">
                                                    <Input
                                                      density="compact"
                                                      aria-label={`Step ${index() + 1} width`}
                                                      type="number"
                                                      step="0.001"
                                                      class={`${FIELD_CLASS} w-full`}
                                                      data-waveform-drag-active={
                                                        isWaveformWidthDrag(
                                                          step.uid,
                                                        )
                                                          ? "true"
                                                          : undefined
                                                      }
                                                      classList={{
                                                        "border-red-500":
                                                          issuesByPath().has(
                                                            `${path()}.width_beats`,
                                                          ),
                                                        "border-amber-300 bg-amber-400/15 ring-1 ring-inset ring-amber-300/70":
                                                          isWaveformWidthDrag(
                                                            step.uid,
                                                          ),
                                                      }}
                                                      value={formatStepFxWidthBeats(
                                                        step.width_beats,
                                                      )}
                                                      onChange={(event) => {
                                                        const value = Number(
                                                          event.currentTarget
                                                            .value,
                                                        );
                                                        replaceTrack(
                                                          editStepFxSteps(
                                                            track(),
                                                            editSelectionFor(
                                                              step.uid,
                                                            ),
                                                            (candidate) => ({
                                                              ...candidate,
                                                              width_beats:
                                                                roundStepFxWidthBeats(
                                                                  value,
                                                                ),
                                                            }),
                                                          ),
                                                        );
                                                      }}
                                                    />
                                                  </td>
                                                  <td class="p-2">
                                                    <div
                                                      class="flex min-w-0 items-center gap-2 rounded"
                                                      data-step-fx-ramp-field
                                                      data-waveform-drag-active={
                                                        isWaveformRampDrag(
                                                          step.uid,
                                                        )
                                                          ? "true"
                                                          : undefined
                                                      }
                                                      data-waveform-ramp-drag-point={waveformRampDragPoint(
                                                        step.uid,
                                                      )}
                                                      classList={{
                                                        "bg-amber-400/15 ring-1 ring-inset ring-amber-300/70":
                                                          isWaveformRampDrag(
                                                            step.uid,
                                                          ),
                                                      }}
                                                    >
                                                      <RangeSlider
                                                        mode="range"
                                                        value={[
                                                          step.transition
                                                            .start * 100,
                                                          step.transition.end *
                                                            100,
                                                        ]}
                                                        min={0}
                                                        max={100}
                                                        step={1}
                                                        showPips={false}
                                                        showInputs={false}
                                                        containerClass="ml-0 min-w-8 flex-1"
                                                        handleLabels={[
                                                          `Step ${index() + 1} ramp start`,
                                                          `Step ${index() + 1} ramp end`,
                                                        ]}
                                                        onChange={([
                                                          start,
                                                          end,
                                                        ]: [number, number]) =>
                                                          replaceTrack(
                                                            editStepFxSteps(
                                                              track(),
                                                              editSelectionFor(
                                                                step.uid,
                                                              ),
                                                              (candidate) => ({
                                                                ...candidate,
                                                                transition: {
                                                                  start:
                                                                    start / 100,
                                                                  end:
                                                                    end / 100,
                                                                },
                                                              }),
                                                            ),
                                                          )
                                                        }
                                                      />
                                                      <span class="w-10 shrink-0 whitespace-nowrap text-right text-[11px] tabular-nums">
                                                        {Math.round(
                                                          step.transition
                                                            .start * 100,
                                                        )}
                                                        –
                                                        {Math.round(
                                                          step.transition.end *
                                                            100,
                                                        )}
                                                        %
                                                      </span>
                                                    </div>
                                                  </td>
                                                  <td class="p-2">
                                                    <StepFxCurveSelect
                                                      stepNumber={index() + 1}
                                                      curve={step.curve}
                                                      onChange={(curve) =>
                                                        replaceTrack(
                                                          editStepFxSteps(
                                                            track(),
                                                            editSelectionFor(
                                                              step.uid,
                                                            ),
                                                            (candidate) => ({
                                                              ...candidate,
                                                              curve,
                                                            }),
                                                          ),
                                                        )
                                                      }
                                                    />
                                                  </td>
                                                </tr>
                                              );
                                            }}
                                          </For>
                                        </tbody>
                                      </Table>
                                    </div>
                                    {renderStepNavigationToolbar(track)}
                                  </div>
                                }
                                bottom={
                                  <StepFxWaveform
                                    track={track()}
                                    direction={current().direction}
                                    previewActive={previewActive()}
                                    previewStatus={previewStatus()}
                                    beatDurationSeconds={durationToSeconds(
                                      (
                                        lane().timing_override ??
                                        current().timing
                                      ).beat_duration,
                                    )}
                                    attribute={lane().attribute}
                                    trackKind={trackKind()}
                                    selectionPhaseOffset={previewPhaseOffset()}
                                    selectionPhaseOffsets={previewPhaseOffsets()}
                                    selectionSpread={phaseSpread()}
                                    selectionPhaseWrapsCycle={previewPhaseWrapsCycle()}
                                    selectionLabels={phaseMarkers().map(
                                      (marker) => marker.members,
                                    )}
                                    previewIndex={previewIndex()}
                                    showAllPlayheads={effectiveShowAllPlayheads()}
                                    centerSelectedFixture={centerSelectedFixture()}
                                    positionUnit={positionUnit()}
                                    cycleScale={current().cycle_scale}
                                    selectedStepUids={selectedStepUids()}
                                    titleControls={(samplingWarning) => (
                                      <PhasePreview
                                        markers={phaseMarkers()}
                                        phase={
                                          effectivePhase() ?? current().phase
                                        }
                                        issues={phaseIssues()}
                                        selectedIndex={previewIndex()}
                                        onSelectIndex={setPreviewIndex}
                                        showAllPlayheads={effectiveShowAllPlayheads()}
                                        showAllPlayheadsLocked={spreadEditing()}
                                        showAllPlayheadsDisabledReason={
                                          phaseHasSpread()
                                            ? undefined
                                            : "Show all is unavailable in Together mode because all fixtures overlap and behave as one."
                                        }
                                        onShowAllPlayheadsChange={
                                          setShowAllPlayheads
                                        }
                                        centerSelectedFixture={centerSelectedFixture()}
                                        onCenterSelectedFixtureChange={
                                          _setCenterSelectedFixture
                                        }
                                        samplingWarning={samplingWarning}
                                      />
                                    )}
                                    onLiveStepChange={setLiveStepUid}
                                    onStepSelect={selectStep}
                                    onDragTargetChange={setWaveformDragTarget}
                                    onStepControlPointChange={
                                      replaceWaveformControlPoint
                                    }
                                    onStepWidthChange={replaceWaveformStepWidth}
                                    onStepBoundaryChange={
                                      replaceWaveformStepBoundary
                                    }
                                    onStartPositionChange={
                                      replaceWaveformStartPosition
                                    }
                                    onSpreadChange={replaceWaveformSpread}
                                  />
                                }
                              />
                            </div>
                          )}
                        </Show>
                      </div>
                    </>
                  )}
                </Show>
              </section>
            </main>

            <Show when={issues().length > 0}>
              <div
                class="max-h-24 shrink-0 overflow-y-auto border-t border-red-800 bg-red-950/40 px-3 py-2 text-xs text-red-100"
                role="alert"
              >
                <For each={issues()}>
                  {(issue) => <div>{issue.message}</div>}
                </For>
              </div>
            </Show>
          </>
        )}
      </Show>

      <DeleteConfirmModal
        isOpen={isCloseConfirmOpen()}
        title="Discard unsaved Step FX changes?"
        message="You have unsaved changes. Close without saving?"
        confirmLabel="Discard"
        onCancel={() => setIsCloseConfirmOpen(false)}
        onConfirm={confirmClose}
      />
    </div>
  );
}

/** Renders the editor-owned label and spatial-selection fields in Properties. */
function StepFxProperties(props: {
  stepFx: types.StepFx | undefined;
  onLabelCommit: (stepFx: types.StepFx, label: string) => void;
  onSelectionChange: (selection: types.SpatialSelection) => void;
}) {
  return (
    <div>
      <CrudLabelProperties
        entry={props.stepFx}
        entityName="Step FX"
        getId={(stepFx) => stepFx.identifiers.id}
        getLabel={(stepFx) => stepFx.identifiers.label}
        onLabelCommit={props.onLabelCommit}
      />
      <Show when={props.stepFx}>
        {(stepFx) => (
          <div class="border-t border-neutral-700 p-4">
            <div class="text-xs font-medium text-neutral-300">Selection</div>
            <SpatialSelectionField
              label="Selection"
              variant="expanded"
              selection={stepFx().selection}
              onChange={props.onSelectionChange}
              class="mt-1 space-y-2"
            />
          </div>
        )}
      </Show>
    </div>
  );
}

/** Pages step selectors only when their combined width exceeds the available bar. */
function StepFxStepPager(props: {
  children: JSX.Element;
  onKeyDown: (event: KeyboardEvent) => void;
}) {
  let rootRef: HTMLDivElement | undefined;
  let viewportRef: HTMLDivElement | undefined;
  let contentRef: HTMLDivElement | undefined;
  let resizeObserver: ResizeObserver | undefined;
  let refreshFrame: number | undefined;
  const [overflowed, setOverflowed] = createSignal(false);
  const [canPageBackward, setCanPageBackward] = createSignal(false);
  const [canPageForward, setCanPageForward] = createSignal(false);

  /** Synchronizes paging affordances with content width and scroll position. */
  const refreshPagerState = (): void => {
    if (!rootRef || !viewportRef || !contentRef) return;
    const nextOverflowed = contentRef.scrollWidth > rootRef.clientWidth + 1;
    if (!nextOverflowed && viewportRef.scrollLeft !== 0)
      viewportRef.scrollLeft = 0;
    setOverflowed(nextOverflowed);
    setCanPageBackward(nextOverflowed && viewportRef.scrollLeft > 1);
    setCanPageForward(
      nextOverflowed &&
        viewportRef.scrollLeft + viewportRef.clientWidth <
          contentRef.scrollWidth - 1,
    );
  };

  /** Coalesces resize notifications after the browser finishes the current layout. */
  const schedulePagerRefresh = (): void => {
    if (refreshFrame !== undefined) return;
    refreshFrame = requestAnimationFrame(() => {
      refreshFrame = undefined;
      refreshPagerState();
    });
  };

  /** Moves by the largest whole selector group that fits in the viewport. */
  const pageSelectors = (direction: -1 | 1): void => {
    if (!viewportRef || !contentRef) return;
    const firstSelector = contentRef.firstElementChild;
    const selectorWidth =
      firstSelector instanceof HTMLElement
        ? firstSelector.getBoundingClientRect().width
        : 28;
    const gap = Number.parseFloat(getComputedStyle(contentRef).columnGap) || 4;
    const stride = selectorWidth + gap;
    const visibleCount = Math.max(
      1,
      Math.floor((viewportRef.clientWidth + gap) / stride),
    );
    viewportRef.scrollBy({
      left: direction * visibleCount * stride,
      behavior: "smooth",
    });
  };

  onMount(() => {
    if (!rootRef || !viewportRef || !contentRef) return;
    resizeObserver = new ResizeObserver(schedulePagerRefresh);
    resizeObserver.observe(rootRef);
    resizeObserver.observe(viewportRef);
    resizeObserver.observe(contentRef);
    schedulePagerRefresh();
  });

  onCleanup(() => {
    resizeObserver?.disconnect();
    if (refreshFrame !== undefined) cancelAnimationFrame(refreshFrame);
  });

  return (
    <div
      ref={rootRef}
      class="flex min-w-0 flex-1 items-center gap-1"
      data-step-fx-step-pager
    >
      <Show when={overflowed()}>
        <ToolbarButton
          label="Previous steps"
          class="shrink-0"
          disabled={!canPageBackward()}
          classList={{
            "cursor-not-allowed opacity-40": !canPageBackward(),
          }}
          onClick={() => pageSelectors(-1)}
        >
          <CaretLeftIcon class="size-4" weight="bold" aria-hidden />
        </ToolbarButton>
      </Show>
      <div
        ref={viewportRef}
        class="min-w-0 flex-1 overflow-hidden"
        data-step-fx-step-pager-viewport
        onScroll={refreshPagerState}
        onKeyDown={props.onKeyDown}
      >
        <div ref={contentRef} class="flex w-max items-center gap-1">
          {props.children}
        </div>
      </div>
      <Show when={overflowed()}>
        <ToolbarButton
          label="Next steps"
          class="shrink-0"
          disabled={!canPageForward()}
          classList={{
            "cursor-not-allowed opacity-40": !canPageForward(),
          }}
          onClick={() => pageSelectors(1)}
        >
          <CaretRightIcon class="size-4" weight="bold" aria-hidden />
        </ToolbarButton>
      </Show>
    </div>
  );
}

const STEP_FX_CURVE_NAMES = [
  "Snap",
  "Linear",
  "Ease",
  "Ease In",
  "Ease Out",
] as const;

type StepFxCurveName = (typeof STEP_FX_CURVE_NAMES)[number];

/** Renders an icon-capable selector for one authored transition curve. */
function StepFxCurveSelect(props: {
  stepNumber: number;
  curve: types.CurveType;
  onChange: (curve: types.CurveType) => void;
}) {
  /** Resolves the persisted curve to the selector's supported visual preset. */
  const selectedName = createMemo(() => curveName(props.curve));

  return (
    <DropdownMenu
      align="end"
      triggerLabel={`Step ${props.stepNumber} curve`}
      triggerClass="block w-full min-w-0"
      trigger={
        <span
          class={`${FIELD_CLASS} flex w-full min-w-0 items-center gap-1 px-1.5 text-left text-xs`}
        >
          <StepFxCurveIcon
            name={selectedName()}
            class="size-4 shrink-0 text-neutral-400"
          />
          <span class="min-w-0 flex-1 truncate">{selectedName()}</span>
          <CaretDownIcon class="size-3 shrink-0 text-neutral-400" aria-hidden />
        </span>
      }
    >
      <div class="py-0.5" data-menu-kind="step-fx-curve">
        <For each={STEP_FX_CURVE_NAMES}>
          {(name) => (
            <DropdownMenuItem
              onClick={() => props.onChange(curveFromName(name))}
            >
              <span
                class="flex min-w-0 flex-1 items-center gap-2"
                classList={{ "text-sky-300": selectedName() === name }}
                data-step-fx-curve-option={name}
              >
                <StepFxCurveIcon
                  name={name}
                  class="size-4 shrink-0 text-current"
                />
                <span>{name}</span>
              </span>
            </DropdownMenuItem>
          )}
        </For>
      </div>
    </DropdownMenu>
  );
}

/** Draws the normalized interpolation shape represented by one curve preset. */
function StepFxCurveIcon(props: { name: StepFxCurveName; class?: string }) {
  return (
    <svg
      class={props.class ?? "size-4"}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      data-step-fx-curve-icon={props.name}
    >
      <path
        d={stepFxCurveIconPath(props.name)}
        stroke="currentColor"
        stroke-width="1.75"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <circle cx="2" cy="14" r="1" fill="currentColor" />
      <circle cx="14" cy="2" r="1" fill="currentColor" />
    </svg>
  );
}

/** Returns compact SVG geometry that previews a supported interpolation curve. */
function stepFxCurveIconPath(name: StepFxCurveName): string {
  if (name === "Snap") return "M2 14 H8 V2 H14";
  if (name === "Linear") return "M2 14 L14 2";
  if (name === "Ease In") return "M2 14 C10 14 13 10 14 2";
  if (name === "Ease Out") return "M2 14 C3 6 6 2 14 2";
  return "M2 14 C8 14 8 2 14 2";
}

/** Renders absolute and relative contribution tabs beside the active step controls. */
function StepFxContributionTabs(props: {
  lane: types.FxLane;
  trackKind: StepFxTrackKind;
  previewSessionId: string;
  onSelectTrack: (kind: StepFxTrackKind) => void;
  onRemoveTrack: (kind: StepFxTrackKind) => void;
}) {
  return (
    <div
      class="inline-flex shrink-0 rounded bg-gray-800 p-0.5"
      role="tablist"
      aria-label={`${stepFxAttributeName(props.lane.attribute)} contribution`}
    >
      <div
        role="presentation"
        class="flex items-center rounded transition-colors"
        classList={{
          "bg-blue-600 text-white": props.trackKind === "absolute",
          "text-gray-400 hover:text-gray-200": props.trackKind !== "absolute",
        }}
      >
        <button
          type="button"
          id={`step-fx-${props.previewSessionId}-absolute-tab`}
          role="tab"
          aria-selected={props.trackKind === "absolute"}
          aria-controls={`step-fx-${props.previewSessionId}-steps-panel`}
          class={TAB_BUTTON_CLASS}
          onClick={() => props.onSelectTrack("absolute")}
        >
          Absolute{" "}
          {props.lane.absolute ? `(${props.lane.absolute.steps.length})` : ""}
        </button>
        <Show when={props.lane.absolute}>
          <button
            type="button"
            aria-label="Remove absolute steps"
            class="self-stretch rounded px-1.5 text-current/70 hover:bg-black/15 hover:text-current focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            onClick={() => props.onRemoveTrack("absolute")}
          >
            ×
          </button>
        </Show>
      </div>
      <div
        role="presentation"
        class="flex items-center rounded transition-colors"
        classList={{
          "bg-blue-600 text-white": props.trackKind === "relative",
          "text-gray-400 hover:text-gray-200": props.trackKind !== "relative",
        }}
      >
        <button
          type="button"
          id={`step-fx-${props.previewSessionId}-relative-tab`}
          role="tab"
          aria-selected={props.trackKind === "relative"}
          aria-controls={`step-fx-${props.previewSessionId}-steps-panel`}
          class={TAB_BUTTON_CLASS}
          onClick={() => props.onSelectTrack("relative")}
        >
          Relative{" "}
          {props.lane.relative ? `(${props.lane.relative.steps.length})` : ""}
        </button>
        <Show when={props.lane.relative}>
          <button
            type="button"
            aria-label="Remove relative steps"
            class="self-stretch rounded px-1.5 text-current/70 hover:bg-black/15 hover:text-current focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            onClick={() => props.onRemoveTrack("relative")}
          >
            ×
          </button>
        </Show>
      </div>
    </div>
  );
}

/** Renders lane-specific overrides at the end of the attribute Step bar. */
function StepFxOverridesControl(props: {
  lane: types.FxLane;
  overall: types.StepFx;
  open: boolean;
  onOpenChange: (isOpen: boolean) => void;
  onLaneChange: (lane: types.FxLane) => void;
}) {
  return (
    <div class="flex shrink-0 items-center gap-1">
      <DropdownMenu
        placement="below"
        align="end"
        triggerLabel="Overrides"
        open={props.open}
        onOpenChange={props.onOpenChange}
        trigger={
          <span class="inline-flex h-8 items-center gap-1 rounded border border-neutral-700 bg-neutral-800 px-2 text-xs text-neutral-200 hover:bg-neutral-700">
            Overrides
            <CaretDownIcon class="size-3" aria-hidden />
          </span>
        }
      >
        <div
          class="w-80 p-2"
          role="region"
          aria-label="Overrides"
          data-menu-kind="step-fx-overrides"
        >
          <AdvancedLaneControls
            lane={props.lane}
            overall={props.overall}
            onChange={props.onLaneChange}
          />
        </div>
      </DropdownMenu>
    </div>
  );
}

type StepFxStartPositionMode = "together" | "spread" | "custom";

/** Classifies authored phase waypoints into the visual editor's common modes. */
function stepFxStartPositionMode(
  phase: types.StepFxPhase,
): StepFxStartPositionMode {
  if (phase.waypoints.length <= 1) return "together";
  if (phase.waypoints.length === 2) return "spread";
  return "custom";
}

/** Formats the toolbar summary in the user's selected position unit. */
function stepFxStartPositionSummary(
  phase: types.StepFxPhase,
  unit: StepFxPositionUnit,
): string {
  const scale = stepFxPositionUnitScale(unit);
  const suffix = stepFxPositionUnitSuffix(unit);
  const values = phase.waypoints.map((waypoint) =>
    Number((waypoint * scale).toFixed(1)),
  );
  if (values.length <= 1) return `Start ${values[0] ?? 0}${suffix}`;
  if (values.length === 2) return `Spread ${values[0]}→${values[1]}${suffix}`;
  return `Custom ${values.join("→")}${suffix}`;
}

/** Renders common phase patterns visually while preserving advanced waypoint syntax. */
function StepFxStartPositionControls(props: {
  phase: types.StepFxPhase;
  open: boolean;
  highlighted: boolean;
  advancedFocusRequest: number;
  selectionCount: number;
  positionUnit: StepFxPositionUnit;
  onPositionUnitChange: (unit: StepFxPositionUnit) => void;
  onSpreadEditingChange: (editing: boolean) => void;
  onOpenChange: (isOpen: boolean) => void;
  onChange: (phase: types.StepFxPhase) => void;
}) {
  const [advancedOpen, setAdvancedOpen] = createSignal(
    stepFxStartPositionMode(props.phase) === "custom",
  );
  /** Returns the first authored waypoint in the selected display unit. */
  const startValue = (): number =>
    (props.phase.waypoints[0] ?? 0) *
    stepFxPositionUnitScale(props.positionUnit);
  /** Returns the signed two-point spread in the selected display unit. */
  const spreadValue = (): number =>
    ((props.phase.waypoints[1] ?? props.phase.waypoints[0] ?? 0) -
      (props.phase.waypoints[0] ?? 0)) *
    stepFxPositionUnitScale(props.positionUnit);
  /** Returns the direction sign currently applied to spread magnitude controls. */
  const spreadSign = (): -1 | 1 => (spreadValue() < 0 ? -1 : 1);
  /** Reports whether the open menu is actively exposing common spread controls. */
  createEffect(() => {
    props.onSpreadEditingChange(
      props.open && stepFxStartPositionMode(props.phase) === "spread",
    );
  });
  /** Reveals the advanced field before forwarding a shortcut focus request. */
  createEffect(() => {
    if (props.advancedFocusRequest > 0) setAdvancedOpen(true);
  });
  onCleanup(() => props.onSpreadEditingChange(false));
  /** Publishes a mode change using predictable defaults around the current start. */
  const setMode = (mode: StepFxStartPositionMode): void => {
    const start = props.phase.waypoints[0] ?? 0;
    if (mode === "together") {
      props.onChange({ waypoints: [start] });
      return;
    }
    if (mode === "spread") {
      props.onChange({ waypoints: [start, start + 1] });
      return;
    }
    props.onChange({ waypoints: [start, start + 1, start] });
  };
  /** Moves the complete distribution without changing its authored shape. */
  const setStartValue = (value: number): void => {
    if (!Number.isFinite(value)) return;
    const nextStart = value / stepFxPositionUnitScale(props.positionUnit);
    const currentStart = props.phase.waypoints[0] ?? 0;
    const delta = nextStart - currentStart;
    props.onChange({
      waypoints:
        props.phase.waypoints.length > 0
          ? props.phase.waypoints.map((waypoint) => waypoint + delta)
          : [nextStart],
    });
  };
  /** Updates the common two-point spread while retaining its start angle. */
  const setSpreadValue = (value: number): void => {
    if (!Number.isFinite(value)) return;
    const start = props.phase.waypoints[0] ?? 0;
    props.onChange({
      waypoints: [
        start,
        start + value / stepFxPositionUnitScale(props.positionUnit),
      ],
    });
  };
  /** Reverses only the authored spread direction while preserving its magnitude. */
  const reverseSpread = (): void => {
    const current = spreadValue();
    const fallback = stepFxPositionUnitScale(props.positionUnit);
    setSpreadValue(current === 0 ? -fallback : -current);
  };
  /** Applies a preset magnitude without changing the current spread direction. */
  const setSpreadMagnitude = (value: number): void => {
    setSpreadValue(spreadSign() * value);
  };

  return (
    <DropdownMenu
      placement="below"
      align="start"
      triggerLabel="Start position"
      open={props.open}
      onOpenChange={props.onOpenChange}
      trigger={
        <span
          class="inline-flex h-8 items-center gap-1.5 rounded border border-neutral-700 bg-neutral-800 px-2 text-xs tabular-nums text-neutral-200 hover:bg-neutral-700"
          classList={{
            "border-amber-300 bg-amber-400/15 text-amber-100 ring-1 ring-inset ring-amber-300/70":
              props.highlighted,
          }}
          data-waveform-drag-active={props.highlighted ? "true" : undefined}
        >
          {stepFxStartPositionSummary(props.phase, props.positionUnit)}
          <CaretDownIcon class="size-3" aria-hidden />
        </span>
      }
    >
      <div class="w-[22rem] py-1" data-menu-kind="step-fx-start-position">
        <div class="flex items-start justify-between gap-3 px-3 py-2">
          <div>
            <div class="text-xs font-medium uppercase tracking-wide text-neutral-400">
              Start position
            </div>
            <div class="text-xs text-neutral-500">
              Place the selection together or distribute it around the cycle.
            </div>
          </div>
          <div
            class="inline-flex shrink-0 rounded border border-neutral-700 bg-neutral-900 p-0.5"
            role="radiogroup"
            aria-label="Start position units"
          >
            <For each={["percent", "degrees"] as const}>
              {(unit) => (
                <button
                  type="button"
                  role="radio"
                  aria-label={unit === "percent" ? "Percent" : "Degrees"}
                  aria-checked={props.positionUnit === unit}
                  class={`rounded px-2 py-1 text-xs transition-colors hover:bg-neutral-700 ${props.positionUnit === unit ? "bg-blue-600 text-white" : "text-neutral-300"}`}
                  onClick={() => props.onPositionUnitChange(unit)}
                >
                  {stepFxPositionUnitSuffix(unit)}
                </button>
              )}
            </For>
          </div>
        </div>
        <DropdownMenuSeparator />
        <div class="space-y-3 px-3 py-2">
          <div
            class="grid grid-cols-3 rounded border border-neutral-700 bg-neutral-900 p-0.5"
            role="radiogroup"
            aria-label="Start position mode"
          >
            <For each={["together", "spread", "custom"] as const}>
              {(mode) => (
                <button
                  type="button"
                  role="radio"
                  aria-label={`${mode[0]?.toUpperCase()}${mode.slice(1)} start position`}
                  aria-checked={stepFxStartPositionMode(props.phase) === mode}
                  class={`rounded px-2 py-1.5 text-xs capitalize transition-colors hover:bg-neutral-700 ${stepFxStartPositionMode(props.phase) === mode ? "bg-blue-600 text-white" : "text-neutral-300"}`}
                  onClick={() => setMode(mode)}
                >
                  {mode}
                </button>
              )}
            </For>
          </div>

          <div class="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-3">
            <StepFxPhaseDial
              phase={props.phase}
              selectionCount={props.selectionCount}
            />
            <div class="space-y-2">
              <label class="grid grid-cols-[4rem_minmax(0,1fr)] items-center gap-2 text-xs text-neutral-300">
                Start
                <div class="relative">
                  <Input
                    density="compact"
                    type="number"
                    step="1"
                    aria-label="Start position value"
                    class={`${FIELD_CLASS} w-full pe-7 text-right`}
                    value={Number(startValue().toFixed(1))}
                    onInput={(event) =>
                      setStartValue(Number(event.currentTarget.value))
                    }
                  />
                  <span class="pointer-events-none absolute inset-y-0 right-2 flex items-center text-xs text-neutral-500">
                    {stepFxPositionUnitSuffix(props.positionUnit)}
                  </span>
                </div>
              </label>
              <input
                type="range"
                min="0"
                max={stepFxPositionUnitScale(props.positionUnit)}
                step="1"
                aria-label="Start position dial"
                class="w-full accent-[var(--accent)]"
                value={
                  ((startValue() %
                    stepFxPositionUnitScale(props.positionUnit)) +
                    stepFxPositionUnitScale(props.positionUnit)) %
                  stepFxPositionUnitScale(props.positionUnit)
                }
                onInput={(event) =>
                  setStartValue(Number(event.currentTarget.value))
                }
              />
              <div class="grid grid-cols-4 gap-1">
                <For
                  each={
                    props.positionUnit === "percent"
                      ? [0, 25, 50, 75]
                      : [0, 90, 180, 270]
                  }
                >
                  {(value) => (
                    <button
                      type="button"
                      class="rounded border border-neutral-700 bg-neutral-800 px-1 py-1 text-[11px] text-neutral-300 hover:bg-neutral-700"
                      onClick={() => setStartValue(value)}
                    >
                      {value}
                      {stepFxPositionUnitSuffix(props.positionUnit)}
                    </button>
                  )}
                </For>
              </div>
              <Show when={stepFxStartPositionMode(props.phase) === "spread"}>
                <label class="grid grid-cols-[4rem_minmax(0,1fr)] items-center gap-2 pt-1 text-xs text-neutral-300">
                  Spread
                  <div class="relative">
                    <Input
                      density="compact"
                      type="number"
                      step="1"
                      aria-label="Spread amount"
                      class={`${FIELD_CLASS} w-full pe-7 text-right`}
                      value={Number(spreadValue().toFixed(1))}
                      onInput={(event) =>
                        setSpreadValue(Number(event.currentTarget.value))
                      }
                    />
                    <span class="pointer-events-none absolute inset-y-0 right-2 flex items-center text-xs text-neutral-500">
                      {stepFxPositionUnitSuffix(props.positionUnit)}
                    </span>
                  </div>
                </label>
                <input
                  type="range"
                  min="0"
                  max={stepFxPositionUnitScale(props.positionUnit)}
                  step="1"
                  aria-label="Spread amount slider"
                  class="w-full accent-[var(--accent)]"
                  value={Math.min(
                    Math.abs(spreadValue()),
                    stepFxPositionUnitScale(props.positionUnit),
                  )}
                  onInput={(event) =>
                    setSpreadMagnitude(Number(event.currentTarget.value))
                  }
                />
                <div class="grid grid-cols-4 gap-1">
                  <For
                    each={
                      props.positionUnit === "percent"
                        ? [25, 50, 100]
                        : [90, 180, 360]
                    }
                  >
                    {(value) => (
                      <button
                        type="button"
                        class="rounded border border-neutral-700 bg-neutral-800 px-1 py-1 text-[11px] text-neutral-300 hover:bg-neutral-700"
                        onClick={() => setSpreadMagnitude(value)}
                      >
                        {spreadSign() * value}
                        {stepFxPositionUnitSuffix(props.positionUnit)}
                      </button>
                    )}
                  </For>
                  <button
                    type="button"
                    class="rounded border border-neutral-700 bg-neutral-800 px-1 py-1 text-[11px] text-neutral-300 hover:bg-neutral-700"
                    onClick={reverseSpread}
                  >
                    Reverse
                  </button>
                </div>
              </Show>
            </div>
          </div>

          <Show when={stepFxStartPositionMode(props.phase) === "custom"}>
            <div class="rounded border border-[var(--accent)] bg-[var(--accent-soft)] px-2 py-1.5 text-xs text-[var(--accent)]">
              Custom mode keeps each position in the sequence. Changing Start
              moves every position by the same amount.
            </div>
          </Show>

          <details
            open={
              advancedOpen() ||
              stepFxStartPositionMode(props.phase) === "custom"
            }
            onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
          >
            <summary class="cursor-pointer text-xs text-neutral-400 hover:text-neutral-200">
              Advanced expression
            </summary>
            <div class="mt-2">
              <StepFxPhaseField
                ariaLabel="Advanced start position expression"
                phase={props.phase}
                focusRequest={props.advancedFocusRequest}
                onChange={props.onChange}
              />
              <div class="mt-1 text-[11px] text-neutral-500">
                Advanced expressions use degrees. Enter positions such as 180,
                0&gt;360, or 0&gt;360&gt;0.
              </div>
            </div>
          </details>
        </div>
      </div>
    </DropdownMenu>
  );
}

/** Draws the authored selection offsets around one normalized cycle. */
function StepFxPhaseDial(props: {
  phase: types.StepFxPhase;
  selectionCount: number;
}) {
  const directionRadius = 54;
  const directionMarkerId = `step-fx-phase-direction-${crypto.randomUUID()}`;
  /** Selects representative indexes without overcrowding the compact dial. */
  const indexes = createMemo(() => {
    const count = Math.max(1, props.selectionCount);
    const displayed = Math.min(count, 12);
    return Array.from({ length: displayed }, (_, index) =>
      Math.min(count - 1, Math.floor((index * count) / displayed)),
    );
  });
  /** Converts one normalized phase into dial coordinates. */
  const point = (phase: number, radius: number) => {
    const angle = phase * Math.PI * 2 - Math.PI / 2;
    return {
      x: 60 + Math.cos(angle) * radius,
      y: 60 + Math.sin(angle) * radius,
    };
  };
  /** Returns one displayed index's resolved phase. */
  const offsetFor = (index: number): number =>
    stepFxPhaseOffset(props.phase, index, Math.max(1, props.selectionCount));
  /** Returns the start pointer endpoint. */
  const startPoint = () => point(props.phase.waypoints[0] ?? 0, 35);
  /** Resolves the first authored movement as clockwise or counterclockwise. */
  const direction = (): -1 | 1 => {
    const start = props.phase.waypoints[0] ?? 0;
    const next = props.phase.waypoints
      .slice(1)
      .find((waypoint) => Math.abs(waypoint - start) > 0.000_001);
    return next !== undefined && next < start ? -1 : 1;
  };
  /** Draws a 45-degree directional arc around the outer edge of the black dial. */
  const directionArc = (): string => {
    const start = props.phase.waypoints[0] ?? 0;
    const from = point(start, directionRadius);
    const to = point(start + direction() / 8, directionRadius);
    return `M ${from.x} ${from.y} A ${directionRadius} ${directionRadius} 0 0 ${direction() > 0 ? 1 : 0} ${to.x} ${to.y}`;
  };

  return (
    <svg
      viewBox="0 0 120 120"
      class="size-32 rounded-full bg-neutral-950"
      role="img"
      aria-label={`Start position preview for ${Math.max(1, props.selectionCount)} selection indexes`}
    >
      <defs>
        <marker
          id={directionMarkerId}
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="5"
          markerHeight="5"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 8 4 L 0 8 z" fill="rgb(147 197 253)" />
        </marker>
      </defs>
      <circle
        cx="60"
        cy="60"
        r="44"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        class="text-neutral-700"
      />
      <path
        d={directionArc()}
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        marker-end={`url(#${directionMarkerId})`}
        class="text-[var(--accent)]"
        data-step-fx-start-position-direction-radius={directionRadius}
        data-step-fx-start-position-direction={
          direction() > 0 ? "clockwise" : "counterclockwise"
        }
      />
      <line
        x1="60"
        y1="60"
        x2={startPoint().x}
        y2={startPoint().y}
        stroke="currentColor"
        stroke-width="2"
        class="text-[var(--accent)]"
      />
      <circle cx="60" cy="60" r="3" class="fill-[var(--accent)]" />
      <For each={indexes()}>
        {(index) => {
          /** Returns this marker's current dial position. */
          const marker = () => point(offsetFor(index), 44);
          return (
            <circle
              cx={marker().x}
              cy={marker().y}
              r="4"
              class={index === 0 ? "fill-amber-300" : "fill-sky-300"}
              stroke="rgb(23 23 23)"
              stroke-width="1.5"
              data-step-fx-start-position-marker={index}
            />
          );
        }}
      </For>
    </svg>
  );
}

/** Renders compact effect-wide speed and cycle scaling in a toolbar menu. */
function StepFxTimingControls(props: {
  stepFx: types.StepFx;
  open: boolean;
  onOpenChange: (isOpen: boolean) => void;
  speedUnit: StepFxSpeedUnit;
  cycleBeatText: string | null;
  fixedScaleDefault: number;
  trackKind: StepFxTrackKind;
  speedError?: string;
  scaleError?: string;
  onSpeedUnitChange: (unit: StepFxSpeedUnit) => void;
  onTimingChange: (timing: types.StepFxTiming) => void;
  onCycleScaleChange: (scale: types.StepFxCycleScale) => void;
}) {
  const cycleScaleName = crypto.randomUUID();
  const [fixedScaleValue, setFixedScaleValue] = createSignal(
    props.stepFx.cycle_scale.type === "Fixed"
      ? props.stepFx.cycle_scale.data
      : props.fixedScaleDefault,
  );

  /** Retains externally authored fixed values without clearing them in Auto mode. */
  createEffect(() => {
    const scale = props.stepFx.cycle_scale;
    if (scale.type === "Fixed") setFixedScaleValue(scale.data);
  });

  return (
    <DropdownMenu
      placement="below"
      align="start"
      triggerLabel="Speed and scaling"
      open={props.open}
      onOpenChange={props.onOpenChange}
      trigger={
        <span class="inline-flex h-8 items-center gap-1.5 rounded border border-neutral-700 bg-neutral-800 px-2 text-xs tabular-nums text-neutral-200 hover:bg-neutral-700">
          {stepFxSpeedValue(props.stepFx.timing, props.speedUnit)}{" "}
          {props.speedUnit}{" "}
          <span class="text-neutral-400">
            · {props.stepFx.cycle_scale.type}
          </span>
          <CaretDownIcon class="size-3" aria-hidden />
        </span>
      }
    >
      <div class="w-80 py-1" data-menu-kind="step-fx-timing">
        <div class="px-3 py-2">
          <div class="text-xs font-medium uppercase tracking-wide text-neutral-400">
            Speed and scaling
          </div>
          <div class="text-xs text-neutral-500">Effect-wide cycle timing</div>
        </div>
        <DropdownMenuSeparator />
        <div class="space-y-3 px-3 py-2">
          <label class="grid grid-cols-[5rem_minmax(0,1fr)] items-center gap-3">
            <span class="text-xs text-neutral-300">Speed</span>
            <div class="relative min-w-0" data-input-group="speed">
              <Input
                density="compact"
                aria-label="Step FX speed"
                aria-invalid={Boolean(props.speedError)}
                type="number"
                min="0.001"
                step="any"
                class={`${FIELD_CLASS} w-full min-w-0 pe-28 ${props.speedError ? "border-red-500" : ""}`}
                value={stepFxSpeedValue(props.stepFx.timing, props.speedUnit)}
                onChange={(event) => {
                  const timing = stepFxTimingFromSpeed(
                    Number(event.currentTarget.value),
                    props.speedUnit,
                  );
                  if (timing) props.onTimingChange(timing);
                }}
              />
              <div class="absolute inset-y-px right-px flex items-center">
                <NativeSelect
                  density="compact"
                  aria-label="Step FX speed unit"
                  class="h-full w-28 rounded-r border-0 border-l border-neutral-700 bg-neutral-800 px-2 pe-7 text-xs text-neutral-200 focus:border-[var(--accent)] focus:outline-none"
                  value={props.speedUnit}
                  onChange={(event) =>
                    props.onSpeedUnitChange(
                      event.currentTarget.value as StepFxSpeedUnit,
                    )
                  }
                >
                  <option>BPM</option>
                  <option>Hz</option>
                  <option>Seconds</option>
                  <option>Milliseconds</option>
                </NativeSelect>
              </div>
            </div>
          </label>
          <div class="grid grid-cols-[5rem_minmax(0,1fr)] items-start gap-3">
            <span class="pt-2 text-xs text-neutral-300">Scale cycle</span>
            <div class="min-w-0 space-y-1">
              <div
                class="flex min-w-0 rounded"
                role="radiogroup"
                aria-label="Step FX cycle scaling"
                data-input-group="cycle-scale"
              >
                <label
                  class="inline-flex shrink-0 items-center gap-1 rounded-l border border-r-0 border-neutral-700 px-1.5 text-[11px]"
                  classList={{
                    "bg-[var(--accent-soft)] text-[var(--accent)]":
                      props.stepFx.cycle_scale.type === "Auto",
                    "bg-neutral-800 text-neutral-300":
                      props.stepFx.cycle_scale.type !== "Auto",
                  }}
                >
                  <Radio
                    aria-label="Automatic cycle scaling"
                    name={cycleScaleName}
                    class="size-3 shrink-0"
                    checked={props.stepFx.cycle_scale.type === "Auto"}
                    onChange={() => props.onCycleScaleChange({ type: "Auto" })}
                  />
                  <span>Auto</span>
                </label>
                <label
                  class="inline-flex shrink-0 items-center gap-1 border border-r-0 border-neutral-700 px-1.5 text-[11px]"
                  classList={{
                    "bg-[var(--accent-soft)] text-[var(--accent)]":
                      props.stepFx.cycle_scale.type === "Fixed",
                    "bg-neutral-800 text-neutral-300":
                      props.stepFx.cycle_scale.type !== "Fixed",
                  }}
                >
                  <Radio
                    aria-label="Fixed cycle scaling"
                    name={cycleScaleName}
                    class="size-3 shrink-0"
                    checked={props.stepFx.cycle_scale.type === "Fixed"}
                    onChange={() =>
                      props.onCycleScaleChange({
                        type: "Fixed",
                        data: fixedScaleValue(),
                      })
                    }
                  />
                  <span>Fixed</span>
                </label>
                <div class="relative min-w-0 flex-1">
                  <Input
                    density="compact"
                    aria-label="Step FX cycle beats"
                    aria-invalid={Boolean(props.scaleError)}
                    type="number"
                    min="0.001"
                    step="any"
                    disabled={props.stepFx.cycle_scale.type !== "Fixed"}
                    class={`${FIELD_CLASS} w-full min-w-0 rounded-l-none pe-10 text-right disabled:text-neutral-600 ${props.scaleError ? "border-red-500" : ""}`}
                    value={
                      props.stepFx.cycle_scale.type === "Fixed"
                        ? props.stepFx.cycle_scale.data
                        : props.fixedScaleDefault
                    }
                    onInput={(event) => {
                      const value = Number(event.currentTarget.value);
                      setFixedScaleValue(value);
                      props.onCycleScaleChange({
                        type: "Fixed",
                        data: value,
                      });
                    }}
                  />
                  <span class="pointer-events-none absolute inset-y-0 right-1.5 flex items-center text-[10px] text-neutral-400">
                    beats
                  </span>
                </div>
              </div>
              <div class="text-[11px] text-neutral-500">
                {props.stepFx.cycle_scale.type === "Auto"
                  ? `${props.trackKind === "absolute" ? "Absolute" : "Relative"} steps cycle: ${props.cycleBeatText ?? "—"} beats`
                  : `Steps are scaled proportionally to fit a ${props.cycleBeatText ?? "—"}-beat cycle`}
              </div>
            </div>
          </div>
        </div>
      </div>
    </DropdownMenu>
  );
}

/** Renders icon radio buttons for the effect-wide traversal direction. */
function StepFxDirectionControl(props: {
  direction: FxDirection;
  onChange: (direction: FxDirection) => void;
}) {
  const directionButtonClass =
    "inline-flex size-8 items-center justify-center border border-neutral-700 text-neutral-300 transition-colors hover:bg-neutral-700 aria-checked:bg-blue-600 aria-checked:text-white";

  return (
    <div
      class="inline-flex shrink-0 items-center"
      role="radiogroup"
      aria-label="Step FX direction"
    >
      <button
        type="button"
        role="radio"
        aria-label="Reverse direction"
        aria-checked={props.direction === FxDirection.Reverse}
        title="Reverse"
        class={`${directionButtonClass} rounded-l`}
        onClick={() => props.onChange(FxDirection.Reverse)}
      >
        <ArrowLeftIcon class="size-4" aria-hidden />
      </button>
      <button
        type="button"
        role="radio"
        aria-label="Bounce direction"
        aria-checked={props.direction === FxDirection.Bounce}
        title="Bounce"
        class={`${directionButtonClass} border-x-0`}
        onClick={() => props.onChange(FxDirection.Bounce)}
      >
        <ArrowsLeftRightIcon class="size-4" aria-hidden />
      </button>
      <button
        type="button"
        role="radio"
        aria-label="Forward direction"
        aria-checked={props.direction === FxDirection.Forward}
        title="Forward"
        class={`${directionButtonClass} rounded-r`}
        onClick={() => props.onChange(FxDirection.Forward)}
      >
        <ArrowRightIcon class="size-4" aria-hidden />
      </button>
    </div>
  );
}

/** Selects one resolved phase index as the waveform's live reference. */
function PhasePreview(props: {
  markers: PhaseMarker[];
  phase: types.StepFxPhase;
  issues: string[];
  selectedIndex: number;
  onSelectIndex: (index: number) => void;
  showAllPlayheads: boolean;
  showAllPlayheadsLocked: boolean;
  showAllPlayheadsDisabledReason?: string;
  onShowAllPlayheadsChange: (showAll: boolean) => void;
  centerSelectedFixture: boolean;
  onCenterSelectedFixtureChange: (centerFixture: boolean) => void;
  samplingWarning: JSX.Element;
}) {
  /** Builds compact indexes for the resolved spatial selection. */
  const indexes = createMemo(() =>
    Array.from({ length: props.markers.length }, (_, index) => index),
  );
  const viewButtonClass =
    "inline-flex h-7 items-center justify-center border border-neutral-700 px-2 text-[11px] font-medium text-neutral-300 transition-colors hover:bg-neutral-700 aria-checked:bg-blue-600 aria-checked:text-white";
  return (
    <div
      class="flex min-w-0 items-center justify-start gap-1"
      role="group"
      aria-label="Waveform preview"
    >
      <div
        class="mr-1 inline-flex shrink-0 items-center"
        role="radiogroup"
        aria-label="Waveform scrolling"
      >
        <span
          class="inline-flex size-7 items-center justify-center rounded-l border border-r-0 border-neutral-700 bg-neutral-900 text-neutral-400"
          role="img"
          aria-label="Waveform scrolling mode"
          title="Waveform scrolling mode"
        >
          <MouseScrollIcon class="size-4" aria-hidden />
        </span>
        <button
          type="button"
          role="radio"
          aria-label="Fixture"
          aria-checked={!props.centerSelectedFixture}
          title="Fixture: scroll fixture playheads across a fixed waveform"
          class={`${viewButtonClass} border-r-0`}
          onClick={() => props.onCenterSelectedFixtureChange(false)}
        >
          Fixture
        </button>
        <button
          type="button"
          role="radio"
          aria-label="Waveform"
          aria-checked={props.centerSelectedFixture}
          title="Waveform: scroll the waveform beneath the selected fixture"
          class={`${viewButtonClass} rounded-r`}
          onClick={() => props.onCenterSelectedFixtureChange(true)}
        >
          Waveform
        </button>
      </div>
      <span
        class="mx-1 h-6 w-px shrink-0 bg-neutral-700"
        data-step-fx-waveform-scroll-separator
        aria-hidden
      />
      <label class="flex shrink-0 items-center gap-1 text-[11px] text-neutral-400">
        <Checkbox
          aria-label="Show all waveform playheads"
          checked={props.showAllPlayheads}
          disabled={
            props.showAllPlayheadsLocked ||
            props.showAllPlayheadsDisabledReason !== undefined
          }
          onChange={(event) =>
            props.onShowAllPlayheadsChange(event.currentTarget.checked)
          }
        />
        <span>Show all</span>
      </label>
      <Show when={props.showAllPlayheadsDisabledReason}>
        {(reason) => (
          <Tooltip content={() => reason()} position="bottom">
            <span
              class="mr-1 inline-flex size-5 shrink-0 items-center justify-center rounded text-amber-300 outline-none focus-visible:ring-1 focus-visible:ring-amber-300"
              role="img"
              aria-label={reason()}
              tabindex="0"
              data-step-fx-show-all-warning
            >
              <WarningIcon class="size-4" weight="fill" aria-hidden />
            </span>
          </Tooltip>
        )}
      </Show>
      {props.samplingWarning}
      <Show
        when={props.markers.length > 0}
        fallback={
          <span class="text-xs text-neutral-500">
            Selection order unavailable or empty
          </span>
        }
      >
        <Show
          when={props.markers.length <= 8}
          fallback={
            <label
              class="flex h-6 items-center rounded border border-neutral-700 bg-neutral-900 px-1 text-[10px] text-neutral-300"
              title={previewIndexTitle(
                props.markers,
                props.selectedIndex,
                props.phase,
              )}
            >
              <Input
                density="compact"
                aria-label="Waveform preview index"
                type="number"
                min="1"
                max={props.markers.length}
                class="h-5 w-10 bg-transparent text-right text-amber-200 outline-none"
                value={props.selectedIndex + 1}
                onInput={(event) =>
                  props.onSelectIndex(
                    Math.max(
                      0,
                      Math.min(
                        props.markers.length - 1,
                        Math.floor(Number(event.currentTarget.value)) - 1,
                      ),
                    ),
                  )
                }
              />
              <span class="px-1">/ {props.markers.length}</span>
            </label>
          }
        >
          <For each={indexes()}>
            {(index) => (
              <button
                type="button"
                class="flex h-6 min-w-10 shrink-0 items-center justify-center rounded border px-1 text-[10px]"
                classList={{
                  "border-amber-400/70 bg-amber-400/15 text-amber-100":
                    props.selectedIndex === index,
                  "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]":
                    props.selectedIndex !== index,
                }}
                aria-pressed={props.selectedIndex === index}
                title={previewIndexTitle(props.markers, index, props.phase)}
                data-step-fx-preview-index={index}
                onClick={() => props.onSelectIndex(index)}
              >
                <span>{index + 1}</span>
                <span class="ml-1 opacity-80">
                  {formatDegrees(
                    stepFxPhaseOffset(props.phase, index, props.markers.length),
                  )}
                </span>
              </button>
            )}
          </For>
        </Show>
      </Show>
      <Show when={props.issues.length > 0}>
        <span
          class="ml-auto shrink-0 text-[11px] text-amber-300"
          title={props.issues.join("\n")}
        >
          Selection warning
        </span>
      </Show>
    </div>
  );
}

/** Describes the fixtures and phase offset represented by one preview index. */
function previewIndexTitle(
  markers: PhaseMarker[],
  index: number,
  phase: types.StepFxPhase,
): string {
  const marker = markers[index];
  const members = marker
    ? marker.memberCount > 1
      ? `${marker.members} (${marker.memberCount})`
      : marker.members
    : "unavailable";
  const offset = stepFxPhaseOffset(phase, index, markers.length);
  return `Preview index ${index + 1}: ${members}; phase offset ${formatDegrees(offset)}`;
}

/** Edits optional timing and phase overrides for the active lane. */
function AdvancedLaneControls(props: {
  lane: types.FxLane;
  overall: types.StepFx;
  onChange: (lane: types.FxLane) => void;
}) {
  /** Publishes an independently cloned lane update. */
  const update = (edit: (lane: types.FxLane) => void): void => {
    const lane = structuredClone(props.lane);
    edit(lane);
    props.onChange(lane);
  };
  return (
    <div class="space-y-1 text-xs">
      <div
        class="grid grid-cols-[minmax(0,1fr)_8.5rem] items-center gap-2 rounded px-1 py-1"
        data-step-fx-lane-override="speed"
        role="group"
        aria-label="Speed override"
      >
        <label class="flex min-w-0 items-center gap-2 text-neutral-200">
          <Checkbox
            checked={Boolean(props.lane.timing_override)}
            onChange={(event) =>
              update(
                (lane) =>
                  (lane.timing_override = event.currentTarget.checked
                    ? structuredClone(props.overall.timing)
                    : undefined),
              )
            }
          />
          <span class="whitespace-nowrap">Override speed</span>
        </label>
        <Input
          density="compact"
          aria-label="Lane BPM"
          type="number"
          min="0.001"
          disabled={!props.lane.timing_override}
          class={`${FIELD_CLASS} w-full min-w-0`}
          value={stepFxSpeedValue(
            props.lane.timing_override ?? props.overall.timing,
            "BPM",
          )}
          onChange={(event) => {
            const next = stepFxTimingFromSpeed(
              Number(event.currentTarget.value),
              "BPM",
            );
            if (next) update((lane) => (lane.timing_override = next));
          }}
        />
      </div>
      <div
        class="grid grid-cols-[minmax(0,1fr)_8.5rem] items-start gap-2 rounded px-1 py-1"
        data-step-fx-lane-override="start-position"
        role="group"
        aria-label="Start position override"
      >
        <label class="flex min-w-0 items-center gap-2 pt-2 text-neutral-200">
          <Checkbox
            checked={Boolean(props.lane.phase_override)}
            onChange={(event) =>
              update(
                (lane) =>
                  (lane.phase_override = event.currentTarget.checked
                    ? structuredClone(props.overall.phase)
                    : undefined),
              )
            }
          />
          <span class="whitespace-nowrap">Override start position</span>
        </label>
        <StepFxPhaseField
          ariaLabel="Lane start position"
          phase={props.lane.phase_override ?? props.overall.phase}
          disabled={!props.lane.phase_override}
          onChange={(nextPhase) =>
            update((lane) => (lane.phase_override = nextPhase))
          }
        />
      </div>
    </div>
  );
}

/** Returns the authored numeric component from any generated ParameterValue variant. */
function stepFxNumericTarget(target: types.ParameterValue): number {
  return target.type === "Absolute" || target.type === "AbsolutePercent"
    ? target.data.value
    : target.data.offset;
}

/** Returns the constrained editor label for a persisted transition curve. */
function curveName(curve: types.CurveType): StepFxCurveName {
  if (curve.type !== "Bezier") return curve.type;
  const { cp1, cp2 } = curve.data;
  if (cp1.x === 0.42 && cp2.x === 1) return "Ease In";
  if (cp1.x === 0 && cp2.x === 0.58) return "Ease Out";
  return "Ease";
}

/** Creates one supported backend transition curve from its sheet label. */
function curveFromName(name: StepFxCurveName): types.CurveType {
  if (name === "Snap") return { type: "Snap", data: {} };
  if (name === "Linear") return { type: "Linear", data: {} };
  if (name === "Ease In")
    return {
      type: "Bezier",
      data: { cp1: { x: 0.42, y: 0 }, cp2: { x: 1, y: 1 } },
    };
  if (name === "Ease Out")
    return {
      type: "Bezier",
      data: { cp1: { x: 0, y: 0 }, cp2: { x: 0.58, y: 1 } },
    };
  return {
    type: "Bezier",
    data: { cp1: { x: 0.42, y: 0 }, cp2: { x: 0.58, y: 1 } },
  };
}

/** Compares string sets without relying on insertion order. */
function setsEqual(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): boolean {
  return (
    left.size === right.size &&
    Array.from(left).every((value) => right.has(value))
  );
}

/** Formats normalized phase as compact wrapped degree readout. */
function formatDegrees(phase: number): string {
  return `${Number((phase * 360).toFixed(1))}°`;
}

/** Formats one resolved fixture reference for visible phase-order inspection. */
function fixtureRefLabel(
  ref: types.FixtureRef,
  fixtures: Record<string, types.Fixture>,
): string {
  const compactUid = ref.fixture_uid.replace(/-/g, "").toLowerCase();
  const fixture = Object.values(fixtures).find(
    (candidate) =>
      candidate.identifiers.uid.replace(/-/g, "").toLowerCase() === compactUid,
  );
  const label = fixture
    ? `Fixture ${fixture.identifiers.id}`
    : "Missing fixture";
  return ref.index === undefined ? label : `${label}.${ref.index}`;
}

/** Builds a stable token for inputs that affect spatial target resolution. */
function selectionProjectionToken(
  selection: SpatialSelection | undefined,
  fixtures: Record<string, types.Fixture>,
  groups: Record<string, types.Group>,
): string {
  return JSON.stringify([
    selection,
    Object.values(fixtures).map((fixture) => [
      fixture.identifiers.id,
      fixture.identifiers.uid,
      fixture.elements.length,
    ]),
    Object.values(groups),
  ]);
}

/** Resolves concrete targets and representative phase markers for one stored selection. */
async function projectStepFxSelection(
  selection: SpatialSelection,
  fixtures: Record<string, types.Fixture>,
  groups: Record<string, types.Group>,
): Promise<{
  markers: PhaseMarker[];
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
          .map((member) => fixtureRefLabel(member.fixture, fixtures))
          .join(", "),
      })),
    issues: projected?.issues ?? ["Selection projection failed"],
    targets: indexes.flatMap((index) =>
      index.members.map((member) => ({ ...member.fixture })),
    ),
  };
}
