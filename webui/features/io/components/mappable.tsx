// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import {
  createMemo,
  createSignal,
  For,
  type JSX,
  Show,
  splitProps,
} from "solid-js";
import { midiMappings, oscMappings } from "../../../state/appStores";
import type * as types from "../../../types";
import {
  actionReferencesEqual,
  formatActionReference,
  useActionTargetNames,
  useBindableActionCatalog,
} from "../../actions";
import { bindArmedSource } from "../model/mapping-bind";
import { $mappingMode } from "../model/mapping-mode";

/** One action a mappable control can bind, with the label shown when choosing it. */
export interface MappableChoice {
  /** User-facing choice label, such as "Fader slot" or "Assigned master". */
  label: string;
  /** Action bound when this choice is selected. */
  action: types.ActionReference;
}

export interface MappableProps extends JSX.HTMLAttributes<HTMLDivElement> {
  /**
   * Actions this control can be bound to, most specific first.
   *
   * With more than one choice, clicking in mapping mode asks which to bind.
   */
  choices: () => MappableChoice[];
  /** Accessible name of the control, used for the mapping overlay. */
  label: string;
  /** Wrapped control. */
  children: JSX.Element;
}

/**
 * Wraps a control that controller mapping mode can bind to an action.
 *
 * Outside mapping mode the wrapper is inert. In mapping mode an overlay covers the control,
 * shows how many controller mappings already invoke its action, and binds the armed
 * MIDI or OSC source on click instead of operating the control.
 */
export function Mappable(props: MappableProps): JSX.Element {
  const [local, rest] = splitProps(props, [
    "choices",
    "label",
    "children",
    "class",
  ]);
  const $mode = useStore($mappingMode);
  const $midiMappings = useStore(midiMappings);
  const $oscMappings = useStore(oscMappings);
  const $catalog = useBindableActionCatalog();
  const targetNames = useActionTargetNames();
  const [choosing, setChoosing] = createSignal(false);

  /** Counts existing MIDI and OSC mappings bound to any of this control's actions. */
  const bindingCount = createMemo(() => {
    const actions = local.choices().map((choice) => choice.action);
    const matches = (action: types.ActionReference) =>
      actions.some((candidate) => actionReferencesEqual(candidate, action));
    return (
      $midiMappings().filter((mapping) => matches(mapping.action)).length +
      $oscMappings().filter((mapping) => matches(mapping.action)).length
    );
  });

  /** Binds the armed source to an action and reports the result. */
  const bind = async (action: types.ActionReference) => {
    setChoosing(false);
    await bindArmedSource(
      action,
      formatActionReference(action, $catalog(), targetNames),
    );
  };

  /** Binds directly with one choice, or asks which action to bind with several. */
  const handleClick = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const choices = local.choices();
    if (choices.length === 1) {
      void bind(choices[0].action);
    } else if (choices.length > 1) {
      setChoosing(!choosing());
    }
  };

  return (
    <div class={`relative ${local.class ?? ""}`} {...rest}>
      {local.children}
      <Show when={$mode().active && local.choices().length > 0}>
        <button
          type="button"
          class="nf-mappable-overlay absolute inset-0 z-20 cursor-crosshair rounded border-2 border-amber-400/80 bg-amber-400/10 hover:bg-amber-400/25"
          aria-label={`Map ${local.label}`}
          data-mappable-overlay
          data-mapping-armed={$mode().armed ? "true" : "false"}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={handleClick}
        >
          <Show when={bindingCount() > 0}>
            <span
              class="absolute -right-1 -top-1 rounded-full bg-amber-400 px-1.5 text-[10px] font-semibold leading-4 text-neutral-950"
              data-mapping-count
            >
              {bindingCount()}
            </span>
          </Show>
        </button>
        <Show when={choosing()}>
          <div
            class="absolute left-0 top-full z-30 mt-1 flex min-w-40 flex-col rounded border border-neutral-700 bg-neutral-900 p-1 text-xs shadow-lg"
            role="menu"
            aria-label={`Map ${local.label} to`}
          >
            <For each={local.choices()}>
              {(choice) => (
                <button
                  type="button"
                  role="menuitem"
                  class="rounded px-2 py-1 text-left hover:bg-neutral-800"
                  onClick={() => void bind(choice.action)}
                >
                  {choice.label}
                </button>
              )}
            </For>
          </div>
        </Show>
      </Show>
    </div>
  );
}
