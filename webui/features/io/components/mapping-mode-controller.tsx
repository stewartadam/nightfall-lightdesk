// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { PlugsConnectedIcon } from "@squidlab/phosphor-solid/plugs-connected";
import { onCleanup, Show } from "solid-js";
import { useCommand } from "../../../components/providers/command-registry";
import { Button } from "../../../components/ui/visual-language/button";
import { useKeyboardShortcut } from "../../../lib/keyboardShortcuts";
import { midiLastEvent, oscLastEvent } from "../../../state/appStores";
import { midiSourceLabel } from "../model/controller-mappings";
import {
  $mappingMode,
  armSource,
  describeArmedSource,
  exitMappingMode,
  toggleMappingMode,
} from "../model/mapping-mode";

/**
 * Arms controller mapping from incoming MIDI and OSC messages and registers its commands.
 *
 * Mounted once by the application shell. Only messages received while mapping mode is
 * active arm a source, so a stale last event never binds a control by accident.
 */
export function MappingModeController() {
  const $mode = useStore($mappingMode);

  // Subscribe to the raw stores: every received message is a new value, even when it
  // repeats the previous control, so change notifications must not be deduplicated.
  const unsubscribeMidi = midiLastEvent.listen((event) => {
    if (event?.source)
      armSource({ kind: "midi", event: structuredClone(event) });
  });
  const unsubscribeOsc = oscLastEvent.listen((event) => {
    if (event) armSource({ kind: "osc", event: structuredClone(event) });
  });
  onCleanup(() => {
    unsubscribeMidi();
    unsubscribeOsc();
  });

  useCommand({
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

/** Shows mapping progress while mapping mode is active. */
export function MappingModeBanner() {
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
            fallback="Controller mapping: move a MIDI or OSC control to start."
          >
            {(armed) => (
              <>
                Controller mapping:{" "}
                {describeArmedSource(armed(), midiSourceLabel)} — click a
                highlighted control to bind it.
              </>
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
