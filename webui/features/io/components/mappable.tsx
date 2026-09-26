// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  onCleanup,
  Show,
  splitProps,
} from "solid-js";
import { Portal } from "solid-js/web";
import {
  actionCatalog,
  midiMappings,
  oscMappings,
  pushToast,
} from "../../../state/appStores";
import * as types from "../../../types";
import {
  actionReferencesEqual,
  findCatalogEntry,
  formatActionReference,
  useActionTargetNames,
  useBindableActionCatalog,
} from "../../actions";
import {
  actionBehaviors,
  behaviorLabel,
  describeBinding,
  recommendedBinding,
} from "../model/binding-behaviors";
import {
  formatBehavior,
  midiSourceLabel,
} from "../model/controller-mapping-builders";
import {
  deleteMidiMapping,
  deleteOscMapping,
} from "../model/controller-mappings";
import {
  armedBindingProblem,
  armedSourceSupports,
  bindArmedSource,
} from "../model/mapping-bind";
import {
  $mappingMode,
  armedSourceIsContinuous,
  describeArmedSource,
} from "../model/mapping-mode";

/** Width of the binding popover, matching its `w-72` class. */
const POPOVER_WIDTH_PX = 288;

/** Space needed below a control to open the popover downward. */
const POPOVER_ROOM_PX = 320;

/** One action a mappable control can bind, with the label shown when choosing it. */
export interface MappableChoice {
  /** User-facing choice label, such as "Fader slot" or "Assigned master". */
  label: string;
  /** Action bound when this choice is selected. */
  action: types.ActionReference;
  /**
   * Behaviors offered for this choice; defaults to every behavior the action supports.
   *
   * Restricting a choice lets a control offer, say, "Toggle" on press and release while
   * offering Hold through a separate on/off action.
   */
  behaviors?: types.ControlBehavior[];
}

export interface MappableProps extends JSX.HTMLAttributes<HTMLDivElement> {
  /** Actions this control can be bound to, most specific first. */
  choices: () => MappableChoice[];
  /** Accessible name of the control, used for the mapping overlay. */
  label: string;
  /** Wrapped control. */
  children: JSX.Element;
}

/** One way the armed control can bind to this target. */
interface BindingOption {
  /** Short label naming the choice and behavior. */
  label: string;
  /** Sentence describing what the binding will do. */
  description: string;
  /** Action to bind. */
  action: types.ActionReference;
  /** Behavior to bind with. */
  behavior: types.ControlBehavior;
  /** Input kind of the action, when the catalog knows it. */
  inputKind: types.ActionInputKind | undefined;
}

/** An existing controller binding to one of this target's actions. */
interface ExistingBinding {
  /** Mapping ID. */
  id: string;
  /** Surface that owns the mapping. */
  kind: "midi" | "osc";
  /** Control and behavior summary. */
  label: string;
}

/**
 * Wraps a control that controller mapping mode can bind to an action.
 *
 * Outside mapping mode the wrapper is inert. In mapping mode an overlay covers the control
 * and shows how many controller mappings already invoke its actions. Clicking it with an
 * armed control offers each supported behavior with a sentence describing it, and binds as
 * soon as one is chosen; with a single option it binds directly. The option the control most
 * likely means is marked as suggested and focused, so Enter binds it. Without an armed control
 * the popover lists existing bindings so they can be removed.
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
  const $backendCatalog = useStore(actionCatalog);
  const $catalog = useBindableActionCatalog();
  const targetNames = useActionTargetNames();
  const [open, setOpenState] = createSignal(false);
  const [position, setPosition] = createSignal<JSX.CSSProperties>({});
  let overlay: HTMLButtonElement | undefined;
  let popover: HTMLDivElement | undefined;

  /** Opens or closes the popover, anchored below the overlay, or above it near the bottom. */
  const setOpen = (next: boolean) => {
    if (next && overlay) {
      const bounds = overlay.getBoundingClientRect();
      const left = `${Math.max(8, Math.min(bounds.left, window.innerWidth - POPOVER_WIDTH_PX - 8))}px`;
      setPosition(
        bounds.bottom + POPOVER_ROOM_PX > window.innerHeight
          ? { left, bottom: `${window.innerHeight - bounds.top + 4}px` }
          : { left, top: `${bounds.bottom + 4}px` },
      );
    }
    setOpenState(next);
  };

  /** Formats an action reference with target names for display. */
  const actionText = (action: types.ActionReference) =>
    formatActionReference(action, $catalog(), targetNames);

  /** Returns whether a mapping invokes one of this control's actions. */
  const boundHere = (action: types.ActionReference) =>
    local
      .choices()
      .some((choice) => actionReferencesEqual(choice.action, action));

  /** Lists existing MIDI and OSC bindings to this control's actions. */
  const existingBindings = createMemo<ExistingBinding[]>(() => [
    ...$midiMappings()
      .filter((mapping) => boundHere(mapping.action))
      .map((mapping) => ({
        id: mapping.id,
        kind: "midi" as const,
        label: `MIDI ${midiSourceLabel(mapping.source)} (${mapping.device_name}) · ${formatBehavior(mapping.behavior)}`,
      })),
    ...$oscMappings()
      .filter((mapping) => boundHere(mapping.action))
      .map((mapping) => ({
        id: mapping.id,
        kind: "osc" as const,
        label: `OSC ${mapping.address}${mapping.arg_value ? ` ${mapping.arg_value}` : ""} · ${formatBehavior(mapping.behavior)}`,
      })),
  ]);

  /** Lists every (choice, behavior) the armed control can bind to this target. */
  const options = createMemo<BindingOption[]>(() => {
    const armed = $mode().armed;
    if (!armed) return [];
    const control = describeArmedSource(armed, midiSourceLabel);
    const choices = local.choices();
    return choices.flatMap((choice) => {
      const entry = findCatalogEntry($catalog(), choice.action.id);
      const inputKind = entry?.descriptor.input;
      const behaviors = choice.behaviors ?? actionBehaviors(entry);
      const releaseId = findCatalogEntry($backendCatalog(), choice.action.id)
        ?.descriptor.hold_release;
      return behaviors
        .filter((behavior) =>
          armedSourceSupports(armed, choice.action, behavior),
        )
        .map((behavior) => {
          const label = behaviorLabel(behavior, inputKind);
          return {
            label:
              choices.length === 1
                ? label
                : choice.behaviors?.length === 1
                  ? choice.label
                  : `${choice.label} · ${label}`,
            description: describeBinding({
              control,
              action: actionText(choice.action),
              releaseAction: releaseId
                ? actionText({ ...choice.action, id: releaseId })
                : undefined,
              behavior,
              inputKind,
            }),
            action: choice.action,
            behavior,
            inputKind,
          };
        });
    });
  });

  /**
   * Picks the option the touched control most likely means, judged from what it sent: a
   * fader follows a level, a button fires on press. The popover focuses it so Enter binds it.
   */
  const recommended = createMemo(() => {
    const armed = $mode().armed;
    return armed
      ? recommendedBinding(options(), armedSourceIsContinuous(armed))
      : undefined;
  });

  /** Binds one option, closing the popover. */
  const bind = async (option: BindingOption) => {
    setOpen(false);
    await bindArmedSource(
      option.action,
      actionText(option.action),
      option.behavior,
    );
  };

  /** Removes an existing binding. */
  const remove = (binding: ExistingBinding) => {
    void (binding.kind === "midi"
      ? deleteMidiMapping(binding.id)
      : deleteOscMapping(binding.id));
  };

  /** Binds a single option directly, or opens the popover to choose or review bindings. */
  const handleClick = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (open()) {
      setOpen(false);
      return;
    }
    const armed = $mode().armed;
    const choices = options();
    if (armed && choices.length === 1) {
      void bind(choices[0]);
    } else if (armed && choices.length === 0) {
      const [first] = local.choices();
      pushToast(
        "info",
        (first &&
          armedBindingProblem(
            armed,
            first.action,
            first.behaviors?.[0] ?? types.ControlBehavior.Press,
            actionText(first.action),
          )) ??
          `${describeArmedSource(armed, midiSourceLabel)} cannot drive ${local.label}.`,
      );
    } else if (armed || existingBindings().length > 0) {
      setOpen(true);
    } else {
      pushToast("info", "Move a MIDI or OSC control first, then click here.");
    }
  };

  /** Closes the popover on outside clicks and when mapping mode ends. */
  createEffect(() => {
    if (!open()) return;
    if (!$mode().active) {
      setOpen(false);
      return;
    }
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!overlay?.contains(target) && !popover?.contains(target)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", closeOutside, true);
    onCleanup(() =>
      document.removeEventListener("pointerdown", closeOutside, true),
    );
  });

  return (
    <div class={`relative ${local.class ?? ""}`} {...rest}>
      {local.children}
      <Show when={$mode().active && local.choices().length > 0}>
        <button
          ref={overlay}
          type="button"
          class="nf-mappable-overlay absolute inset-0 z-20 cursor-crosshair rounded border-2 border-amber-400/80 bg-amber-400/10 hover:bg-amber-400/25"
          aria-label={`Map ${local.label}`}
          aria-expanded={open()}
          data-mappable-overlay
          data-mapping-armed={$mode().armed ? "true" : "false"}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={handleClick}
        >
          <Show when={existingBindings().length > 0}>
            <span
              class="absolute -right-1 -top-1 rounded-full bg-amber-400 px-1.5 text-[10px] font-semibold leading-4 text-neutral-950"
              data-mapping-count
            >
              {existingBindings().length}
            </span>
          </Show>
        </button>
        <Show when={open()}>
          <Portal mount={document.body}>
            <div
              ref={popover}
              class="nightfall-top-layer fixed flex w-72 flex-col gap-1 rounded border border-neutral-700 bg-neutral-900 p-1 text-xs shadow-lg"
              style={position()}
              role="menu"
              aria-label={`Map ${local.label} to`}
              data-mapping-popover
            >
              <Show when={$mode().armed}>
                {(armed) => (
                  <div class="px-2 pt-1 text-[11px] font-semibold text-neutral-400">
                    {describeArmedSource(armed(), midiSourceLabel)} →{" "}
                    {local.label}
                  </div>
                )}
              </Show>
              <For each={options()}>
                {(option) => (
                  <button
                    ref={(element) => {
                      if (option === recommended()) {
                        queueMicrotask(() => element.focus());
                      }
                    }}
                    type="button"
                    role="menuitem"
                    aria-label={option.label}
                    class="rounded px-2 py-1 text-left outline-none hover:bg-neutral-800 focus-visible:bg-neutral-800 data-[recommended]:ring-1 data-[recommended]:ring-amber-400/70"
                    data-binding-option={option.behavior}
                    data-recommended={option === recommended() ? "" : undefined}
                    onClick={() => void bind(option)}
                  >
                    <span class="flex items-center justify-between gap-2 text-neutral-100">
                      {option.label}
                      <Show when={option === recommended()}>
                        <span class="text-[10px] font-semibold uppercase tracking-wide text-amber-300">
                          Suggested
                        </span>
                      </Show>
                    </span>
                    <span class="block text-[11px] text-neutral-400">
                      {option.description}
                    </span>
                  </button>
                )}
              </For>
              <Show when={existingBindings().length > 0}>
                <div class="border-t border-neutral-800 px-2 pt-1 text-[11px] font-semibold text-neutral-400">
                  Already bound here
                </div>
                <For each={existingBindings()}>
                  {(binding) => (
                    <div
                      class="flex items-center justify-between gap-2 px-2 py-0.5"
                      data-existing-binding
                    >
                      <span class="truncate text-neutral-300">
                        {binding.label}
                      </span>
                      <button
                        type="button"
                        class="shrink-0 rounded px-1.5 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
                        aria-label={`Remove ${binding.label}`}
                        onClick={() => remove(binding)}
                      >
                        Remove
                      </button>
                    </div>
                  )}
                </For>
              </Show>
            </div>
          </Portal>
        </Show>
      </Show>
    </div>
  );
}
