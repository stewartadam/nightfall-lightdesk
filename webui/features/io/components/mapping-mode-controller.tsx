// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { PlugsConnectedIcon } from "@squidlab/phosphor-solid/plugs-connected";
import { onCleanup, Show } from "solid-js";
import { useUiAction } from "../../../components/providers/command-registry";
import { Button } from "../../../components/ui/visual-language/button";
import { useKeyboardShortcut } from "../../../lib/keyboardShortcuts";
import { midiLastEvent, oscLastEvent } from "../../../state/appStores";
import * as types from "../../../types";
import { midiSourceLabel } from "../model/controller-mapping-builders";
import {
  $mappingMode,
  armMidiSource,
  armOscSource,
  describeArmedSource,
  exitMappingMode,
  setMappingEdge,
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
    if (event?.source) armMidiSource(structuredClone(event));
  });
  const unsubscribeOsc = oscLastEvent.listen((event) => {
    if (event) armOscSource(structuredClone(event));
  });
  onCleanup(() => {
    unsubscribeMidi();
    unsubscribeOsc();
  });

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

/** Shows mapping progress while mapping mode is active. */
export function MappingModeBanner() {
  const $mode = useStore($mappingMode);
  /** Returns whether the next click binds the armed control's release. */
  const onRelease = () => $mode().edge === types.SourceEdge.Release;
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
                highlighted control to bind its{" "}
                {onRelease() ? "release" : "press"}.
              </>
            )}
          </Show>
        </span>
        <div class="flex items-center gap-2">
          <Button
            size="compact"
            type="button"
            variant={onRelease() ? "primary" : undefined}
            aria-pressed={onRelease()}
            title="Bind the next click to the control's release, such as stopping what its press started"
            onClick={() =>
              setMappingEdge(
                onRelease() ? types.SourceEdge.Press : types.SourceEdge.Release,
              )
            }
          >
            Bind release
          </Button>
          <Button size="compact" type="button" onClick={exitMappingMode}>
            Done
          </Button>
        </div>
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
