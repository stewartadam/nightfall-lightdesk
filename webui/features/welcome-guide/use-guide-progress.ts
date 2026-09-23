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
import { type GuideObservation, guideCompletionToken } from "./progress";

/** Advances on fresh acknowledged actions, without consuming old state or stealing input focus. */
export function useGuideProgress(
  observation: Accessor<GuideObservation | undefined>,
  dockApi: Accessor<DockviewApi | undefined>,
  advance: () => void,
): void {
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

  /** Mirrors active-panel changes using Dockview's lifecycle rather than polling the DOM. */
  createEffect(() => {
    const api = dockApi();
    setPanel(api?.activePanel?.api.component);
    const subscription = api?.onDidActivePanelChange(() =>
      setPanel(api.activePanel?.api.component),
    );
    onCleanup(() => subscription?.dispose());
  });

  /** Arms a new observation at entry, and cancels pending advancement on navigation or exit. */
  createEffect(() => {
    const target = observation();
    if (!target) return;
    /** Reads a pure completion token from the current acknowledged application snapshot. */
    const token = () =>
      guideCompletionToken(target, {
        panel: panel(),
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
    let previous = untrack(token);
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
