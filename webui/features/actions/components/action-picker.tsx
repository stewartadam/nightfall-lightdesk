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
  on,
  Show,
} from "solid-js";
import { $uiActions as uiActionsStore } from "../../../components/providers/command-registry";
import { Input, NativeSelect } from "../../../components/ui/form-controls";
import { actionCatalog } from "../../../state/appStores";
import type * as types from "../../../types";
import {
  actionsAccepting,
  buildActionReference,
  findCatalogEntry,
  hasRequiredArguments,
  normalizeActionUid,
} from "../model/action-catalog";
import {
  type ActionTargetOption,
  useActionTargetOptions,
} from "../model/action-target-names";
import { uiActionCatalogEntries } from "../model/ui-action-catalog";

export interface ActionPickerProps {
  /** Currently bound action, used to seed the picker. */
  value?: types.ActionReference;
  /** Input kinds the binding source can produce; other actions are hidden. */
  inputKinds: readonly types.ActionInputKind[];
  /** Surface the binding invokes from; actions restricted to other surfaces are hidden. */
  surface: types.ActionSurface;
  /** Receives a complete action reference whenever the selection is valid. */
  onChange: (action: types.ActionReference) => void;
  /**
   * Called when a user edit leaves the selection incomplete, so callers holding a pending
   * reference can discard the one previously emitted.
   */
  onIncomplete?: () => void;
  /** Accessible label for the action selector. */
  label?: string;
  /** Also offers client-hosted `ui.*` actions registered in this client. */
  includeUiActions?: boolean;
}

/**
 * Selects a catalog action and edits its arguments with kind-specific inputs.
 *
 * Emits only complete references, so callers can persist every change directly.
 */
export function ActionPicker(props: ActionPickerProps): JSX.Element {
  const $backendCatalog = useStore(actionCatalog);
  const $uiActions = useStore(uiActionsStore);
  /** Returns the backend catalog, plus this client's UI actions when requested. */
  const $catalog = createMemo(() =>
    props.includeUiActions
      ? [...$backendCatalog(), ...uiActionCatalogEntries($uiActions())]
      : $backendCatalog(),
  );
  const targets = useActionTargetOptions();
  const [actionId, setActionId] = createSignal(props.value?.id ?? "");
  const [draft, setDraft] = createSignal<Record<string, unknown>>({
    ...((props.value?.arguments as Record<string, unknown>) ?? {}),
  });

  /** Resynchronizes local state when the bound action changes from outside. */
  createEffect(
    on(
      () => props.value,
      (value) => {
        setActionId(value?.id ?? "");
        setDraft({ ...((value?.arguments as Record<string, unknown>) ?? {}) });
      },
      { defer: true },
    ),
  );

  /** Returns selectable actions grouped by category for the source's surface and input kinds. */
  const groups = createMemo(() => {
    const grouped = new Map<string, types.ActionCatalogEntry[]>();
    for (const entry of actionsAccepting(
      $catalog(),
      props.inputKinds,
      props.surface,
    )) {
      const list = grouped.get(entry.descriptor.category) ?? [];
      list.push(entry);
      grouped.set(entry.descriptor.category, list);
    }
    return [...grouped.entries()];
  });

  /**
   * Returns whether an action is among the selectable options, so bound actions that are
   * unregistered or restricted to other surfaces still show as unavailable.
   */
  const isOffered = (id: string) =>
    groups().some(([, entries]) =>
      entries.some((entry) => entry.descriptor.id === id),
    );

  /** Returns the descriptor for the selected action, if it is still registered. */
  const descriptor = createMemo(
    () => findCatalogEntry($catalog(), actionId())?.descriptor,
  );

  /** Emits the current selection when every required argument is filled, or reports it incomplete. */
  const emit = () => {
    const current = descriptor();
    if (!current || !hasRequiredArguments(current, draft())) {
      props.onIncomplete?.();
      return;
    }
    props.onChange(buildActionReference(current, draft()));
  };

  /** Switches the selected action and keeps only arguments it still accepts. */
  const selectAction = (id: string) => {
    setActionId(id);
    const next = findCatalogEntry($catalog(), id)?.descriptor;
    const kept: Record<string, unknown> = {};
    for (const parameter of next?.parameters ?? []) {
      const value = draft()[parameter.name];
      if (value !== undefined) kept[parameter.name] = value;
    }
    setDraft(kept);
    emit();
  };

  /** Updates one argument and emits the resulting reference when complete. */
  const setArgument = (name: string, value: unknown) => {
    setDraft({ ...draft(), [name]: value });
    emit();
  };

  /** Renders a target selector for an object-reference parameter. */
  const targetSelect = (
    parameter: types.ActionParameter,
    options: ActionTargetOption[],
  ) => (
    <NativeSelect
      density="compact"
      aria-label={parameter.label}
      value={normalizeActionUid(draft()[parameter.name] ?? "")}
      onChange={(event) =>
        setArgument(parameter.name, event.currentTarget.value || undefined)
      }
    >
      <option value="">Select {parameter.label.toLowerCase()}</option>
      <For each={options}>
        {(option) => <option value={option.uid}>{option.label}</option>}
      </For>
    </NativeSelect>
  );

  /** Renders the input matching one parameter's kind. */
  const parameterInput = (parameter: types.ActionParameter) => {
    const kind = parameter.kind;
    switch (kind.type) {
      case "Clip":
        return targetSelect(parameter, targets.clips());
      case "Master":
        return targetSelect(parameter, targets.masters());
      case "Timeline":
        return targetSelect(parameter, targets.timelines());
      case "Cue":
        return targetSelect(parameter, targets.cues());
      case "Control":
      case "Integer":
      case "Number":
        return (
          <Input
            density="compact"
            type="number"
            aria-label={parameter.label}
            min={kind.type === "Control" ? 1 : kind.data.min}
            max={kind.type === "Control" ? undefined : kind.data.max}
            step={kind.type === "Number" ? "any" : 1}
            value={String(draft()[parameter.name] ?? "")}
            onChange={(event) => {
              const raw = event.currentTarget.value;
              setArgument(parameter.name, raw === "" ? undefined : Number(raw));
            }}
          />
        );
      case "Panel":
      case "Text":
        return (
          <Input
            density="compact"
            aria-label={parameter.label}
            value={String(draft()[parameter.name] ?? "")}
            onChange={(event) =>
              setArgument(parameter.name, event.currentTarget.value)
            }
          />
        );
    }
  };

  return (
    <div class="flex flex-wrap items-center gap-2" data-action-picker="true">
      <NativeSelect
        density="compact"
        aria-label={props.label ?? "Action"}
        value={actionId()}
        onChange={(event) => selectAction(event.currentTarget.value)}
      >
        <option value="">Select action</option>
        <Show when={props.value && !isOffered(props.value.id)}>
          <option value={props.value?.id}>
            {props.value?.id} (unavailable)
          </option>
        </Show>
        <For each={groups()}>
          {([category, entries]) => (
            <optgroup label={category}>
              <For each={entries}>
                {(entry) => (
                  <option value={entry.descriptor.id}>
                    {entry.descriptor.label}
                  </option>
                )}
              </For>
            </optgroup>
          )}
        </For>
      </NativeSelect>
      <For each={descriptor()?.parameters ?? []}>
        {(parameter) => parameterInput(parameter)}
      </For>
    </div>
  );
}
