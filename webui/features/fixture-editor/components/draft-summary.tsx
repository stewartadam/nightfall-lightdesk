// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { ArrowLeftIcon } from "@squidlab/phosphor-solid/arrow-left";
import { TrashIcon } from "@squidlab/phosphor-solid/trash";
import { For, Show } from "solid-js";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/visual-language/button";
import * as types from "../../../types";
import { draftOriginLabel } from "../model/start-page";

interface DraftSummaryProps {
  draft: types.FixtureDraftView;
  /** Disables Discard while an editor command runs. */
  busy: boolean;
  onBack: () => void;
  onDiscard: () => void;
}

/**
 * Shows one draft's names, modes and problems. It is read-only: the editing
 * controls build on this page.
 */
export default function DraftSummary(props: DraftSummaryProps) {
  return (
    <div
      class="mx-auto flex w-full max-w-4xl flex-col gap-6 p-6"
      data-testid="fixture-draft-summary"
    >
      <div class="flex items-center gap-3">
        <Button
          size="icon-compact"
          variant="subtle"
          tooltip="Back to the start page"
          aria-label="Back to the start page"
          onClick={() => props.onBack()}
        >
          <ArrowLeftIcon class="size-4" aria-hidden />
        </Button>
        <div class="flex min-w-0 flex-1 flex-col">
          <h2 class="truncate text-lg font-semibold">
            {props.draft.info.manufacturer} {props.draft.info.name}
          </h2>
          <span class="text-xs text-neutral-400">
            {draftOriginLabel(props.draft.origin)}
            <Show when={props.draft.file_name}>
              {(name) => <> · saves to {name()}</>}
            </Show>
          </span>
        </div>
        <Show when={props.draft.dirty}>
          <Badge tone="info">Unsaved</Badge>
        </Show>
        <Button
          size="compact"
          variant="danger"
          disabled={props.busy}
          onClick={() => props.onDiscard()}
        >
          <TrashIcon class="size-4" aria-hidden />
          Discard
        </Button>
      </div>

      <section class="flex flex-col gap-2">
        <h3 class="text-sm font-semibold text-neutral-200">Modes</h3>
        <ul class="flex flex-col divide-y divide-neutral-800 rounded-md border border-neutral-800">
          <For each={props.draft.modes}>
            {(mode) => (
              <li class="flex flex-col gap-1 px-3 py-2">
                <div class="flex items-center gap-2">
                  <span class="text-sm font-medium">{mode.name}</span>
                  <Badge mono>{mode.footprint} ch</Badge>
                </div>
                <span class="text-xs text-neutral-400">
                  {mode.channels.map((channel) => channel.name).join(", ") ||
                    "No channels yet"}
                </span>
              </li>
            )}
          </For>
        </ul>
      </section>

      <section class="flex flex-col gap-2">
        <h3 class="text-sm font-semibold text-neutral-200">Problems</h3>
        <Show
          when={props.draft.problems.length > 0}
          fallback={
            <p class="text-sm text-neutral-400">
              No problems found. This draft can be saved.
            </p>
          }
        >
          <ul class="flex flex-col gap-1" data-testid="fixture-draft-problems">
            <For each={props.draft.problems}>
              {(problem) => (
                <li class="flex items-start gap-2 text-sm">
                  <Badge
                    tone={
                      problem.severity === types.ProblemSeverity.Error
                        ? "danger"
                        : "warning"
                    }
                    uppercase
                    size="xs"
                  >
                    {problem.severity}
                  </Badge>
                  <span>{problem.message}</span>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </section>

      <Show when={props.draft.lost_content.length > 0}>
        <section class="flex flex-col gap-2">
          <h3 class="text-sm font-semibold text-neutral-200">
            Not kept on save
          </h3>
          <p class="text-xs text-neutral-400">
            The editor does not support these parts of the source file yet, so
            saving drops them.
          </p>
          <ul class="list-disc pl-5 text-xs text-neutral-300">
            <For each={props.draft.lost_content}>
              {(path) => <li class="font-mono">{path}</li>}
            </For>
          </ul>
        </section>
      </Show>
    </div>
  );
}
