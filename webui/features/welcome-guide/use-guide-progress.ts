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
  createSignal,
  onCleanup,
  untrack,
} from "solid-js";
import { useAppShell } from "../../components/providers/app-shell";
import { useCommandPalette } from "../../components/providers/command-registry";
import {
  activeInstances,
  clips,
  controls,
  cues,
  fixtures,
  fx,
  programmerSelection,
  programmerState,
  sequences,
  stepFx,
  timecodes,
  timelines,
  visualizerEditSelection,
} from "../../state/appStores";
import { patchPanelActiveTab } from "../patch";
import type { GuidePanelSnapshot } from "./panel-tracking";
import {
  type GuideObservation,
  type GuideSnapshot,
  guideCompletionToken,
} from "./progress";

/** Advances on fresh actions, or immediately when the required sample panels are already open. */
export function useGuideProgress(
  observation: Accessor<GuideObservation | undefined>,
  held: Accessor<boolean>,
  workspace: Accessor<GuidePanelSnapshot>,
  advance: () => void,
): void {
  const { isOpen: commandPaletteOpen } = useCommandPalette();
  const { isSettingsOpen, isShortcutsPopupVisible } = useAppShell();
  const fixtureMap = useStore(fixtures);
  const selection = useStore(programmerSelection);
  const editSelection = useStore(visualizerEditSelection);
  const patchView = useStore(patchPanelActiveTab);
  const programmer = useStore(programmerState);
  const cueMap = useStore(cues);
  const sequenceMap = useStore(sequences);
  const clipMap = useStore(clips);
  const fxMap = useStore(fx);
  const stepFxMap = useStore(stepFx);
  const controlList = useStore(controls);
  const instances = useStore(activeInstances);
  const timelineMap = useStore(timelines);
  const clocks = useStore(timecodes);
  /** Reads the active panel from the shared workspace snapshot. */
  const panel = () => workspace().activeComponent;
  /** Reads open panels and their visibility from the shared workspace snapshot. */
  const openPanels = () => workspace().panels;

  /** Arms a new observation at entry, and cancels pending advancement on navigation or exit. */
  createEffect(() => {
    const target = observation();
    if (!target) return;
    const [accentPicked, setAccentPicked] = createSignal(false);
    const [saveShowfilePressed, setSaveShowfilePressed] = createSignal(false);
    /** Observes the enabled save menu action, including keyboard-generated clicks. */
    const pressSaveShowfile = (event: MouseEvent) => {
      if (
        event.target instanceof Element &&
        event.target.closest(
          '[data-component="DropdownMenuItem"]:has([data-guide-target="save-showfile"]):not([disabled])',
        )
      )
        setSaveShowfilePressed(true);
    };
    if (target.type === "save-showfile") {
      document.addEventListener("click", pressSaveShowfile, true);
      onCleanup(() =>
        document.removeEventListener("click", pressSaveShowfile, true),
      );
    }
    const [submittedCommand, setSubmittedCommand] = createSignal<string>();
    /** Captures command input submissions, including repeats of the previous history entry. */
    const submitCommand = (event: SubmitEvent) => {
      const input =
        event.target instanceof HTMLFormElement
          ? event.target.querySelector<HTMLInputElement>(
              "#header-cmdline, #cmdline",
            )
          : null;
      if (input) setSubmittedCommand(input.value);
    };
    if (target.type === "command-submitted") {
      document.addEventListener("submit", submitCommand, true);
      onCleanup(() =>
        document.removeEventListener("submit", submitCommand, true),
      );
    }
    const [selectedTimelineActions, setSelectedTimelineActions] = createSignal<
      GuideSnapshot["selectedTimelineActions"]
    >([]);
    /** Mirrors selected timeline action chips, whose selection is local to each editor. */
    const readSelectedTimelineActions = () =>
      setSelectedTimelineActions(
        [
          ...document.querySelectorAll<HTMLElement>(
            '[data-timeline-surface="true"] [data-timeline-action="true"][data-selected="true"]:not([data-drag-preview])',
          ),
        ].map((element) => ({
          timelineUid:
            element.closest<HTMLElement>('[data-timeline-surface="true"]')
              ?.dataset.timelineUid ?? "",
          trackId: element.dataset.trackId ?? "",
          actionId: element.dataset.actionId ?? "",
        })),
      );
    if (target.type === "timeline-action-selected") {
      readSelectedTimelineActions();
      const observer = new MutationObserver(readSelectedTimelineActions);
      observer.observe(document.body, {
        subtree: true,
        attributes: true,
        attributeFilter: ["data-selected"],
      });
      onCleanup(() => observer.disconnect());
    }
    /** Counts a deliberate swatch choice, including reselecting the current color. */
    const pickAccent = (event: MouseEvent) => {
      if (
        isSettingsOpen() &&
        event.target instanceof Element &&
        event.target.closest('[aria-label="Settings"] .nf-accent-picker button')
      )
        setAccentPicked(true);
    };
    if (target.type === "accent-settings-closed") {
      document.addEventListener("click", pickAccent, true);
      onCleanup(() => document.removeEventListener("click", pickAccent, true));
    }
    /** Reads a pure completion token from the current acknowledged application snapshot. */
    const token = () =>
      guideCompletionToken(target, {
        commandPaletteOpen: commandPaletteOpen(),
        settingsOpen: isSettingsOpen(),
        shortcutsOpen: isShortcutsPopupVisible(),
        accentPicked: accentPicked(),
        saveShowfilePressed: saveShowfilePressed(),
        submittedCommand: submittedCommand(),
        editSelection: editSelection(),
        patchView: patchView(),
        selectedTimelineActions: selectedTimelineActions(),
        panel: panel(),
        openPanels: openPanels(),
        fixtures: fixtureMap(),
        selection: selection(),
        programmer: programmer(),
        cues: cueMap(),
        sequences: sequenceMap(),
        clips: clipMap(),
        fx: fxMap(),
        stepFx: stepFxMap(),
        controls: controlList(),
        instances: instances(),
        timelines: timelineMap(),
        timecodes: clocks(),
      });
    let previous =
      target.type === "sample-panels" ||
      target.type === "sequence-editor" ||
      target.type === "panel-hidden" ||
      target.type === "panel-closed" ||
      target.type === "playback-idle" ||
      target.type === "timeline-action-selected"
        ? ""
        : untrack(token);
    let pending: ReturnType<typeof setTimeout> | undefined;
    /**
     * Advances once per step after a new matching state is published. While held, the step-entry
     * state is kept, so an action completed before the instructions appeared advances once they do.
     */
    createEffect(() => {
      const next = token();
      if (held()) return;
      if (next && next !== previous && pending === undefined)
        pending = setTimeout(advance, 0);
      previous = next;
    });
    onCleanup(() => clearTimeout(pending));
  });
}
