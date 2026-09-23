// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { createDraggable } from "@neodrag/solid";
import { ArrowLeftIcon } from "@squidlab/phosphor-solid/arrow-left";
import { createMemo, createSignal, For, Show } from "solid-js";
import { useAppShell } from "../../components/providers/app-shell";
import { useCommand } from "../../components/providers/command-registry";
import Tooltip from "../../components/ui/tooltip";
import { Button } from "../../components/ui/visual-language/button";
import {
  type PanelComponentName,
  panelDefinitionByName,
} from "../../lib/panel-definitions";
import { openOrFocusPanelDefinition } from "../../lib/panel-open-command";
import { isEmbeddedDemoRuntime } from "../../lib/runtime-config";
import { clips, runtimeCapabilities, timelines } from "../../state/appStores";
import { normalizeTimelineUid } from "../timeline/model/timeline-list-model";
import { GuideTarget } from "./guide-target";
import { GUIDE_LESSONS } from "./lessons";
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

/** Offers an unobtrusive first-visit invitation in the browser demo only. */
export function GuideInvitation() {
  const dismissed = useStore(guideDismissed);
  const opened = useStore(guideOpen);
  return (
    <Show when={isEmbeddedDemoRuntime() && !dismissed() && !opened()}>
      <aside class="nf-guide-invitation" aria-label="Welcome to Nightfall">
        <div>
          <strong>New to Nightfall?</strong>
          <p>Make your first lights with a guided tour.</p>
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
  const opened = useStore(guideOpen);
  const lessonId = useStore(guideLessonId);
  const index = useStore(guideStepIndex);
  const completed = useStore(guideCompleted);
  const capabilities = useStore(runtimeCapabilities);
  const timelineMap = useStore(timelines);
  const clipMap = useStore(clips);
  /** Finds the generated sample timeline without relying on its session-specific UID. */
  const sampleTimeline = createMemo(() =>
    Object.values(timelineMap()).find((entry) => entry.identifiers.id === 1),
  );
  const { dockviewApi } = useAppShell();
  let heading: HTMLHeadingElement | undefined;
  /** Resolves lesson data without retaining stale content when returning to the library. */
  const lesson = createMemo(() =>
    GUIDE_LESSONS.find((entry) => entry.id === lessonId()),
  );
  /** Resolves the current instruction, leaving completion outside the action steps. */
  const step = createMemo(() => lesson()?.steps[index()]);
  const [card, setCard] = createSignal<HTMLElement>();
  const [anchor, setAnchor] = createSignal<DOMRect | null>(null);
  const floating = useFloatingGuide(
    () => (lesson() && opened() ? card() : undefined),
    () => `${lessonId()}:${index()}`,
    anchor,
  );
  const { draggable } = createDraggable();
  void draggable;
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

  /** Changes instructional position and returns focus to its heading for keyboard users. */
  const moveTo = (position: number) => {
    guideStepIndex.set(position);
    heading?.focus();
  };

  /** Records lesson completion only when the user explicitly finishes the lesson. */
  const finish = () => {
    const id = lessonId();
    if (id && !completed().includes(id))
      guideCompleted.set([...completed(), id]);
    guideLessonId.set(null);
  };

  useGuideProgress(
    () => (opened() ? step()?.observe : undefined),
    dockviewApi,
    () => guideStepIndex.set(guideStepIndex.get() + 1),
  );

  return (
    <Show when={opened()}>
      <aside
        ref={setCard}
        class="nf-welcome-guide"
        classList={{ "nf-guide-floating": Boolean(lesson()) }}
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
        <header class="nf-guide-header">
          <div class="nf-guide-title">
            <Show when={lesson()}>
              <Tooltip content={() => "All lessons"} position="bottom">
                <Button
                  size="icon"
                  variant="subtle"
                  aria-label="All lessons"
                  onClick={() => guideLessonId.set(null)}
                >
                  <ArrowLeftIcon class="size-4" aria-hidden />
                </Button>
              </Tooltip>
            </Show>
            <Show when={lesson()} fallback={<span>LEARN NIGHTFALL</span>}>
              <button
                type="button"
                class="nf-guide-move"
                aria-label="Move guide"
                title="Drag to move, or use arrow keys when focused"
                onKeyDown={floating.onKeyDown}
              >
                ⠿ LEARN NIGHTFALL
              </button>
            </Show>
          </div>
          <Button
            size="compact"
            onClick={closeWelcomeGuide}
            aria-label="Exit welcome guide"
          >
            Exit
          </Button>
        </header>
        <div class="nf-guide-body">
          <Show
            when={lesson()}
            fallback={
              <>
                <h2>Make your first lights</h2>
                <p>
                  Start with the essentials, then choose what to learn next. You
                  can leave at any time and return using Guide.
                </p>
                <For each={GUIDE_LESSONS}>
                  {(entry) => (
                    <button
                      class="nf-guide-lesson"
                      type="button"
                      onClick={() => startGuideLesson(entry.id)}
                    >
                      <span class="nf-guide-lesson-meta">
                        {entry.id === "welcome"
                          ? "START HERE"
                          : "FOLLOW-ON LESSON"}{" "}
                        · {entry.duration}
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
                <p class="nf-guide-eyebrow">
                  {current().title} ·{" "}
                  {`${Math.min(index() + 1, current().steps.length)} / ${current().steps.length}`}
                </p>
                <Show when={index() >= 0 && index() < current().steps.length}>
                  <progress
                    aria-label="Lesson progress"
                    value={index()}
                    max={current().steps.length}
                  />
                </Show>
                <h2 ref={heading} tabIndex={-1} aria-live="polite">
                  {step()?.title ?? "Ready to explore"}
                </h2>
                <Show when={step()}>
                  {(instruction) => (
                    <>
                      <p>{instruction().body}</p>
                      <div class="nf-guide-action">
                        <strong>{instruction().hint ?? "Try it"}</strong>
                        <p>{instruction().action}</p>
                        <Show when={instruction().command}>
                          <code class="nf-guide-command">
                            {instruction().command}
                          </code>
                        </Show>
                      </div>
                      <Show
                        when={
                          instruction().sampleTimeline ||
                          instruction().panels?.length
                        }
                      >
                        <div class="nf-guide-shortcuts">
                          <Show when={instruction().sampleTimeline}>
                            <Button
                              size="compact"
                              onClick={openSampleTimeline}
                              disabled={!dockviewApi() || !sampleTimeline()}
                            >
                              Open Timeline 1: Lo-Fi
                            </Button>
                          </Show>
                          <For each={instruction().panels}>
                            {(name) => (
                              <Button
                                size="compact"
                                onClick={() => openPanel(name)}
                                disabled={!dockviewApi()}
                              >
                                Open {panelDefinitionByName(name).title}
                              </Button>
                            )}
                          </For>
                        </div>
                      </Show>
                      <Show when={instruction().more}>
                        <details>
                          <summary>Learn more</summary>
                          <p>{instruction().more}</p>
                        </details>
                      </Show>
                      <GuideTarget
                        stepId={instruction().id}
                        selector={instruction().target}
                        focusTarget={instruction().focusTarget}
                        onBounds={setAnchor}
                      />
                      <GuideTarget
                        stepId={instruction().id}
                        selector={clipHighlightSelector()}
                      />
                      <p class="nf-guide-note">
                        {instruction().observe
                          ? "Advances automatically when you complete the action."
                          : "Take time to explore, then continue when you’re ready."}
                      </p>
                      <div class="nf-guide-navigation">
                        <Button
                          size="compact"
                          disabled={index() === 0}
                          onClick={() => moveTo(index() - 1)}
                        >
                          Back
                        </Button>
                        <Button
                          size="compact"
                          onClick={() => moveTo(index() + 1)}
                        >
                          Skip step
                        </Button>
                        <Button
                          size="compact"
                          variant="primary"
                          onClick={() => moveTo(index() + 1)}
                        >
                          Continue
                        </Button>
                      </div>
                    </>
                  )}
                </Show>
                <Show when={index() >= current().steps.length}>
                  <p>
                    You’ve reached the end of this lesson. Stop any timeline,
                    clip, or effect preview you started before choosing another
                    lesson.
                  </p>
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
                    <Button variant="primary" onClick={finish}>
                      Finish lesson
                    </Button>
                  </div>
                </Show>
              </>
            )}
          </Show>
        </div>
        <footer class="nf-guide-footer">
          <Show when={capabilities()?.persistence === "Unavailable"}>
            Demo edits are temporary.{" "}
          </Show>
          <Show
            when={
              lessonId() === "patch" &&
              capabilities()?.fixture_library === "Unavailable"
            }
          >
            Fixture-library import is unavailable here. Inspect the existing
            patch.
          </Show>
          <Show
            when={
              lessonId() === "transports" &&
              capabilities() &&
              !capabilities()?.network_dmx_output &&
              !capabilities()?.usb_dmx_output
            }
          >
            Hardware output is unavailable here. Follow this lesson as an
            inspection.
          </Show>
          <Show when={lessonId() !== "patch" && lessonId() !== "transports"}>
            Your show stays interactive while you learn.
          </Show>
        </footer>
      </aside>
    </Show>
  );
}
