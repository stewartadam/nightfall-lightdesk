// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { CopyIcon } from "@squidlab/phosphor-solid/copy";
import { PencilSimpleIcon } from "@squidlab/phosphor-solid/pencil-simple";
import { TrashIcon } from "@squidlab/phosphor-solid/trash";
import { createMemo, createSignal, For, type JSX, Show } from "solid-js";
import { Badge } from "../../../components/ui/badge";
import { EmptyState } from "../../../components/ui/empty-state";
import { SearchField } from "../../../components/ui/search-field";
import { Button } from "../../../components/ui/visual-language/button";
import { fixtureLibrary } from "../../../state/appStores";
import type * as types from "../../../types";
import {
  DRAFT_STARTERS,
  draftOriginLabel,
  libraryEntry,
  matchingLibraryFixtures,
  problemCounts,
} from "../model/start-page";

interface StartPageProps {
  /** Drafts open on the backend, in id order. */
  drafts: readonly types.FixtureDraftView[];
  /** Disables the start actions while a command is running. */
  busy: boolean;
  onStart: (source: types.DraftSource) => void;
  onOpen: (draft: types.FixtureDraftView) => void;
  onDiscard: (draft: types.FixtureDraftView) => void;
}

/** Titled block of the start page. */
function Section(props: {
  title: string;
  description?: string;
  children: JSX.Element;
}) {
  return (
    <section class="flex flex-col gap-3">
      <div>
        <h2 class="text-sm font-semibold text-neutral-200">{props.title}</h2>
        <Show when={props.description}>
          <p class="text-xs text-neutral-400">{props.description}</p>
        </Show>
      </div>
      {props.children}
    </section>
  );
}

/** Lists one open draft with its state and the actions to reopen or discard it. */
function DraftRow(props: {
  draft: types.FixtureDraftView;
  /** Disables Discard while an editor command runs. */
  busy: boolean;
  onOpen: () => void;
  onDiscard: () => void;
}) {
  /** Errors and warnings in the draft, for its badges. */
  const counts = () => problemCounts(props.draft.problems);
  return (
    <li
      class="flex items-center gap-3 rounded-md border border-neutral-800 bg-neutral-800/50 px-3 py-2"
      data-testid="fixture-draft-row"
    >
      <button
        type="button"
        class="flex min-w-0 flex-1 flex-col items-start text-left"
        onClick={() => props.onOpen()}
      >
        <span class="truncate text-sm font-medium">
          {props.draft.info.manufacturer} {props.draft.info.name}
        </span>
        <span class="truncate text-xs text-neutral-400">
          {draftOriginLabel(props.draft.origin)}
        </span>
      </button>
      <Show when={props.draft.dirty}>
        <Badge tone="info">Unsaved</Badge>
      </Show>
      <Show when={counts().errors > 0}>
        <Badge tone="danger">
          {counts().errors} {counts().errors === 1 ? "error" : "errors"}
        </Badge>
      </Show>
      <Button size="compact" onClick={() => props.onOpen()}>
        Open
      </Button>
      <Button
        size="icon-compact"
        variant="subtle"
        tooltip="Discard draft"
        aria-label={`Discard ${props.draft.info.name}`}
        disabled={props.busy}
        onClick={() => props.onDiscard()}
      >
        <TrashIcon class="size-4" aria-hidden />
      </Button>
    </li>
  );
}

/**
 * The editor's first page: drafts still open from earlier, the templates a
 * new fixture can start from, and the library fixtures that can be edited in
 * place or copied.
 */
export default function StartPage(props: StartPageProps) {
  const library = useStore(fixtureLibrary);
  const [query, setQuery] = createSignal("");
  /** GDTF library fixtures matching the search, capped for long libraries. */
  const matches = createMemo(() => matchingLibraryFixtures(library(), query()));

  return (
    <div class="mx-auto flex w-full max-w-4xl flex-col gap-8 p-6">
      <Show when={props.drafts.length > 0}>
        <Section
          title="Open drafts"
          description="Drafts stay open until you save or discard them, even when this window closes."
        >
          <ul class="flex flex-col gap-2" data-testid="fixture-draft-list">
            <For each={props.drafts}>
              {(draft) => (
                <DraftRow
                  draft={draft}
                  busy={props.busy}
                  onOpen={() => props.onOpen(draft)}
                  onDiscard={() => props.onDiscard(draft)}
                />
              )}
            </For>
          </ul>
        </Section>
      </Show>

      <Section
        title="New fixture"
        description="Start from a generic fixture and change it to match yours."
      >
        <div class="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-2">
          <For each={DRAFT_STARTERS}>
            {(starter) => (
              <button
                type="button"
                class="flex flex-col items-start gap-1 rounded-md border border-neutral-800 bg-neutral-800/50 p-3 text-left hover:border-neutral-600 disabled:opacity-50"
                disabled={props.busy}
                data-testid={`fixture-starter-${starter.id}`}
                onClick={() => props.onStart(starter.source)}
              >
                <span class="text-sm font-medium">{starter.label}</span>
                <span class="text-xs text-neutral-400">
                  {starter.description}
                </span>
              </button>
            )}
          </For>
        </div>
      </Section>

      <Section
        title="From your library"
        description="Edit a GDTF fixture in place, or duplicate it to save a changed copy."
      >
        <SearchField
          label="Search library fixtures"
          value={query()}
          onInput={setQuery}
          class="max-w-sm"
        />
        <Show
          when={matches().fixtures.length > 0}
          fallback={
            <EmptyState
              variant="dashed"
              class="p-6"
              title={
                query()
                  ? "No GDTF fixtures match"
                  : "No GDTF fixtures in the library"
              }
              description="Only GDTF fixtures can be opened in the editor."
            />
          }
        >
          <ul
            class="flex flex-col divide-y divide-neutral-800 rounded-md border border-neutral-800"
            data-testid="fixture-editor-library"
          >
            <For each={matches().fixtures}>
              {(fixture) => (
                <li class="flex items-center gap-3 px-3 py-2">
                  <div class="flex min-w-0 flex-1 flex-col">
                    <span class="truncate text-sm">
                      {fixture.make} {fixture.model}
                    </span>
                    <span class="text-xs text-neutral-400">
                      {fixture.modes.length}{" "}
                      {fixture.modes.length === 1 ? "mode" : "modes"}
                    </span>
                  </div>
                  <Button
                    size="compact"
                    disabled={props.busy}
                    onClick={() =>
                      props.onStart({
                        type: "Edit",
                        data: libraryEntry(fixture),
                      })
                    }
                  >
                    <PencilSimpleIcon class="size-4" aria-hidden />
                    Edit
                  </Button>
                  <Button
                    size="compact"
                    disabled={props.busy}
                    onClick={() =>
                      props.onStart({
                        type: "Duplicate",
                        data: libraryEntry(fixture),
                      })
                    }
                  >
                    <CopyIcon class="size-4" aria-hidden />
                    Duplicate
                  </Button>
                </li>
              )}
            </For>
          </ul>
          <Show when={matches().hidden > 0}>
            <p class="text-xs text-neutral-400">
              {matches().hidden} more{" "}
              {matches().hidden === 1 ? "fixture matches" : "fixtures match"}.
              Refine the search to find them.
            </p>
          </Show>
        </Show>
      </Section>
    </div>
  );
}
