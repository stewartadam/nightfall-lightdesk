// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { ColumnsPlusRightIcon } from "@squidlab/phosphor-solid/columns-plus-right";
import { type Accessor, createEffect, createSignal, For, Show } from "solid-js";
import {
  getColumnVisibilityMenuCategories,
  resetColumnVisibility,
  setCategoryVisibility,
  setColumnVisibility,
  type VisibilityCheckState,
  type VisibilityGridColumn,
} from "../../../../lib/datagrid-column-visibility";
import { DropdownMenu, DropdownMenuSeparator } from "../../../ui/dropdown-menu";
import { ScrollArea } from "../../../ui/scroll-area";
import { TOOLBAR_BUTTON_CLASS } from "../../../ui/toolbar-button";

interface ColumnVisibilityMenuProps {
  scope: string;
  columns:
    | readonly VisibilityGridColumn[]
    | Accessor<readonly VisibilityGridColumn[]>;
  placement?: "above" | "below";
}

interface TriStateCheckboxProps {
  state: VisibilityCheckState;
  label: string;
  onToggle: () => void;
}

interface ColumnCheckboxProps {
  checked: boolean;
  label: string;
  onToggle: () => void;
}

function ColumnCheckbox(props: ColumnCheckboxProps) {
  let inputRef: HTMLInputElement | undefined;

  return (
    <label
      class="flex cursor-pointer items-center gap-2 text-xs text-neutral-400"
      onPointerDown={(event) => {
        if (event.target === inputRef) return;
        event.preventDefault();
      }}
      onPointerUp={(event) => {
        if (event.target === inputRef) return;
        event.preventDefault();
        props.onToggle();
      }}
    >
      <input
        ref={inputRef}
        type="checkbox"
        checked={props.checked}
        onChange={props.onToggle}
        class="size-3.5 accent-blue-500"
      />
      <span class="truncate">{props.label}</span>
    </label>
  );
}

function TriStateCheckbox(props: TriStateCheckboxProps) {
  let inputRef: HTMLInputElement | undefined;

  createEffect(() => {
    if (inputRef) {
      inputRef.indeterminate = props.state === "dash";
    }
  });

  return (
    <label
      class="flex cursor-pointer items-center gap-2 text-xs text-neutral-200"
      onPointerDown={(event) => {
        if (event.target !== inputRef) {
          event.preventDefault();
        }
      }}
      onPointerUp={(event) => {
        if (event.target === inputRef) return;
        event.preventDefault();
        props.onToggle();
      }}
    >
      <input
        ref={inputRef}
        type="checkbox"
        checked={props.state === "activated"}
        aria-checked={props.state === "dash" ? "mixed" : undefined}
        onChange={props.onToggle}
        class="size-3.5 accent-blue-500"
      />
      <span class="truncate">{props.label}</span>
    </label>
  );
}

export default function ColumnVisibilityMenu(props: ColumnVisibilityMenuProps) {
  const [isOpen, setIsOpen] = createSignal(false);
  const columns = () =>
    typeof props.columns === "function" ? props.columns() : props.columns;
  const categories = () => {
    if (!isOpen()) return [];
    return getColumnVisibilityMenuCategories(columns(), props.scope);
  };

  const handleCategoryToggle = (
    category: ReturnType<typeof categories>[number],
  ) => {
    const currentCategory = getColumnVisibilityMenuCategories(
      columns(),
      props.scope,
    ).find((current) => current.id === category.id);
    const nextVisible = currentCategory?.state !== "activated";
    setCategoryVisibility(props.scope, columns(), category.id, nextVisible);
  };

  const handleColumnToggle = (columnId: string) => {
    const currentColumn = getColumnVisibilityMenuCategories(
      columns(),
      props.scope,
    )
      .flatMap((category) => category.groups)
      .flatMap((group) => group.columns)
      .find((column) => column.id === columnId);
    const nextVisible = !(currentColumn?.visible ?? true);
    setColumnVisibility(props.scope, columnId, nextVisible);
  };

  /** Sets every hideable column visible, including default-hidden columns. */
  const handleShowAll = () => {
    for (const column of columns()) {
      if (column.hideable !== true || column.id === undefined) continue;
      setColumnVisibility(props.scope, String(column.id), true);
    }
  };

  /** Restores the column visibility settings for this table to defaults. */
  const handleReset = () => {
    resetColumnVisibility(props.scope);
  };

  return (
    <DropdownMenu
      placement={props.placement ?? "below"}
      align="end"
      triggerLabel="Column visibility"
      onOpenChange={setIsOpen}
      trigger={
        <span class={TOOLBAR_BUTTON_CLASS}>
          <ColumnsPlusRightIcon class="size-5" aria-hidden />
        </span>
      }
    >
      <ScrollArea
        class="max-h-96 w-72"
        viewportClass="py-1"
        viewportProps={{
          "data-menu-kind": "column-visibility",
          role: "region",
          "aria-label": "Column visibility options",
          tabIndex: 0,
        }}
      >
        <div class="flex items-center justify-between gap-2 px-3 py-2">
          <span class="text-xs font-medium uppercase tracking-wide text-neutral-400">
            Columns
          </span>
          <div class="flex items-center gap-2">
            <button
              type="button"
              class="text-xs text-blue-300 hover:text-blue-200"
              onClick={handleShowAll}
            >
              Show all
            </button>
            <button
              type="button"
              class="text-xs text-blue-300 hover:text-blue-200"
              onClick={handleReset}
            >
              Reset
            </button>
          </div>
        </div>
        <DropdownMenuSeparator />
        <Show
          when={categories().length > 0}
          fallback={
            <div class="px-3 py-2 text-xs text-neutral-500">
              No hideable columns
            </div>
          }
        >
          <For each={categories()}>
            {(category) => (
              <div class="px-3 py-2" data-category={category.id}>
                <TriStateCheckbox
                  state={category.state}
                  label={category.label}
                  onToggle={() => handleCategoryToggle(category)}
                />
                <div class="mt-2 space-y-2 border-l border-neutral-700 pl-3">
                  <For each={category.groups}>
                    {(group) => (
                      <div data-column-group={group.id}>
                        <Show
                          when={group.columns.length > 1}
                          fallback={
                            <For each={group.columns}>
                              {(column) => (
                                <ColumnCheckbox
                                  checked={column.visible}
                                  label={group.label}
                                  onToggle={() => handleColumnToggle(column.id)}
                                />
                              )}
                            </For>
                          }
                        >
                          <div class="mb-1 text-xs font-medium text-neutral-300">
                            {group.label}
                          </div>
                          <div class="space-y-1">
                            <For each={group.columns}>
                              {(column) => (
                                <ColumnCheckbox
                                  checked={column.visible}
                                  label={column.label}
                                  onToggle={() => handleColumnToggle(column.id)}
                                />
                              )}
                            </For>
                          </div>
                        </Show>
                      </div>
                    )}
                  </For>
                </div>
              </div>
            )}
          </For>
        </Show>
      </ScrollArea>
    </DropdownMenu>
  );
}
