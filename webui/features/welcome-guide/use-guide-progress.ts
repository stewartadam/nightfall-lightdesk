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
import { libraryDefinitionId } from "../../lib/fixture-service";
import { useConditionalShallowStore } from "../../lib/use-shallow-store";
import {
  activeInstances,
  clips,
  cues,
  faders,
  fixtureLibrary,
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
import { patchPanelActiveTab, usePatchWizard } from "../patch";
import type { GuidePanelSnapshot } from "./panel-tracking";
import {
  type GuideObservation,
  type GuideSnapshot,
  guideCompletionToken,
} from "./progress";

/** Show snapshots the guide reads, each as a plain (unreconciled) accessor. */
export type GuideShowState = {
  fixtures: Accessor<GuideSnapshot["fixtures"]>;
  selection: Accessor<GuideSnapshot["selection"]>;
  editSelection: Accessor<readonly string[]>;
  library: Accessor<Readonly<ReturnType<typeof fixtureLibrary.get>>>;
  programmer: Accessor<GuideSnapshot["programmer"]>;
  cues: Accessor<GuideSnapshot["cues"]>;
  sequences: Accessor<GuideSnapshot["sequences"]>;
  clips: Accessor<GuideSnapshot["clips"]>;
  fx: Accessor<NonNullable<GuideSnapshot["fx"]>>;
  stepFx: Accessor<NonNullable<GuideSnapshot["stepFx"]>>;
  faders: Accessor<GuideSnapshot["faders"]>;
  instances: Accessor<GuideSnapshot["instances"]>;
  timelines: Accessor<GuideSnapshot["timelines"]>;
  timecodes: Accessor<GuideSnapshot["timecodes"]>;
};

/**
 * Subscribes once to every show snapshot the guide reads, and only while `enabled`.
 *
 * The guide only looks objects up in these snapshots and compares plain completion tokens, so
 * it reads them shallowly rather than deep-reconciling each large snapshot (fixture definitions,
 * cues) on every update. While the guide is closed it holds no subscriptions, so show loads and
 * edits cost it nothing; reopening it refreshes every snapshot before its observations run.
 */
export function useGuideShowState(enabled: Accessor<boolean>): GuideShowState {
  return {
    fixtures: useConditionalShallowStore(fixtures, enabled),
    selection: useConditionalShallowStore(programmerSelection, enabled),
    editSelection: useConditionalShallowStore(visualizerEditSelection, enabled),
    library: useConditionalShallowStore(fixtureLibrary, enabled),
    programmer: useConditionalShallowStore(programmerState, enabled),
    cues: useConditionalShallowStore(cues, enabled),
    sequences: useConditionalShallowStore(sequences, enabled),
    clips: useConditionalShallowStore(clips, enabled),
    fx: useConditionalShallowStore(fx, enabled),
    stepFx: useConditionalShallowStore(stepFx, enabled),
    faders: useConditionalShallowStore(faders, enabled),
    instances: useConditionalShallowStore(activeInstances, enabled),
    timelines: useConditionalShallowStore(timelines, enabled),
    timecodes: useConditionalShallowStore(timecodes, enabled),
  };
}

/**
 * Reads the application state that observations compare against. Events a single observation
 * records while it is armed, such as a submitted command, are left out; the observation adds them.
 */
export function useGuideSnapshot(
  workspace: Accessor<GuidePanelSnapshot>,
  show: GuideShowState,
): Accessor<GuideSnapshot> {
  const { isOpen: commandPaletteOpen } = useCommandPalette();
  const { isSettingsOpen, isShortcutsPopupVisible } = useAppShell();
  const patchView = useStore(patchPanelActiveTab);
  const wizard = usePatchWizard();
  /** Summarizes the open Add fixture wizard, naming its chosen definition by library model. */
  const patchWizard = (): GuideSnapshot["patchWizard"] => {
    if (!wizard.isOpen() || wizard.state().morphFixtureIds.length > 0)
      return undefined;
    const {
      fixtureDefinitionId,
      fixtureMode,
      quantity,
      assignConsoleDmx,
      universeId,
      startAddress,
    } = wizard.state();
    return {
      step: wizard.currentStep(),
      model: show
        .library()
        .find((entry) => libraryDefinitionId(entry) === fixtureDefinitionId)
        ?.model,
      mode: fixtureMode ?? undefined,
      quantity,
      firstFixtureId: wizard.baseFixtureId(),
      universeId: assignConsoleDmx ? universeId : null,
      startAddress: assignConsoleDmx ? startAddress : null,
    };
  };
  /** Reads the active panel from the shared workspace snapshot. */
  const panel = () => workspace().activeComponent;
  /** Reads open panels and their visibility from the shared workspace snapshot. */
  const openPanels = () => workspace().panels;
  /** Collects the current state; reading it tracks every store it draws on. */
  return () => ({
    commandPaletteOpen: commandPaletteOpen(),
    settingsOpen: isSettingsOpen(),
    shortcutsOpen: isShortcutsPopupVisible(),
    editSelection: show.editSelection(),
    patchView: patchView(),
    patchWizard: patchWizard(),
    panel: panel(),
    openPanels: openPanels(),
    fixtures: show.fixtures(),
    selection: show.selection(),
    programmer: show.programmer(),
    cues: show.cues(),
    sequences: show.sequences(),
    clips: show.clips(),
    fx: show.fx(),
    stepFx: show.stepFx(),
    faders: show.faders(),
    instances: show.instances(),
    timelines: show.timelines(),
    timecodes: show.timecodes(),
  });
}

/**
 * Advances on fresh actions, or immediately when a state-based condition is already met.
 * A step the user went Back to only advances on a fresh change, so it can be read again.
 */
export function useGuideProgress(
  observation: Accessor<GuideObservation | undefined>,
  held: Accessor<boolean>,
  revisited: Accessor<boolean>,
  snapshot: Accessor<GuideSnapshot>,
  advance: () => void,
): void {
  const { isSettingsOpen } = useAppShell();

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
        ...snapshot(),
        accentPicked: accentPicked(),
        saveShowfilePressed: saveShowfilePressed(),
        submittedCommand: submittedCommand(),
        selectedTimelineActions: selectedTimelineActions(),
      });
    let previous =
      !untrack(revisited) &&
      (target.type === "sample-panels" ||
        target.type === "sequence-editor" ||
        target.type === "panel-hidden" ||
        target.type === "panel-closed" ||
        target.type === "playback-idle" ||
        target.type === "timeline-action-selected")
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
