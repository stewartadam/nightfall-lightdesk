// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { createDraggable } from "@neodrag/solid";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  Show,
  untrack,
} from "solid-js";
import { Portal } from "solid-js/web";
import { useAppShell } from "../../components/providers/app-shell";
import { useUiAction } from "../../components/providers/command-registry";
import { overlayHost } from "../../components/ui/modal/dialog-stack";
import { Button } from "../../components/ui/visual-language/button";
import { hasDiskStorage } from "../../lib/disk-storage";
import { getLogger } from "../../lib/logger";
import {
  type PanelComponentName,
  panelDefinitionByName,
} from "../../lib/panel-definitions";
import {
  openOrFocusPanel,
  openOrFocusPanelDefinition,
  type PanelOpenTarget,
} from "../../lib/panel-open-command";
import {
  activeInstances,
  clips,
  cues,
  fixtures,
  fx,
  programmerSelection,
  programmerState,
  pushToast,
  runtimeCapabilities,
  sequences,
  timecodes,
  timelines,
} from "../../state/appStores";
import { activeLayoutId, whenLayoutSettled } from "../../state/layout-switcher";
import { patchPanelActiveTab, revealPatchFixtures } from "../patch";
import { normalizeTimelineUid } from "../timeline";
import {
  clearProgrammerCompletely,
  isPlaybackRunning,
  stopAllPlayback,
} from "./cleanup";
import { visibleGuideContent } from "./content";
import { GuideContentItem } from "./guide-content";
import { GuideTarget, whenTargetSettles } from "./guide-target";
import {
  enterLessonLayout,
  fallbackReturnLayoutId,
  findLessonLayoutId,
  LESSON_LAYOUT_NAME,
  leaveLessonLayout,
  removeLessonLayout,
} from "./lesson-layout";
import { guideLessons } from "./lesson-store";
import type { GuidePrerequisite, GuideStep, GuideStepPart } from "./lessons";
import {
  collapseCoveringEdgeGroups,
  type GuidePanel,
  type GuidePanelSnapshot,
  trackGuidePanels,
} from "./panel-tracking";
import { guideCompletionToken } from "./progress";
import {
  closeWelcomeGuide,
  guideCompleted,
  guideDismissed,
  guideLessonId,
  guideOpen,
  guideReturnLayoutId,
  guideStepIndex,
  openWelcomeGuide,
  startGuideLesson,
} from "./state";
import { useFloatingGuide } from "./use-floating-guide";
import { useGuideProgress, useGuideSnapshot } from "./use-guide-progress";
import "./welcome-guide.css";

const log = getLogger(import.meta.url);

/** Offers an unobtrusive invitation to the guide until the user opens or dismisses it. */
export function GuideInvitation() {
  const dismissed = useStore(guideDismissed);
  const opened = useStore(guideOpen);
  return (
    <Show when={!dismissed() && !opened()}>
      <aside class="nf-guide-invitation" aria-label="Welcome to Nightfall">
        <div>
          <strong>New to Nightfall?</strong>
          <p>Take a short orientation, then make your first lights.</p>
        </div>
        <Button size="compact" variant="primary" onClick={openWelcomeGuide}>
          Take the tour
        </Button>
        <Button size="compact" onClick={closeWelcomeGuide}>
          Explore on my own
        </Button>
      </aside>
    </Show>
  );
}

/** The header command input, which steps teaching typed commands point at. */
const COMMAND_INPUT = "#header-cmdline";
/** How long the card keeps its anchor after the target vanishes, so a step about to advance doesn't jump. */
const ANCHOR_GRACE_MS = 400;
/** Longest a launching lesson's card stays hidden while it waits for the first step's target. */
const REVEAL_TIMEOUT_MS = 1000;
/** Longest a step that opened a panel waits for the next step's target to lay out. */
const PANEL_SETTLE_TIMEOUT_MS = 1000;

/** Hosts the lesson library and floating instructions; all engine actions remain user initiated. */
export default function WelcomeGuide() {
  const lessons = useStore(guideLessons);
  const opened = useStore(guideOpen);
  const lessonId = useStore(guideLessonId);
  const index = useStore(guideStepIndex);
  const completed = useStore(guideCompleted);
  const capabilities = useStore(runtimeCapabilities);
  const timelineMap = useStore(timelines);
  const clipMap = useStore(clips);
  const sequenceMap = useStore(sequences);
  const cueMap = useStore(cues);
  const fixtureMap = useStore(fixtures);
  const fxMap = useStore(fx);
  const instanceMap = useStore(activeInstances);
  const clockMap = useStore(timecodes);
  const programmerSelectionList = useStore(programmerSelection);
  const programmerRows = useStore(programmerState);
  /** Finds the generated sample timeline without relying on its session-specific UID. */
  const sampleTimeline = createMemo(() =>
    Object.values(timelineMap()).find((entry) => entry.identifiers.id === 1),
  );
  const { dockviewApi, resetActiveLayout, closeSettings, hideShortcutsPopup } =
    useAppShell();
  const [startingLesson, setStartingLesson] = createSignal(false);
  /**
   * Hides the card and the target highlight while a lesson launches, until the layout switch has
   * settled and the card has been placed beside the first step's target.
   */
  const [revealPending, setRevealPending] = createSignal(false);
  /**
   * Starts a lesson from the default arrangement in the Lesson layout,
   * remembering the user's own layout so they can return to it.
   * The lesson begins only once the switch's entrance animation has finished.
   */
  const startLesson = async (id: string) => {
    if (startingLesson()) return;
    setStartingLesson(true);
    setRevealPending(true);
    try {
      const api = dockviewApi();
      const entered = api
        ? await enterLessonLayout(api, resetActiveLayout)
        : null;
      if (!entered)
        pushToast(
          "warning",
          "Could not switch to the Lesson layout, so this lesson uses your current layout.",
        );
      else if (
        entered.previousLayoutId &&
        entered.previousLayoutId !== findLessonLayoutId()
      )
        guideReturnLayoutId.set(entered.previousLayoutId);
      await whenLayoutSettled();
    } catch (error) {
      log.error("Failed to prepare the Lesson layout", error);
    } finally {
      // Start before clearing the flag, so the reveal never sees a launch without a lesson.
      startGuideLesson(id);
      setStartingLesson(false);
    }
  };
  let returning = false;
  /**
   * Switches back to the layout the user had before lessons began, if the guide switched away from it.
   * When that layout is unknown or gone while the Lesson layout is showing, falls back to the user's
   * first saved layout so they are never left in Lesson. Ignores repeated requests while a switch runs.
   */
  const returnToLayout = async () => {
    const api = dockviewApi();
    if (!api || returning) return;
    const inLesson =
      activeLayoutId.get() !== null &&
      activeLayoutId.get() === findLessonLayoutId();
    const remembered = guideReturnLayoutId.get();
    if (!remembered && !inLesson) return;
    returning = true;
    try {
      const fallback = inLesson ? fallbackReturnLayoutId() : undefined;
      const left =
        remembered === activeLayoutId.get() ||
        (remembered !== null && (await leaveLessonLayout(api, remembered))) ||
        (fallback !== undefined && (await leaveLessonLayout(api, fallback)));
      if (left) guideReturnLayoutId.set(null);
      else if (inLesson)
        pushToast("error", "Could not switch back to your layout.");
    } finally {
      returning = false;
    }
  };
  /** Leaves the Lesson layout and removes it whenever a lesson ends, whether finished, exited or replaced by the menu. */
  createEffect(
    on(
      lessonId,
      (id, previous) => {
        if (previous && !id) void returnToLayout().then(removeLessonLayout);
      },
      { defer: true },
    ),
  );
  const [workspace, setWorkspace] = createSignal<GuidePanelSnapshot>({
    panels: [],
  });
  /** While the guide is open, tracks open panels and whether each is unobstructed, across layout restores. */
  createEffect(() => {
    if (!opened()) return;
    onCleanup(trackGuidePanels(dockviewApi(), setWorkspace));
  });
  /** Lists panels the user can currently see; anything else gets an Open or Show button. */
  const visiblePanels = createMemo(() =>
    workspace().panels.filter((panel) => panel.onScreen),
  );
  /** Identifies a panel for prerequisite tracking, telling timeline editors apart. */
  const panelKeys = (panel: GuidePanel) => [
    panel.component,
    ...(panel.timelineUid
      ? [`timeline:${normalizeTimelineUid(panel.timelineUid)}`]
      : []),
  ];
  /** Keys the sample timeline's editor the same way panelKeys does, whichever uid form the store uses. */
  const sampleTimelineKey = createMemo(() => {
    const uid = sampleTimeline()?.identifiers.uid;
    return uid ? `timeline:${normalizeTimelineUid(uid)}` : undefined;
  });
  /** Lists active panels that something else currently covers, which keeps their prerequisite unmet. */
  const coveredPanels = createMemo(
    () =>
      new Set(
        workspace()
          .panels.filter((panel) => panel.visible && !panel.onScreen)
          .flatMap(panelKeys),
      ),
  );
  let heading: HTMLHeadingElement | undefined;
  /** Resolves lesson data without retaining stale content when returning to the library. */
  const lesson = createMemo(() =>
    lessons().find((entry) => entry.id === lessonId()),
  );
  /** Resolves the current instruction, leaving completion outside the action steps. */
  const step = createMemo(() => stepAt(index()));
  /** Returns a step of the current lesson, adapted for runtimes without disk storage. */
  function stepAt(position: number): GuideStep | undefined {
    const instruction = lesson()?.steps[position];
    return instruction && !hasDiskStorage(capabilities())
      ? { ...instruction, ...instruction.diskStorageUnavailable }
      : instruction;
  }
  const [visitedPanels, setVisitedPanels] = createSignal(new Set<string>());
  let visitedStep = "";
  /** Remembers prerequisite panels visited during this step, even when they share a tab group. */
  createEffect(() => {
    const key = `${lessonId()}:${step()?.id}`;
    const keys = workspace()
      .panels.filter((panel) => panel.visible)
      .flatMap(panelKeys);
    const reset = key !== visitedStep;
    visitedStep = key;
    setVisitedPanels(
      (previous) => new Set([...(reset ? [] : previous), ...keys]),
    );
  });
  /** Checks whether a prerequisite panel is visible and expanded. */
  const panelVisible = (name: PanelComponentName) =>
    visiblePanels().some((panel) => panel.component === name);
  /** Distinguishes the sample timeline from other open timeline editors. */
  const timelineVisible = () =>
    visiblePanels().some((panel) => {
      const key = sampleTimelineKey();
      return (
        panel.component === "Timeline" &&
        key !== undefined &&
        panelKeys(panel).includes(key)
      );
    });
  /** Accepts a panel shown during this step that nothing currently covers. */
  const panelReady = (key: string) =>
    visitedPanels().has(key) && !coveredPanels().has(key);
  /** Requires every panel in a prerequisite block before revealing subsequent content. */
  const prerequisiteReady = (item: GuidePrerequisite) =>
    (!item.sampleTimeline || panelReady(sampleTimelineKey() ?? "timeline:")) &&
    (item.panels ?? []).every(panelReady);
  /** Stops the rendered sequence at the first unmet prerequisite. */
  const content = createMemo(() =>
    visibleGuideContent(step()?.content ?? [], prerequisiteReady),
  );
  /** Suspends hidden action targets until all prerequisites for the step are met. */
  const blocked = createMemo(() =>
    content().some(
      (item) => item.type === "prerequisite" && !prerequisiteReady(item),
    ),
  );
  const [card, setCard] = createSignal<HTMLElement>();
  const [anchor, setAnchor] = createSignal<DOMRect | null>(null);
  let anchorStep: string | undefined;
  let anchorRelease: ReturnType<typeof setTimeout> | undefined;
  /**
   * Follows the step's target, but keeps the last anchor briefly when the target vanishes within
   * the same step, such as a list row covered by the editor it opens just before the step advances.
   * A new step lets go at once. Runs untracked, since GuideTarget reports from inside its own effect.
   */
  const followTarget = (bounds: DOMRect | null) =>
    untrack(() => {
      const stepId = step()?.id;
      clearTimeout(anchorRelease);
      anchorRelease = undefined;
      const sameStep = anchorStep === stepId;
      anchorStep = stepId;
      if (bounds || !sameStep || !anchor()) setAnchor(bounds);
      else anchorRelease = setTimeout(() => setAnchor(null), ANCHOR_GRACE_MS);
    });
  onCleanup(() => clearTimeout(anchorRelease));
  /**
   * Points at what reveals the first unmet prerequisite: the tab of an open panel that is
   * collapsed or behind another tab, or the sample timeline's card in the Timelines list.
   * Panels that are closed or merely covered have nothing to point at; their buttons handle them.
   */
  const prerequisiteSelector = createMemo(() => {
    const item = content().find(
      (entry): entry is GuidePrerequisite =>
        entry.type === "prerequisite" && !prerequisiteReady(entry),
    );
    if (!item) return undefined;
    const timeline = sampleTimeline();
    const timelineKey = sampleTimelineKey() ?? "timeline:";
    const pending =
      item.sampleTimeline && !panelReady(timelineKey)
        ? workspace().panels.find((panel) =>
            panelKeys(panel).includes(timelineKey),
          )
        : workspace().panels.find(
            (panel) =>
              item.panels?.includes(panel.component as PanelComponentName) &&
              !panelReady(panel.component),
          );
    if (pending && !pending.visible)
      return `[data-workspace-active="true"] .dv-tab[data-tab-panel-id="${CSS.escape(pending.id)}"]`;
    if (item.sampleTimeline && !pending && timeline) {
      const uid = CSS.escape(normalizeTimelineUid(timeline.identifiers.uid));
      return `[data-workspace-active="true"] [data-panel-kind="timeline-list"] [data-crud-select-id="${uid}"]`;
    }
    return undefined;
  });
  const guideSnapshot = useGuideSnapshot(workspace);
  /**
   * Finds the part of a multi-part step the user is on, starting from `from`: the first part whose
   * `until` doesn't hold yet, or the last part.
   */
  const activePart = (parts: readonly GuideStepPart[], from: number) => {
    let index = from;
    while (index < parts.length - 1) {
      const until = parts[index].until;
      if (!until || !guideCompletionToken(until, guideSnapshot())) break;
      index += 1;
    }
    return index;
  };
  /** Furthest part of the current step the user has reached; finished parts stay finished. */
  const [reachedPart, setReachedPart] = createSignal(0);
  /** Starts every step, including one revisited with Back, at its first part. */
  createEffect(on(step, () => setReachedPart(0)));
  /** Moves the current step's highlight on to the next part once its `until` holds. */
  createEffect(() => {
    const parts = step()?.parts;
    if (parts?.length) setReachedPart(activePart(parts, untrack(reachedPart)));
  });
  /**
   * Resolves a step's authored object identities to clip tiles, inspect buttons, sequence cards,
   * or Trigger cells, the reached part of a multi-part step, or else its plain target selector.
   */
  const selectorFor = (
    instruction: GuideStep | undefined,
    part = 0,
  ): string | undefined => {
    const parts = instruction?.parts;
    if (parts?.length) return parts[Math.min(part, parts.length - 1)].target;
    if (instruction?.targetSampleTimeline) {
      const timeline = sampleTimeline();
      if (!timeline) return undefined;
      return `[data-workspace-active="true"] [data-panel-kind="timeline-list"] [data-crud-select-id="${CSS.escape(normalizeTimelineUid(timeline.identifiers.uid))}"]`;
    }
    const actionTarget = instruction?.targetTimelineAction;
    if (actionTarget) {
      const timeline = sampleTimeline();
      if (!timeline) return undefined;
      const uid = CSS.escape(normalizeTimelineUid(timeline.identifiers.uid));
      return `[data-timeline-surface="true"][data-timeline-uid="${uid}"] [data-timeline-action="true"][data-track-id="${CSS.escape(actionTarget.trackId)}"][data-action-id="${CSS.escape(actionTarget.actionId)}"]:not([data-drag-preview]) [data-timeline-action-chip="true"]`;
    }
    const fxTarget = instruction?.targetFx;
    if (fxTarget) {
      const effect = Object.values(fxMap()).find(
        (entry) => entry.identifiers.id === fxTarget.id,
      );
      if (!effect) return undefined;
      const uid = CSS.escape(effect.identifiers.uid);
      return `[data-crud-select-id="${uid}"], [data-grid-row-key="${uid}"][data-grid-column-key="label"]`;
    }
    const fixtureTarget = instruction?.targetPatchFixture;
    if (fixtureTarget) {
      const fixture = Object.values(fixtureMap()).find(
        (entry) => entry.identifiers.id === fixtureTarget.id,
      );
      if (!fixture) return undefined;
      const uid = CSS.escape(fixture.identifiers.uid);
      return `[data-panel-kind="patch"] [role="tablist"][aria-label="Patch views"] [role="tab"][id$="-fixtures"][aria-selected="false"], [data-panel-kind="patch"] [data-grid-row-key="${uid}"][data-grid-column-key="${CSS.escape(fixtureTarget.column ?? "id")}"]`;
    }
    const clipTarget = instruction?.targetClip;
    if (clipTarget) {
      const clip = Object.values(clipMap()).find(
        ([entry]) => entry.identifiers.id === clipTarget.id,
      )?.[0];
      if (!clip) return undefined;
      return clipTarget.gear
        ? `[aria-label="Inspect clip ${clipTarget.id}"]`
        : `[data-crud-select-id="${clip.identifiers.uid}"]`;
    }
    const target = instruction?.targetSequence;
    if (!target) return instruction?.target;
    const sequence = Object.values(sequenceMap()).find(
      (entry) => entry.identifiers.id === target.id,
    );
    if (!sequence) return undefined;
    if (target.cueId === undefined)
      return `[data-crud-select-id="${sequence.identifiers.uid}"]`;
    const cue = sequence.steps
      .map((uid) => cueMap()[uid])
      .find((entry) => entry?.identifiers.id === target.cueId);
    return cue
      ? `[data-grid-column-key="trigger"][data-grid-row-key="${cue.identifiers.uid}:cue"]`
      : undefined;
  };
  /** Resolves the current step's action target. */
  const actionSelector = createMemo(() => selectorFor(step(), reachedPart()));
  const patchView = useStore(patchPanelActiveTab);
  /**
   * Names the Patch fixture the current step points at while Patch shows its Fixtures view, so a
   * reveal is requested again whenever that view comes back into sight.
   */
  const shownPatchFixture = createMemo(() => {
    const id = step()?.targetPatchFixture?.id;
    return id !== undefined &&
      patchView() === "fixtures" &&
      panelVisible("PatchEditor")
      ? `${lessonId()}:${index()}:${id}`
      : undefined;
  });
  /**
   * Scrolls Patch to the step's fixture cell, since its list only renders rows near the viewport.
   * Waits a frame and skips cells already rendered, so a reveal the wizard just made, which also
   * selects the new fixtures, isn't replaced.
   */
  createEffect(
    on(shownPatchFixture, (key) => {
      const target = step()?.targetPatchFixture;
      const selector = actionSelector();
      if (!key || !target || !selector) return;
      /** Reports a matching cell shown inside its Patch panel, not hidden or scrolled out. */
      const cellShown = () =>
        [...document.querySelectorAll<HTMLElement>(selector)].some((cell) => {
          const panel = cell.closest('[data-panel-kind="patch"]');
          if (!panel || !cell.checkVisibility()) return false;
          const box = cell.getBoundingClientRect();
          const bounds = panel.getBoundingClientRect();
          return (
            box.top >= bounds.top &&
            box.bottom <= bounds.bottom &&
            box.left >= bounds.left &&
            box.right <= bounds.right
          );
        });
      const frame = requestAnimationFrame(() => {
        if (!cellShown())
          revealPatchFixtures([target.id], {
            select: false,
            column: target.column,
          });
      });
      onCleanup(() => cancelAnimationFrame(frame));
    }),
  );
  /**
   * Names the fixtures the current step selects in Patch while its Fixtures view shows, so they
   * are selected again whenever that view comes back into sight.
   */
  const shownPatchSelection = createMemo(() =>
    step()?.selectPatchFixtures?.length &&
    patchView() === "fixtures" &&
    panelVisible("PatchEditor")
      ? `${lessonId()}:${index()}`
      : undefined,
  );
  /** Selects and scrolls to the step's fixtures in Patch once the Fixtures view has mounted. */
  createEffect(
    on(shownPatchSelection, (key) => {
      const ids = step()?.selectPatchFixtures;
      if (!key || !ids) return;
      const frame = requestAnimationFrame(() => revealPatchFixtures(ids));
      onCleanup(() => cancelAnimationFrame(frame));
    }),
  );
  /** Aims the card at the step's action, or at what reveals a missing panel while prerequisites are unmet. */
  const targetSelector = createMemo(() =>
    blocked() ? prerequisiteSelector() : actionSelector(),
  );
  const floating = useFloatingGuide(
    () => (lesson() && opened() ? card() : undefined),
    () => `${lessonId()}:${index()}`,
    anchor,
    targetSelector,
    () => step()?.placement,
    () => step()?.keepVisible,
  );
  /**
   * Reveals a launching lesson's card once it sits beside the first step's target, so it appears
   * in place instead of sliding there. The placement must hold for two frames, since the card's
   * first placement can precede the resize from swapping the library for the lesson content.
   */
  createEffect(() => {
    if (!revealPending() || startingLesson()) return;
    if (!opened() || !lesson()) {
      setRevealPending(false);
      return;
    }
    const placed = floating.placed();
    const target = anchor();
    floating.position();
    if (
      placed?.step !== `${lessonId()}:${index()}` ||
      placed.anchor !== target ||
      (!target && targetSelector())
    )
      return;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => setRevealPending(false));
    });
    onCleanup(() => cancelAnimationFrame(frame));
  });
  /** Stops waiting for a first target that never appears, so the card cannot stay hidden. */
  createEffect(() => {
    if (!revealPending() || startingLesson()) return;
    const timer = setTimeout(() => setRevealPending(false), REVEAL_TIMEOUT_MS);
    onCleanup(() => clearTimeout(timer));
  });
  const { draggable } = createDraggable();
  void draggable;
  /** Copies the current lesson command exactly, without submitting it to the app. */
  const copyCommand = async (command: string) => {
    if (!navigator.clipboard?.writeText) {
      pushToast("error", "Clipboard access unavailable");
      return;
    }
    try {
      await navigator.clipboard.writeText(command);
      pushToast("success", "Copied command");
    } catch (error) {
      log.error("Failed to copy guide command", error);
      pushToast("error", "Could not copy command");
    }
  };
  /** Locates the drag source by sample clip identity in either card or list view. */
  const clipHighlightSelector = createMemo(() => {
    const id = step()?.highlightClipId;
    if (id === undefined) return undefined;
    const clip = Object.values(clipMap()).find(
      ([entry]) => entry.identifiers.id === id,
    )?.[0];
    if (!clip) return undefined;
    const uid = CSS.escape(clip.identifiers.uid);
    return `[data-crud-select-id="${uid}"], [data-grid-row-key="${uid}"][data-grid-column-key="label"]`;
  });

  useUiAction({
    id: "welcome-guide",
    name: "Open Welcome Guide",
    description: "Learn Nightfall with guided lessons",
    category: "Help",
    execute: openWelcomeGuide,
  });

  /** Lists every panel the current step asks for, so making room never hides one of them. */
  const requiredPanels = createMemo(() =>
    (step()?.content ?? []).flatMap((item) =>
      item.type === "prerequisite" ? (item.panels ?? []) : [],
    ),
  );
  /**
   * Places a panel the step asks for as a tab beside the panel its prerequisite names, when that
   * panel is open; otherwise the palette's placement applies.
   */
  const openTarget = (
    key: PanelComponentName | "sampleTimeline",
  ): PanelOpenTarget => {
    const beside = (step()?.content ?? [])
      .map((item) =>
        item.type === "prerequisite" ? item.openBeside?.[key] : undefined,
      )
      .find((name) => name !== undefined);
    const reference =
      beside ?? (key === "sampleTimeline" ? "TimelinesPanel" : undefined);
    return reference
      ? { besidePanel: panelDefinitionByName(reference).panelId }
      : "default";
  };
  /**
   * Opens panels through the same placement and expansion policy as the palette,
   * then collapses edge panels that still cover it and aren't needed by this step.
   */
  const openPanel = (name: PanelComponentName) => {
    const api = dockviewApi();
    openOrFocusPanelDefinition(
      api,
      panelDefinitionByName(name),
      openTarget(name),
    );
    requestAnimationFrame(() => {
      const panel = api?.panels.find((entry) => entry.api.component === name);
      if (api && panel)
        collapseCoveringEdgeGroups(
          api,
          panel.view.content.element,
          requiredPanels(),
        );
    });
  };
  /** Reports whether a panel is open and active in Dockview, even if something covers it. */
  const panelOpen = (name: PanelComponentName) =>
    workspace().panels.some(
      (panel) => panel.component === name && panel.visible,
    );

  /** Opens the sample editor using the same identity and parameters as the timeline list. */
  const openSampleTimeline = () => {
    const api = dockviewApi();
    const timeline = sampleTimeline();
    if (!api || !timeline) return;
    const uid = normalizeTimelineUid(timeline.identifiers.uid);
    openOrFocusPanel(
      api,
      `panel-Timeline-${uid}`,
      "Timeline",
      `Timeline ${timeline.identifiers.id}`,
      openTarget("sampleTimeline"),
      { initialTimelineUid: uid },
    );
  };

  /** Closes what a step left open when the user moves on, exactly as its Close button would. */
  const advance = () => {
    for (const action of step()?.onAdvance ?? []) {
      if (action.surface === "settings") closeSettings();
      else hideShortcutsPopup();
    }
    moveTo(index() + 1);
  };

  /** The step the user last went Back to, whose already-met condition must not advance it again. */
  const [returnedTo, setReturnedTo] = createSignal<number>();
  /** Whether the user reached the current step by going Back rather than forward. */
  const revisited = () => returnedTo() === index();

  /**
   * Changes instructional position and returns focus to its heading for keyboard users.
   * Moving back remembers the step, so its condition only counts once the user acts again.
   */
  const moveTo = (position: number) => {
    setReturnedTo(position < index() ? position : undefined);
    guideStepIndex.set(position);
    heading?.focus();
  };

  /** Detects any clip, effect preview, or timeline still running after a lesson. */
  const playbackRunning = createMemo(() =>
    isPlaybackRunning(instanceMap(), clockMap()),
  );
  /** Detects a selection or live values left in the Programmer after a lesson. */
  const programmerHeld = createMemo(
    () => programmerSelectionList().length > 0 || programmerRows().length > 0,
  );

  /** Records lesson completion only when the user explicitly finishes the lesson; ending it restores their own layout. */
  const finish = () => {
    const id = lessonId();
    if (id && !completed().includes(id))
      guideCompleted.set([...completed(), id]);
    guideLessonId.set(null);
  };
  /** Ends any running lesson and hides the guide; reopening it always shows the lesson menu. */
  const exit = () => {
    guideLessonId.set(null);
    closeWelcomeGuide();
  };

  /** Observes the current step from its start, so actions finished while prerequisites settle still count. */
  const observation = createMemo(() =>
    opened() ? step()?.observe : undefined,
  );
  /**
   * Holds advancement while the step's action is still hidden behind prerequisites,
   * except for observations that the prerequisite panels themselves satisfy.
   */
  const held = createMemo(() => {
    const target = observation();
    return (
      blocked() &&
      target?.type !== "panel" &&
      target?.type !== "sequence-editor" &&
      target?.type !== "sample-panels"
    );
  });
  /**
   * Moves to the next step. When this step opened a panel, waits until the next step's target
   * has mounted and stopped moving, so the card and highlight don't chase the panel's content
   * while it lays out. Skips the move if the user navigated or left the lesson meanwhile.
   */
  const advanceStep = () => {
    const from = guideStepIndex.get();
    const lessonAtAdvance = guideLessonId.get();
    const type = observation()?.type;
    const nextTarget = selectorFor(stepAt(from + 1));
    const opensPanel =
      type === "panel" ||
      type === "sequence-editor" ||
      type === "sample-panels";
    if (!opensPanel || !nextTarget) {
      guideStepIndex.set(from + 1);
      return;
    }
    void whenTargetSettles(nextTarget, PANEL_SETTLE_TIMEOUT_MS).then(() => {
      if (
        guideStepIndex.get() === from &&
        guideLessonId.get() === lessonAtAdvance
      )
        guideStepIndex.set(from + 1);
    });
  };
  useGuideProgress(observation, held, revisited, guideSnapshot, advanceStep);

  /** Floats the card over the app during lessons and while a lesson launches. */
  const floatingCard = () => Boolean(lesson()) || revealPending();
  const [cardHost, setCardHost] = createSignal<HTMLElement>(overlayHost());
  /**
   * Moves the floating card into the frontmost modal dialog while one is open, since a modal
   * dialog's top layer would otherwise cover it and make it inert.
   */
  createEffect(() => {
    if (!opened() || !floatingCard()) return;
    /** Moves the card into the frontmost open dialog, or back to the page once none is open. */
    const update = () => {
      const next = overlayHost();
      if (next !== untrack(cardHost)) setCardHost(next);
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.body, {
      subtree: true,
      attributes: true,
      attributeFilter: ["open"],
    });
    onCleanup(() => observer.disconnect());
  });
  /** The card itself, docked beside the app for the lesson library and floating during lessons. */
  const cardView = () => (
    <aside
      ref={setCard}
      class="nf-welcome-guide"
      classList={{
        "nf-guide-floating": Boolean(lesson()) || revealPending(),
        "nf-guide-revealing": revealPending(),
      }}
      use:draggable={{
        disabled: !lesson(),
        handle: ".nf-guide-move",
        position: lesson() ? floating.position() : { x: 0, y: 0 },
        bounds: { left: 12, right: 12, top: 12, bottom: 12 },
        onDrag: ({ offsetX, offsetY }) =>
          floating.move({ x: offsetX, y: offsetY }),
      }}
      aria-label="Welcome guide"
      data-testid="welcome-guide"
    >
      <Show when={lesson() && floating.pointer()}>
        {(pointer) => (
          <span
            aria-hidden="true"
            class="nf-guide-pointer"
            data-side={pointer().side}
            style={pointer().style}
          />
        )}
      </Show>
      <header class="nf-guide-header">
        <div class="nf-guide-title">
          <Show when={lesson()} fallback={<span>LEARN NIGHTFALL</span>}>
            <button
              type="button"
              class="nf-guide-move"
              aria-label="Move guide"
              title="Drag to move, or use arrow keys when focused"
              onKeyDown={floating.onKeyDown}
            >
              ⠿ LEARN NIGHTFALL ·{" "}
              <span class="nf-guide-current-lesson">{lesson()?.title}</span>
            </button>
          </Show>
        </div>
        <div class="nf-guide-header-actions">
          <Button size="compact" onClick={exit} aria-label="Exit welcome guide">
            Exit
          </Button>
        </div>
        <Show when={lesson()}>
          <div
            class="nf-guide-header-progress"
            role="progressbar"
            aria-label="Lesson progress"
            aria-valuemin={0}
            aria-valuemax={lesson()!.steps.length}
            aria-valuenow={Math.min(index(), lesson()!.steps.length)}
          >
            <span
              style={{
                width: `${Math.min(index() / lesson()!.steps.length, 1) * 100}%`,
              }}
            />
          </div>
        </Show>
      </header>
      <div class="nf-guide-body">
        <Show
          when={lesson()}
          fallback={
            <>
              <h2>Start with the orientation</h2>
              <p>
                Module 1 shows you around the workspace. Module 2 walks you
                through making your first lights. Then choose what to learn
                next. You can leave at any time and return using Guide.
              </p>
              <p
                class="nf-guide-note"
                data-testid="guide-layout-notice"
                role="status"
              >
                {startingLesson()
                  ? `Switching to the ${LESSON_LAYOUT_NAME} layout…`
                  : `Lessons open in a separate ${LESSON_LAYOUT_NAME} layout with the default panels, so your own layout stays as it is. Finishing a lesson brings your layout back.`}
              </p>
              <For each={lessons()}>
                {(entry) => (
                  <button
                    class="nf-guide-lesson"
                    type="button"
                    disabled={startingLesson()}
                    onClick={() => void startLesson(entry.id)}
                  >
                    <span class="nf-guide-lesson-meta">
                      {entry.label ?? "Follow-on lesson"} · {entry.duration}
                    </span>
                    <strong>{entry.title}</strong>
                    <span>{entry.introduction}</span>
                    <Show when={completed().includes(entry.id)}>
                      <span class="nf-guide-success">
                        Completed · Take again
                      </span>
                    </Show>
                  </button>
                )}
              </For>
            </>
          }
        >
          {(current) => (
            <>
              <h2 ref={heading} tabIndex={-1} aria-live="polite">
                {step()?.title ?? "Ready to explore"}
              </h2>
              <Show when={step()}>
                {(instruction) => (
                  <>
                    <For each={content()}>
                      {(item) => (
                        <GuideContentItem
                          item={item}
                          panelVisible={panelVisible}
                          panelOpen={panelOpen}
                          timelineVisible={timelineVisible}
                          canOpenPanels={Boolean(dockviewApi())}
                          canOpenTimeline={Boolean(
                            dockviewApi() && sampleTimeline(),
                          )}
                          openPanel={openPanel}
                          openTimeline={openSampleTimeline}
                          copyCommand={copyCommand}
                          playbackRunning={playbackRunning()}
                        />
                      )}
                    </For>
                    <GuideTarget
                      stepId={instruction().id}
                      selector={targetSelector()}
                      focusTarget={
                        !revealPending() &&
                        !blocked() &&
                        (instruction().focusTarget ??
                          instruction().target === COMMAND_INPUT)
                      }
                      holdHighlight={revealPending()}
                      onBounds={followTarget}
                    />
                    <GuideTarget
                      stepId={instruction().id}
                      selector={blocked() ? undefined : clipHighlightSelector()}
                      holdHighlight={revealPending()}
                    />
                    <Show when={!blocked() && !instruction().observe}>
                      <p class="nf-guide-note">
                        Take time to explore, then continue when you’re ready.
                      </p>
                    </Show>
                    <div class="nf-guide-navigation">
                      <Button
                        size="compact"
                        disabled={index() === 0}
                        onClick={() => moveTo(index() - 1)}
                      >
                        Back
                      </Button>
                      <span
                        class="nf-guide-step-count"
                        role="status"
                        aria-label="Current step"
                      >
                        {`${Math.min(index() + 1, current().steps.length)}/${current().steps.length}`}
                      </span>
                      <Show
                        when={instruction().observe}
                        fallback={
                          <Button
                            size="compact"
                            variant="primary"
                            onClick={advance}
                          >
                            Continue
                          </Button>
                        }
                      >
                        <Button
                          size="compact"
                          onClick={advance}
                          title="Move on without completing this step"
                        >
                          Skip
                        </Button>
                      </Show>
                    </div>
                  </>
                )}
              </Show>
              <Show when={index() >= current().steps.length}>
                <p>You’ve reached the end of this lesson.</p>
                <Show when={playbackRunning() || programmerHeld()}>
                  <div class="nf-guide-action">
                    <p>
                      {playbackRunning() && programmerHeld()
                        ? "Playback is still running and the Programmer still holds values."
                        : playbackRunning()
                          ? "Playback is still running."
                          : "The Programmer still holds values."}{" "}
                      Reset before starting another lesson so it doesn’t affect
                      what you see.
                    </p>
                    <div class="nf-guide-shortcuts">
                      <Show when={playbackRunning()}>
                        <Button size="compact" onClick={stopAllPlayback}>
                          Stop all playback
                        </Button>
                      </Show>
                      <Show when={programmerHeld()}>
                        <Button
                          size="compact"
                          onClick={clearProgrammerCompletely}
                        >
                          Clear programmer
                        </Button>
                      </Show>
                    </div>
                  </div>
                </Show>
                <Show
                  when={
                    !current().leavesShowUnchanged &&
                    hasDiskStorage(capabilities())
                  }
                >
                  <p>
                    Save your practice show if you want to keep these changes.
                  </p>
                </Show>
                <div class="nf-guide-navigation">
                  <Button size="compact" onClick={() => moveTo(index() - 1)}>
                    Back
                  </Button>
                  <Button variant="primary" size="compact" onClick={finish}>
                    Finish lesson
                  </Button>
                </div>
              </Show>
            </>
          )}
        </Show>
      </div>
    </aside>
  );

  return (
    <Show when={opened()}>
      <Show when={floatingCard()} fallback={cardView()}>
        <Show when={cardHost()} keyed>
          {(mount) => <Portal mount={mount}>{cardView()}</Portal>}
        </Show>
      </Show>
    </Show>
  );
}
