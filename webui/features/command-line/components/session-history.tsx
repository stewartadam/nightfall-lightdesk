// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import {
  Checkbox,
  Input,
  NativeSelect,
} from "../../../components/ui/form-controls";
import { Button } from "../../../components/ui/visual-language/button";
import { writeClipboardText } from "../../../lib/clipboard";
import { commandOutputValue } from "../../../lib/command-result";
import { commandClient } from "../../../lib/engine-commands";
import { getLogger } from "../../../lib/logger";
import type {
  SessionHistoryCommand,
  SessionHistoryEntry,
  SessionHistoryPage,
} from "../../../types";
import {
  filterSessionHistory,
  mergeSessionHistory,
  sessionHistorySources,
  sessionHistoryTime,
} from "../model/session-history";

const log = getLogger(import.meta.url);

/** How often the open history asks the engine for new entries. */
const POLL_INTERVAL_MS = 1000;

/** Asks the engine for the entries changed after revision `after`, or all of them. */
async function readSessionHistory(
  after: number | undefined,
): Promise<SessionHistoryPage | undefined> {
  const command: SessionHistoryCommand = {
    type: "Read",
    data: { after },
  };
  const result = await commandClient.invoke("SessionHistoryCommand", command);
  return commandOutputValue(result) as SessionHistoryPage | undefined;
}

/** Describes how a command ended, or says it still runs; events have no outcome. */
function outcomeLabel(entry: SessionHistoryEntry): string | undefined {
  if (`${entry.kind}` === "Event") return undefined;
  if (!entry.outcome) return "running";
  if (entry.outcome.succeeded) return "done";
  return entry.outcome.message ? `failed: ${entry.outcome.message}` : "failed";
}

/**
 * Lists every command the engine accepted in this session and the events domains recorded, newest
 * first, with filters and a JSON copy for bug reports. Reads the engine's history only while
 * shown.
 */
export function SessionHistory() {
  const [entries, setEntries] = createSignal<SessionHistoryEntry[]>([]);
  const [source, setSource] = createSignal("");
  const [failedOnly, setFailedOnly] = createSignal(false);
  const [text, setText] = createSignal("");
  const [copied, setCopied] = createSignal(false);
  let revision: number | undefined;
  let session: number | undefined;
  let reading = false;

  /** Reads what changed since the last read and merges it, starting over when the engine restarted. */
  const poll = async () => {
    if (reading) return;
    reading = true;
    try {
      let page = await readSessionHistory(revision);
      if (page && session !== undefined && page.session !== session) {
        // A different engine process keeps a history of its own, so start over with it.
        setEntries([]);
        page = await readSessionHistory(undefined);
      }
      if (!page) return;
      const next = page;
      revision = next.revision;
      session = next.session;
      if (next.entries.length > 0 || entries().length > 0) {
        setEntries((current) => mergeSessionHistory(current, next));
      }
    } catch (error) {
      log.debug("Could not read the session history", { error });
    } finally {
      reading = false;
    }
  };

  onMount(() => {
    void poll();
    const timer = setInterval(() => void poll(), POLL_INTERVAL_MS);
    onCleanup(() => clearInterval(timer));
  });

  /** Sources present in the history, for the source filter. */
  const sources = createMemo(() => sessionHistorySources(entries()));
  /** Clears the source filter once its source leaves the history, so the list never hides everything. */
  createEffect(() => {
    if (source() && !sources().includes(source())) setSource("");
  });
  /** Entries matching the filters, newest first. */
  const shown = createMemo(() =>
    filterSessionHistory(entries(), {
      source: source(),
      failedOnly: failedOnly(),
      text: text(),
    }).reverse(),
  );

  /** Copies the shown entries as JSON, oldest first, for a bug report. */
  const copyJson = async () => {
    try {
      await writeClipboardText(JSON.stringify([...shown()].reverse(), null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (error) {
      log.warn("Could not copy the session history", { error });
    }
  };

  return (
    <div class="flex min-h-0 flex-1 flex-col" data-testid="session-history">
      <div class="flex flex-wrap items-center gap-2 border-b border-neutral-800 px-2 py-1 text-xs">
        <NativeSelect
          style={{ width: "auto" }}
          value={source()}
          onInput={(event) => setSource(event.currentTarget.value)}
          aria-label="Source"
          data-testid="session-history-source"
        >
          <option value="">All sources</option>
          <For each={sources()}>
            {(name) => <option value={name}>{name}</option>}
          </For>
        </NativeSelect>
        <label class="flex items-center gap-1 text-neutral-300">
          <Checkbox
            checked={failedOnly()}
            onInput={(event) => setFailedOnly(event.currentTarget.checked)}
          />
          Failed only
        </label>
        <Input
          density="compact"
          class="min-w-0 flex-1"
          placeholder="Filter"
          aria-label="Filter the session history"
          value={text()}
          onInput={(event) => setText(event.currentTarget.value)}
        />
        <Button
          size="compact"
          type="button"
          onClick={() => void copyJson()}
          data-testid="session-history-copy"
        >
          {copied() ? "Copied" : "Copy as JSON"}
        </Button>
      </div>
      <div class="min-h-0 flex-1 overflow-auto p-2 font-mono text-xs">
        <Show
          when={shown().length > 0}
          fallback={
            <p class="text-neutral-500">
              {entries().length > 0
                ? "No entries match the filters."
                : "Nothing happened in this session yet."}
            </p>
          }
        >
          <ol class="space-y-0.5">
            <For each={shown()}>
              {(entry) => {
                const outcome = outcomeLabel(entry);
                return (
                  <li
                    class="rounded px-1 py-0.5 hover:bg-neutral-900"
                    data-testid="session-history-entry"
                    data-source={entry.source}
                    data-forwarded={entry.forwarded_sequence ?? undefined}
                  >
                    <div class="flex flex-wrap items-baseline gap-x-2">
                      <span class="text-neutral-500">
                        {sessionHistoryTime(entry.at_ms)}
                      </span>
                      <span class="text-neutral-400">{entry.source}</span>
                      <Show when={entry.module !== entry.source}>
                        <span class="text-sky-300">{entry.module}</span>
                      </Show>
                      <span class="ml-auto flex gap-2">
                        <Show when={entry.forwarded_sequence}>
                          {(sequence) => (
                            <span
                              class="text-violet-300"
                              title="Number in the primary's forwarded commands"
                            >
                              #{sequence()}
                            </span>
                          )}
                        </Show>
                        <Show when={outcome}>
                          <span
                            class={
                              entry.outcome?.succeeded === false
                                ? "text-red-400"
                                : entry.outcome
                                  ? "text-emerald-400"
                                  : "text-amber-300"
                            }
                          >
                            {outcome}
                          </span>
                        </Show>
                      </span>
                    </div>
                    <div class="text-neutral-100 [overflow-wrap:anywhere]">
                      {entry.summary}
                    </div>
                  </li>
                );
              }}
            </For>
          </ol>
        </Show>
      </div>
    </div>
  );
}
