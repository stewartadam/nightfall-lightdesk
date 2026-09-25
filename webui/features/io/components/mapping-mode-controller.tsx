// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { PlugsConnectedIcon } from "@squidlab/phosphor-solid/plugs-connected";
import { createEffect, on, onCleanup, Show } from "solid-js";
import { useUiAction } from "../../../components/providers/command-registry";
import { Button } from "../../../components/ui/visual-language/button";
import { engineRuntime, resyncGeneration } from "../../../lib/engine-runtime";
import { useKeyboardShortcut } from "../../../lib/keyboardShortcuts";
import { getLogger } from "../../../lib/logger";
import {
  controllerMappingMode,
  midiControlTouches,
  oscControlTouches,
} from "../../../state/appStores";
import { midiSourceLabel } from "../model/controller-mapping-builders";
import {
  $mappingMode,
  armMidiTouches,
  armOscTouches,
  describeArmedSource,
  describeMappingPause,
  exitMappingMode,
  mappingModeCommand,
  toggleMappingMode,
} from "../model/mapping-mode";

const log = getLogger(import.meta.url);

/** Tells the backend whether this client is mapping, so it pauses MIDI and OSC actions. */
function sendMappingMode(active: boolean): void {
  log.debug(
    `${active ? "Entering" : "Leaving"} backend controller mapping mode`,
  );
  engineRuntime.sendCommand(mappingModeCommand(active));
}

/**
 * Arms controller mapping from touched MIDI and OSC controls and registers its commands.
 *
 * Mounted once by the application shell. The backend reports touches reliably and only
 * while a client is mapping, and pauses controller actions meanwhile, so touching an
 * already-mapped control arms it instead of firing its live action.
 */
export function MappingModeController() {
  const $mode = useStore($mappingMode);

  // Subscribe to the raw stores: every batch is a new value, even when it repeats the
  // previous control, so change notifications must not be deduplicated.
  const unsubscribeMidi = midiControlTouches.listen((touches) => {
    armMidiTouches(structuredClone(touches));
  });
  const unsubscribeOsc = oscControlTouches.listen((touches) => {
    armOscTouches(structuredClone(touches));
  });
  onCleanup(() => {
    unsubscribeMidi();
    unsubscribeOsc();
  });

  /** Enters or leaves backend mapping mode whenever this client's mapping mode toggles. */
  createEffect(
    on(
      () => $mode().active,
      (active, wasActive) => {
        if (active !== (wasActive ?? false)) sendMappingMode(active);
      },
    ),
  );

  /**
   * Re-enters backend mapping mode after reconnecting, because the backend released this
   * client's hold when the previous connection closed.
   */
  createEffect(
    on(
      resyncGeneration,
      () => {
        if ($mappingMode.get().active) sendMappingMode(true);
      },
      { defer: true },
    ),
  );

  useUiAction({
    id: "io.toggle-mapping-mode",
    name: "Toggle Controller Mapping Mode",
    description:
      "Touch a MIDI or OSC control, then click a highlighted control to bind it",
    icon: PlugsConnectedIcon,
    category: "I/O",
    execute: toggleMappingMode,
  });

  useKeyboardShortcut(
    {
      key: "Escape",
      handler: () => {
        if ($mode().active) exitMappingMode();
      },
      description: "Exit controller mapping mode",
    },
    { global: true },
  );

  return null;
}

/**
 * Shows mapping progress while mapping mode is active, and tells every other client that
 * controller actions are paused while any client is mapping.
 */
export function MappingModeBanner() {
  const $mode = useStore($mappingMode);
  const $backend = useStore(controllerMappingMode);
  /** Explains that controller actions are paused, or nothing when they are not. */
  const pause = () =>
    describeMappingPause($backend().mapping_clients, $mode().active);
  return (
    <>
      <Show when={!$mode().active && pause()}>
        {(text) => (
          <div
            class="nf-mapping-mode-banner flex items-center gap-3 border-b border-amber-500/40 bg-amber-500/10 px-4 py-1.5 text-xs text-amber-100"
            role="status"
            data-mapping-pause-banner
          >
            {text()}
          </div>
        )}
      </Show>
      <MappingModeProgress pause={pause()} />
    </>
  );
}

/** Shows this client's mapping progress and exit button while its mapping mode is active. */
function MappingModeProgress(props: { pause: string | undefined }) {
  const $mode = useStore($mappingMode);
  return (
    <Show when={$mode().active}>
      <div
        class="nf-mapping-mode-banner flex items-center justify-between gap-3 border-b border-amber-500/40 bg-amber-500/10 px-4 py-1.5 text-xs text-amber-100"
        role="status"
        data-mapping-mode-banner
      >
        <span>
          <Show
            when={$mode().armed}
            fallback="Controller mapping: move a MIDI or OSC control, then click a highlighted control. Click one without moving a control to review its bindings."
          >
            {(armed) => (
              <>
                Controller mapping:{" "}
                {describeArmedSource(armed(), midiSourceLabel)} — click a
                highlighted control to choose how it binds.
              </>
            )}
          </Show>
          <Show when={props.pause}>
            {(text) => (
              <span class="ml-2 text-amber-200/80" data-mapping-pause>
                {text()}
              </span>
            )}
          </Show>
        </span>
        <Button size="compact" type="button" onClick={exitMappingMode}>
          Done
        </Button>
      </div>
    </Show>
  );
}

/** Toggles controller mapping mode from the application header. */
export function MappingModeToggle() {
  const $mode = useStore($mappingMode);
  return (
    <Button
      size="icon"
      type="button"
      aria-label="Controller mapping mode"
      aria-pressed={$mode().active}
      title="Controller mapping mode"
      data-mapping-mode-toggle
      onClick={toggleMappingMode}
    >
      <PlugsConnectedIcon class="size-4" aria-hidden />
    </Button>
  );
}
