// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { TrashIcon } from "@squidlab/phosphor-solid/trash";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  Show,
  splitProps,
} from "solid-js";
import { CountBadge } from "../../../components/ui/badge";
import {
  MenuHeading,
  MenuItem,
  MenuSeparator,
  MenuSurface,
} from "../../../components/ui/menu";
import { Popover } from "../../../components/ui/popover";
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

/** One action a mappable control can bind, with the label shown when choosing it. */
export interface MappableChoice {
  /** User-facing choice label, such as "Fader 1" or "Assigned master". */
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
  const [open, setOpen] = createSignal(false);
  let overlay: HTMLButtonElement | undefined;
  let menu: HTMLDivElement | undefined;

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
   * Returns whether a control is armed that cannot bind to this target at all, so the
   * overlay can show that before it is clicked.
   */
  const incompatible = () =>
    $mode().armed !== undefined && options().length === 0;

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

  /**
   * Closes the popover when mapping mode ends, and once it has nothing left to
   * offer, such as after removing the last binding with no control armed.
   */
  createEffect(() => {
    if (!open()) return;
    const empty = options().length === 0 && existingBindings().length === 0;
    if (!$mode().active || empty) setOpen(false);
  });

  return (
    <div class={`relative ${local.class ?? ""}`} {...rest}>
      {local.children}
      <Show when={$mode().active && local.choices().length > 0}>
        <button
          ref={overlay}
          type="button"
          class={`nf-mappable-overlay absolute inset-0 z-20 rounded border-2 ${
            incompatible()
              ? "cursor-not-allowed border-dashed border-neutral-500/60 bg-neutral-950/40"
              : "cursor-crosshair border-amber-400/80 bg-amber-400/10 hover:bg-amber-400/25"
          }`}
          aria-label={`Map ${local.label}`}
          aria-expanded={open()}
          title={
            incompatible()
              ? "The touched control can't drive this. Click to see why."
              : undefined
          }
          data-mappable-overlay
          data-mapping-armed={$mode().armed ? "true" : "false"}
          data-mapping-compatible={
            $mode().armed ? String(!incompatible()) : undefined
          }
          onPointerDown={(event) => event.stopPropagation()}
          onClick={handleClick}
        >
          <CountBadge
            count={existingBindings().length}
            tone="warning"
            data-mapping-count
          />
        </button>
        <Popover
          anchor={() => overlay}
          open={open()}
          onClose={() => setOpen(false)}
          placement="auto"
          ref={(element) => {
            menu = element;
          }}
          initialFocus={() =>
            menu?.querySelector<HTMLElement>("[data-recommended]") ?? undefined
          }
          surface={MenuSurface}
          class="w-72"
          role="menu"
          aria-label={`Map ${local.label} to`}
          data-mapping-popover
        >
          <Show when={$mode().armed}>
            {(armed) => (
              <MenuHeading literal>
                {describeArmedSource(armed(), midiSourceLabel)} → {local.label}
              </MenuHeading>
            )}
          </Show>
          <For each={options()}>
            {(option) => (
              <MenuItem
                role="menuitem"
                aria-label={option.label}
                data-binding-option={option.behavior}
                data-recommended={option === recommended() ? "" : undefined}
                description={option.description}
                shortcut={option === recommended() ? "Suggested" : undefined}
                onClick={() => void bind(option)}
              >
                {option.label}
              </MenuItem>
            )}
          </For>
          <Show when={existingBindings().length > 0}>
            <Show when={options().length > 0}>
              <MenuSeparator />
            </Show>
            <MenuHeading>Already bound here</MenuHeading>
            <For each={existingBindings()}>
              {(binding) => (
                <MenuItem
                  role="menuitem"
                  icon={TrashIcon}
                  danger
                  aria-label={`Remove ${binding.label}`}
                  data-existing-binding
                  onClick={() => remove(binding)}
                >
                  {binding.label}
                </MenuItem>
              )}
            </For>
          </Show>
        </Popover>
      </Show>
    </div>
  );
}
