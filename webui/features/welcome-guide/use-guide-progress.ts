// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import type { DockviewApi } from "dockview";
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
  programmerSelection,
  programmerState,
  sequences,
  timecodes,
  timelines,
} from "../../state/appStores";
import {
  type GuideObservation,
  type GuideSnapshot,
  guideCompletionToken,
} from "./progress";

/** Advances on fresh actions, or immediately when the required sample panels are already open. */
export function useGuideProgress(
  observation: Accessor<GuideObservation | undefined>,
  dockApi: Accessor<DockviewApi | undefined>,
  advance: () => void,
): void {
  const { isOpen: commandPaletteOpen } = useCommandPalette();
  const { isSettingsOpen } = useAppShell();
  const fixtureMap = useStore(fixtures);
  const selection = useStore(programmerSelection);
  const programmer = useStore(programmerState);
  const cueMap = useStore(cues);
  const sequenceMap = useStore(sequences);
  const clipMap = useStore(clips);
  const controlList = useStore(controls);
  const instances = useStore(activeInstances);
  const timelineMap = useStore(timelines);
  const clocks = useStore(timecodes);
  const [panel, setPanel] = createSignal<string>();
  const [openPanels, setOpenPanels] = createSignal<GuideSnapshot["openPanels"]>(
    [],
  );

  /** Mirrors active and open panels using Dockview's lifecycle rather than polling the DOM. */
  createEffect(() => {
    const api = dockApi();
    /** Captures editor identities whenever panels are added or removed. */
    const updateOpenPanels = () =>
      setOpenPanels(
        api?.panels.map((entry) => ({
          component: entry.api.component,
          timelineUid: entry.params?.initialTimelineUid,
          sequenceUid: entry.params?.initialSequenceUid,
          visible: entry.api.isVisible && !entry.group.api.isCollapsed(),
        })) ?? [],
      );
    updateOpenPanels();
    const added = api?.onDidAddPanel(updateOpenPanels);
    const removed = api?.onDidRemovePanel(updateOpenPanels);
    const layout = api?.onDidLayoutChange(updateOpenPanels);
    setPanel(api?.activePanel?.api.component);
    const subscription = api?.onDidActivePanelChange(() =>
      setPanel(api.activePanel?.api.component),
    );
    onCleanup(() => {
      subscription?.dispose();
      added?.dispose();
      removed?.dispose();
      layout?.dispose();
    });
  });

  /** Arms a new observation at entry, and cancels pending advancement on navigation or exit. */
  createEffect(() => {
    const target = observation();
    if (!target) return;
    /** Reads a pure completion token from the current acknowledged application snapshot. */
    const token = () =>
      guideCompletionToken(target, {
        commandPaletteOpen: commandPaletteOpen(),
        settingsOpen: isSettingsOpen(),
        panel: panel(),
        openPanels: openPanels(),
        fixtures: fixtureMap(),
        selection: selection(),
        programmer: programmer(),
        cues: cueMap(),
        sequences: sequenceMap(),
        clips: clipMap(),
        controls: controlList(),
        instances: instances(),
        timelines: timelineMap(),
        timecodes: clocks(),
      });
    let previous =
      target.type === "sample-panels" || target.type === "sequence-editor"
        ? ""
        : untrack(token);
    let pending: ReturnType<typeof setTimeout> | undefined;
    /** Advances once per step after a new matching state is published. */
    createEffect(() => {
      const next = token();
      if (next && next !== previous && pending === undefined)
        pending = setTimeout(advance, 0);
      previous = next;
    });
    onCleanup(() => clearTimeout(pending));
  });
}
