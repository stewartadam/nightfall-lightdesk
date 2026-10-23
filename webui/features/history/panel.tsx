// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { ArrowUUpLeftIcon } from "@squidlab/phosphor-solid/arrow-u-up-left";
import { ArrowUUpRightIcon } from "@squidlab/phosphor-solid/arrow-u-up-right";
import { createMemo, For, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { Badge } from "../../components/ui/badge";
import { EmptyState } from "../../components/ui/empty-state";
import type { AppIcon } from "../../components/ui/icon";
import type { BasePanelComponentProps } from "../../lib/panel-registry";
import { undoState } from "../../state/appStores";
import type * as types from "../../types";

type StackKind = "undo" | "redo";

interface StackSectionProps {
  title: string;
  icon: AppIcon;
  emptyText: string;
  entries: types.UndoStackEntryMessage[];
  kind: StackKind;
}

interface StackEntryProps {
  entry: types.UndoStackEntryMessage;
  kind: StackKind;
}

/** Returns a compact identifier that keeps UUID metadata scannable in dense rows. */
function shortId(value: string): string {
  if (value.length <= 8) return value;
  return value.slice(0, 8);
}

/** Builds the stable DOM key for one stack entry. */
function stackEntryKey(entry: types.UndoStackEntryMessage): string {
  return `${entry.undo_id}-${entry.order}`;
}

/** Renders one command description inside a grouped undo operation. */
function CommandDescription(props: { description: string; index: number }) {
  return (
    <li class="flex items-start gap-2 text-xs text-neutral-300">
      <Badge appearance="soft" mono class="mt-0.5 min-w-5 justify-center">
        {props.index + 1}
      </Badge>
      <span class="min-w-0 break-words">{props.description}</span>
    </li>
  );
}

/** Renders one undo or redo group with ordering and correlation metadata. */
function StackEntry(props: StackEntryProps) {
  const actionLabel = () => (props.kind === "undo" ? "Undo" : "Redo");
  const isTop = () => props.entry.order === 0;

  return (
    <li
      class="rounded-md border border-neutral-700 bg-neutral-900 p-3 shadow-sm"
      data-stack-kind={props.kind}
      data-stack-key={stackEntryKey(props.entry)}
      data-stack-order={props.entry.order}
      data-stack-undo={props.entry.undo_id}
    >
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-2">
            <Show when={isTop()}>
              <Badge
                tone="info"
                appearance="soft"
                uppercase
                data-stack-top-marker={props.kind}
              >
                Top
              </Badge>
            </Show>
            <span class="font-medium text-neutral-100">
              {props.entry.description}
            </span>
          </div>
          <div class="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-neutral-400">
            <span>
              {actionLabel()} order {props.entry.order + 1}
            </span>
            <span>{props.entry.entry_count} command(s)</span>
            <span class="font-mono">undo {shortId(props.entry.undo_id)}</span>
          </div>
        </div>
      </div>

      <Show when={props.entry.entry_descriptions.length > 0}>
        <ol class="mt-3 space-y-1">
          <For each={props.entry.entry_descriptions}>
            {(description, index) => (
              <CommandDescription description={description} index={index()} />
            )}
          </For>
        </ol>
      </Show>

      <Show when={props.entry.correlation_ids.length > 0}>
        <div class="mt-3 flex flex-wrap gap-1.5">
          <For each={props.entry.correlation_ids}>
            {(correlationId) => (
              <Badge appearance="soft" mono>
                {shortId(correlationId)}
              </Badge>
            )}
          </For>
        </div>
      </Show>
    </li>
  );
}

/** Renders a complete undo or redo stack section in execution order. */
function StackSection(props: StackSectionProps) {
  return (
    <section class="min-h-0" aria-label={props.title}>
      <div class="mb-2 flex items-center justify-between gap-3">
        <h2 class="flex items-center gap-2 text-sm font-semibold text-neutral-100">
          <Dynamic component={props.icon} class="size-4" aria-hidden />
          {props.title}
        </h2>
        <Badge size="md" mono data-stack-count={props.kind}>
          {props.entries.length}
        </Badge>
      </div>
      <Show
        when={props.entries.length > 0}
        fallback={<EmptyState variant="dashed" title={props.emptyText} />}
      >
        <ol class="space-y-2">
          <For each={props.entries} fallback={null}>
            {(entry) => <StackEntry entry={entry} kind={props.kind} />}
          </For>
        </ol>
      </Show>
    </section>
  );
}

/** Displays current undo and redo stack details for operators and developers. */
export default function UndoStackPanel(_props: BasePanelComponentProps) {
  const undo = useStore(undoState);

  /** Undo groups in the order they will be applied. */
  const undoEntries = createMemo(() => undo().undo_stack);

  /** Redo groups in the order they will be applied. */
  const redoEntries = createMemo(() => undo().redo_stack);

  return (
    <div class="h-full w-full overflow-auto bg-neutral-950 p-4 text-neutral-100">
      <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 class="text-base font-semibold">Undo Stack</h1>
          <p class="mt-1 text-xs text-neutral-400">
            {undo().undo_depth} undo / {undo().redo_depth} redo
          </p>
        </div>
        <div class="flex items-center gap-2 text-xs">
          <span
            class="rounded border border-neutral-700 bg-neutral-900 px-2 py-1"
            data-stack-next="undo"
          >
            Undo: {undo().undo_description ?? "empty"}
          </span>
          <span
            class="rounded border border-neutral-700 bg-neutral-900 px-2 py-1"
            data-stack-next="redo"
          >
            Redo: {undo().redo_description ?? "empty"}
          </span>
        </div>
      </div>

      <div class="grid gap-4 lg:grid-cols-2">
        <StackSection
          title="Undo"
          icon={ArrowUUpLeftIcon}
          emptyText="Undo stack is empty"
          entries={undoEntries()}
          kind="undo"
        />
        <StackSection
          title="Redo"
          icon={ArrowUUpRightIcon}
          emptyText="Redo stack is empty"
          entries={redoEntries()}
          kind="redo"
        />
      </div>
    </div>
  );
}
