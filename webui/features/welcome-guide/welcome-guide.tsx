// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// SPDX-License-Identifier: MPL-2.0

import { useStore } from "@nanostores/solid";
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { useAppShell } from "../../components/providers/app-shell";
import { useCommand } from "../../components/providers/command-registry";
import { Button } from "../../components/ui/visual-language/button";
import {
  type PanelComponentName,
  panelDefinitionByName,
} from "../../lib/panel-definitions";
import { openOrFocusPanelDefinition } from "../../lib/panel-open-command";
import { isEmbeddedDemoRuntime } from "../../lib/runtime-config";
import {
  cues,
  programmerSelection,
  programmerState,
  runtimeCapabilities,
} from "../../state/appStores";
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

/** Hosts reusable lessons beside the workspace; all engine actions remain user initiated. */
export default function WelcomeGuide() {
  const opened = useStore(guideOpen);
  const lessonId = useStore(guideLessonId);
  const index = useStore(guideStepIndex);
  const completed = useStore(guideCompleted);
  const capabilities = useStore(runtimeCapabilities);
  const selection = useStore(programmerSelection);
  const programmer = useStore(programmerState);
  const cueMap = useStore(cues);
  const { dockviewApi } = useAppShell();
  const [observed, setObserved] = createSignal(false);
  let heading: HTMLHeadingElement | undefined;
  /** Resolves lesson data without retaining stale content when returning to the library. */
  const lesson = createMemo(() =>
    GUIDE_LESSONS.find((entry) => entry.id === lessonId()),
  );
  /** Treats introduction and completion as explicit positions outside the action steps. */
  const step = createMemo(() => lesson()?.steps[index()]);

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

  /** Watches acknowledged domain changes rather than treating clicks as successful edits. */
  createEffect(() => {
    const current = step();
    const active = opened();
    setObserved(false);
    if (!current || !active || !current.observe) return;
    const initialCues = JSON.stringify(cues.get());
    const initialSelection = JSON.stringify(programmerSelection.get());
    const initialProgrammer = JSON.stringify(programmerState.get());
    /** Updates success feedback when this step's domain operation has taken effect. */
    createEffect(() => {
      const changed =
        current.observe === "selection"
          ? selection().length > 0 &&
            JSON.stringify(selection()) !== initialSelection
          : current.observe === "look"
            ? programmer().length > 0 &&
              JSON.stringify(programmer()) !== initialProgrammer
            : current.observe === "cue"
              ? JSON.stringify(cueMap()) !== initialCues
              : selection().length === 0 && programmer().length === 0;
      if (changed) setObserved(true);
    });
  });

  return (
    <Show when={opened()}>
      <aside
        class="nf-welcome-guide"
        aria-label="Welcome guide"
        data-testid="welcome-guide"
      >
        <header class="nf-guide-header">
          <span>LEARN NIGHTFALL</span>
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
                <Button size="compact" onClick={() => guideLessonId.set(null)}>
                  All lessons
                </Button>
                <p class="nf-guide-eyebrow">
                  {current().title} ·{" "}
                  {index() < 0
                    ? current().duration
                    : `${Math.min(index() + 1, current().steps.length)} / ${current().steps.length}`}
                </p>
                <Show when={index() >= 0 && index() < current().steps.length}>
                  <progress
                    aria-label="Lesson progress"
                    value={index()}
                    max={current().steps.length}
                  />
                </Show>
                <h2 ref={heading} tabIndex={-1}>
                  {index() < 0
                    ? current().title
                    : (step()?.title ?? "Ready to explore")}
                </h2>
                <Show when={index() < 0}>
                  <p>{current().introduction}</p>
                  <div class="nf-guide-action">
                    <strong>Before you start</strong>
                    <p>{current().prerequisite}</p>
                  </div>
                  <p>
                    Work at your own pace. Each step offers panel shortcuts;
                    hints appear when the relevant control is visible. The guide
                    never resets or replaces your show.
                  </p>
                  <Button variant="primary" onClick={() => moveTo(0)}>
                    Start lesson
                  </Button>
                </Show>
                <Show when={step()}>
                  {(instruction) => (
                    <>
                      <p>{instruction().body}</p>
                      <div class="nf-guide-action">
                        <strong>Try it</strong>
                        <p>{instruction().action}</p>
                      </div>
                      <Show when={instruction().panels?.length}>
                        <div class="nf-guide-shortcuts">
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
                      <Show when={observed()}>
                        <p class="nf-guide-success" role="status">
                          Change detected. Take a moment to explore, then
                          continue.
                        </p>
                      </Show>
                      <GuideTarget
                        selector={instruction().target}
                        hint={instruction().hint}
                      />
                      <p class="nf-guide-note">
                        If a control is hidden, open its panel or finish the
                        current dialog. You can also skip this step.
                      </p>
                      <div class="nf-guide-navigation">
                        <Button
                          size="compact"
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
