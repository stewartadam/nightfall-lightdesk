// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { createDraggable } from "@neodrag/solid";
import { CheckCircleIcon } from "@squidlab/phosphor-solid/check-circle";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  Show,
} from "solid-js";
import { useAppShell } from "../../components/providers/app-shell";
import { useCommand } from "../../components/providers/command-registry";
import { Button } from "../../components/ui/visual-language/button";
import { getLogger } from "../../lib/logger";
import {
  type PanelComponentName,
  panelDefinitionByName,
} from "../../lib/panel-definitions";
import { openOrFocusPanelDefinition } from "../../lib/panel-open-command";
import { isEmbeddedDemoRuntime } from "../../lib/runtime-config";
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
import { normalizeTimelineUid } from "../timeline";
import {
  clearProgrammerCompletely,
  isPlaybackRunning,
  stopAllPlayback,
} from "./cleanup";
import { visibleGuideContent } from "./content";
import { GuideContentItem } from "./guide-content";
import { GuideTarget } from "./guide-target";
import { guideLessons } from "./lesson-store";
import type { GuidePrerequisite } from "./lessons";
import {
  closeWelcomeGuide,
  guideCompleted,
  guideDismissed,
  guideLessonId,
  guideOpen,
  guideStepIndex,
  openWelcomeGuide,
  startGuideLesson,
} from "./state";
import { useFloatingGuide } from "./use-floating-guide";
import { useGuideProgress } from "./use-guide-progress";
import "./welcome-guide.css";

const log = getLogger(import.meta.url);

/** How long a detected step shows its checkmark before the next instruction appears. */
const STEP_COMPLETION_DELAY_MS = 700;

/** Offers an unobtrusive first-visit invitation in the browser demo only. */
export function GuideInvitation() {
  const dismissed = useStore(guideDismissed);
  const opened = useStore(guideOpen);
  return (
    <Show when={isEmbeddedDemoRuntime() && !dismissed() && !opened()}>
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
  const { dockviewApi } = useAppShell();
  const [visiblePanels, setVisiblePanels] = createSignal<
    { component: string; timelineUid?: string }[]
  >([]);
  /** Tracks usable panels as tabs activate, groups expand, and the workspace layout changes. */
  createEffect(() => {
    const api = dockviewApi();
    /** Excludes inactive tabs and collapsed groups from the guide's ready panels. */
    const update = () =>
      setVisiblePanels(
        api?.panels
          .filter((panel) => {
            return panel.api.isVisible && !panel.group.api.isCollapsed();
          })
          .map((panel) => ({
            component: panel.api.component,
            timelineUid: panel.params?.initialTimelineUid,
          })) ?? [],
      );
    update();
    const subscriptions = [
      api?.onDidLayoutChange(update),
      api?.onDidActivePanelChange(update),
      api?.onDidAddPanel(update),
      api?.onDidRemovePanel(update),
      api?.onDidTabGroupCollapsedChange(update),
      ...(["left", "right", "top", "bottom"] as const).map((position) =>
        api?.getEdgeGroup(position)?.onDidCollapsedChange(update),
      ),
    ];
    onCleanup(() => {
      for (const subscription of subscriptions) subscription?.dispose();
    });
  });
  let heading: HTMLHeadingElement | undefined;
  /** Resolves lesson data without retaining stale content when returning to the library. */
  const lesson = createMemo(() =>
    lessons().find((entry) => entry.id === lessonId()),
  );
  /** Resolves the current instruction, leaving completion outside the action steps. */
  const step = createMemo(() => {
    const instruction = lesson()?.steps[index()];
    return instruction && capabilities()?.persistence === "Unavailable"
      ? { ...instruction, ...instruction.persistenceUnavailable }
      : instruction;
  });
  const [visitedPanels, setVisitedPanels] = createSignal(new Set<string>());
  let visitedStep = "";
  /** Remembers prerequisite panels visited during this step, even when they share a tab group. */
  createEffect(() => {
    const key = `${lessonId()}:${step()?.id}`;
    const visible = visiblePanels();
    const keys = visible.flatMap((panel) => [
      panel.component,
      ...(panel.timelineUid ? [`timeline:${panel.timelineUid}`] : []),
    ]);
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
    visiblePanels().some(
      (panel) =>
        panel.component === "Timeline" &&
        panel.timelineUid === sampleTimeline()?.identifiers.uid,
    );
  /** Requires every panel in a prerequisite block before revealing subsequent content. */
  const prerequisiteReady = (item: GuidePrerequisite) =>
    (!item.sampleTimeline ||
      visitedPanels().has(`timeline:${sampleTimeline()?.identifiers.uid}`)) &&
    (item.panels ?? []).every((name) => visitedPanels().has(name));
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
  /** Resolves authored object identities to clip tiles, inspect buttons, sequence cards, or Trigger cells. */
  const targetSelector = createMemo(() => {
    const actionTarget = step()?.targetTimelineAction;
    if (actionTarget) {
      const timeline = sampleTimeline();
      if (!timeline) return undefined;
      const uid = CSS.escape(normalizeTimelineUid(timeline.identifiers.uid));
      return `[data-timeline-surface="true"][data-timeline-uid="${uid}"] [data-timeline-action="true"][data-track-id="${CSS.escape(actionTarget.trackId)}"][data-action-id="${CSS.escape(actionTarget.actionId)}"]:not([data-drag-preview]) [data-timeline-action-chip="true"]`;
    }
    const fxTarget = step()?.targetFx;
    if (fxTarget) {
      const effect = Object.values(fxMap()).find(
        (entry) => entry.identifiers.id === fxTarget.id,
      );
      if (!effect) return undefined;
      const uid = CSS.escape(effect.identifiers.uid);
      return `[data-crud-select-id="${uid}"], [data-grid-row-key="${uid}"][data-grid-column-key="label"]`;
    }
    const fixtureTarget = step()?.targetPatchFixture;
    if (fixtureTarget) {
      const fixture = Object.values(fixtureMap()).find(
        (entry) => entry.identifiers.id === fixtureTarget.id,
      );
      if (!fixture) return undefined;
      const uid = CSS.escape(fixture.identifiers.uid);
      return `[data-panel-kind="patch"] [role="tablist"][aria-label="Patch views"] [role="tab"][id$="-fixtures"][aria-selected="false"], [data-panel-kind="patch"] [data-grid-row-key="${uid}"][data-grid-column-key="id"]`;
    }
    const clipTarget = step()?.targetClip;
    if (clipTarget) {
      const clip = Object.values(clipMap()).find(
        ([entry]) => entry.identifiers.id === clipTarget.id,
      )?.[0];
      if (!clip) return undefined;
      return clipTarget.gear
        ? `[aria-label="Inspect clip ${clipTarget.id}"]`
        : `[data-crud-select-id="${clip.identifiers.uid}"]`;
    }
    const target = step()?.targetSequence;
    if (!target) return step()?.target;
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
  });
  const floating = useFloatingGuide(
    () => (lesson() && opened() ? card() : undefined),
    () => `${lessonId()}:${index()}`,
    anchor,
    targetSelector,
    () => step()?.placement,
  );
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

  useCommand({
    id: "welcome-guide",
    name: "Open Welcome Guide",
    description: "Learn Nightfall with guided lessons",
    category: "Help",
    execute: openWelcomeGuide,
  });

  /** Opens panels through the same placement and expansion policy as the palette. */
  const openPanel = (name: PanelComponentName) => {
    openOrFocusPanelDefinition(dockviewApi(), panelDefinitionByName(name));
  };

  /** Opens the sample editor using the same identity and parameters as the timeline list. */
  const openSampleTimeline = () => {
    const api = dockviewApi();
    const timeline = sampleTimeline();
    if (!api || !timeline) return;
    const uid = normalizeTimelineUid(timeline.identifiers.uid);
    const id = `panel-Timeline-${uid}`;
    const existing = api.getPanel(id);
    if (existing) {
      if (existing.api.location.type === "edge")
        api.getEdgeGroup(existing.api.location.position)?.expand();
      existing.focus();
      return;
    }
    api.addPanel({
      id,
      component: "Timeline",
      title: "Timeline 1",
      params: { initialTimelineUid: uid },
    });
  };

  const [completing, setCompleting] = createSignal(false);
  let completionTimer: ReturnType<typeof setTimeout> | undefined;
  /** Cancels a pending automatic advance so manual navigation always wins. */
  const cancelCompletion = () => {
    clearTimeout(completionTimer);
    completionTimer = undefined;
    setCompleting(false);
  };
  onCleanup(cancelCompletion);
  /** Drops a pending checkmark when the guide closes or the user switches lesson or step. */
  createEffect(
    on([opened, lessonId, index], cancelCompletion, { defer: true }),
  );

  /** Changes instructional position and returns focus to its heading for keyboard users. */
  const moveTo = (position: number) => {
    cancelCompletion();
    guideStepIndex.set(position);
    heading?.focus();
  };

  /** Shows a checkmark on the finished instruction briefly before revealing the next one. */
  const completeStep = () => {
    if (completionTimer !== undefined) return;
    setCompleting(true);
    // Advance without moving focus, so typing in the command input is not interrupted.
    completionTimer = setTimeout(() => {
      completionTimer = undefined;
      setCompleting(false);
      guideStepIndex.set(guideStepIndex.get() + 1);
    }, STEP_COMPLETION_DELAY_MS);
  };

  /** Detects any clip, effect preview, or timeline still running after a lesson. */
  const playbackRunning = createMemo(() =>
    isPlaybackRunning(instanceMap(), clockMap()),
  );
  /** Detects a selection or live values left in the Programmer after a lesson. */
  const programmerHeld = createMemo(
    () => programmerSelectionList().length > 0 || programmerRows().length > 0,
  );

  /** Records lesson completion only when the user explicitly finishes the lesson. */
  const finish = () => {
    const id = lessonId();
    if (id && !completed().includes(id))
      guideCompleted.set([...completed(), id]);
    guideLessonId.set(null);
  };

  /** Keeps prerequisite-opening observations active while suppressing actions not yet revealed. */
  const observation = createMemo(() => {
    const target = step()?.observe;
    if (!opened()) return undefined;
    if (
      blocked() &&
      target?.type !== "panel" &&
      target?.type !== "sequence-editor" &&
      target?.type !== "sample-panels"
    )
      return undefined;
    return target;
  });
  useGuideProgress(observation, dockviewApi, completeStep);

  return (
    <Show when={opened()}>
      <aside
        ref={setCard}
        class="nf-welcome-guide"
        classList={{
          "nf-guide-floating": Boolean(lesson()),
          "nf-guide-completing": completing(),
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
            <Button
              size="compact"
              onClick={closeWelcomeGuide}
              aria-label="Exit welcome guide"
            >
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
                <For each={lessons()}>
                  {(entry) => (
                    <button
                      class="nf-guide-lesson"
                      type="button"
                      onClick={() => startGuideLesson(entry.id)}
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
                <div class="nf-guide-step-heading">
                  <Show when={completing()}>
                    <CheckCircleIcon
                      class="nf-guide-step-done size-5"
                      weight="fill"
                      aria-hidden
                    />
                  </Show>
                  <h2 ref={heading} tabIndex={-1} aria-live="polite">
                    {completing() ? (
                      <span class="sr-only">Step complete: </span>
                    ) : null}
                    {step()?.title ?? "Ready to explore"}
                  </h2>
                </div>
                <Show when={step()}>
                  {(instruction) => (
                    <>
                      <For each={content()}>
                        {(item) => (
                          <GuideContentItem
                            item={item}
                            panelVisible={panelVisible}
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
                        highlight={!blocked()}
                        focusTarget={!blocked() && instruction().focusTarget}
                        onBounds={setAnchor}
                      />
                      <GuideTarget
                        stepId={instruction().id}
                        selector={
                          blocked() ? undefined : clipHighlightSelector()
                        }
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
                              onClick={() => moveTo(index() + 1)}
                            >
                              Continue
                            </Button>
                          }
                        >
                          <Button
                            size="compact"
                            disabled={completing()}
                            onClick={() => moveTo(index() + 1)}
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
                        Reset before starting another lesson so it doesn’t
                        affect what you see.
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
                    when={capabilities()?.persistence === "Unavailable"}
                    fallback={
                      <p>
                        Save your practice show if you want to keep these
                        changes.
                      </p>
                    }
                  >
                    <p>
                      Demo changes last only for this session. Reset demo
                      restores the sample show; it does not erase your lesson
                      completion badges.
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
    </Show>
  );
}
