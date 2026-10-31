// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { PencilRulerIcon } from "@squidlab/phosphor-solid/pencil-ruler";
import { createEffect, createMemo, createSignal, on, Show } from "solid-js";
import { EmptyState } from "../../../components/ui/empty-state";
import { Button } from "../../../components/ui/visual-language/button";
import DeleteConfirmModal from "../../../components/widgets/delete-confirm-dialog";
import {
  connectionStatus,
  EngineRuntimeStatus,
} from "../../../lib/engine-runtime";
import { getLogger } from "../../../lib/logger";
import { fixtureDrafts } from "../../../state/appStores";
import type * as types from "../../../types";
import {
  discardDraft,
  openDraft,
  refreshDrafts,
} from "../services/fixture-editor-client";
import DraftSummary from "./draft-summary";
import StartPage from "./start-page";

const log = getLogger(import.meta.url);

/** Returns the operator-facing message of a failed editor command. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Root of the fixture editor window. It lists the drafts open on the backend,
 * starts new ones and shows the chosen draft. Drafts belong to the backend, so
 * closing this window or reconnecting loses nothing.
 */
export default function FixtureEditorWindow() {
  const drafts = useStore(fixtureDrafts);
  const [openId, setOpenId] = createSignal<types.DraftId | null>(null);
  const [discardId, setDiscardId] = createSignal<types.DraftId | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  /** Whether the engine connection is open, which every editor command needs. */
  const connected = () => connectionStatus() === EngineRuntimeStatus.Connected;

  /** Returns the current view of an open draft, or none once any window closed it. */
  const draftById = (id: types.DraftId | null) =>
    id === null ? undefined : drafts().find((draft) => draft.draft_id === id);

  /** The draft on screen, or none when it was discarded from any window. */
  const openView = createMemo(() => draftById(openId()));

  /** The draft the discard confirmation asks about, kept current with other windows' changes. */
  const pendingDiscard = createMemo(() => draftById(discardId()));

  /** Withdraws the discard confirmation once its draft is closed elsewhere. */
  createEffect(() => {
    if (discardId() !== null && connected() && !pendingDiscard())
      setDiscardId(null);
  });

  /** Reloads the draft list each time the connection opens, since broadcasts sent while away were missed. */
  createEffect(
    on(connected, (isConnected) => {
      if (!isConnected) return;
      refreshDrafts().catch((cause: unknown) => {
        log.error("Could not list fixture drafts", { error: cause });
        setError(errorMessage(cause));
      });
    }),
  );

  /** Returns to the start page when the open draft is discarded, here or in another window. */
  createEffect(() => {
    if (openId() !== null && connected() && !openView()) setOpenId(null);
  });

  /** Runs one editor command, showing its failure above the page. */
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (cause) {
      log.warn("Fixture editor command failed", { error: cause });
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  /** Opens a new draft and shows it. */
  const start = (source: types.DraftSource) =>
    run(async () => {
      const view = await openDraft(source);
      setOpenId(view.draft_id);
    });

  /** Discards a draft, asking first when it holds unsaved changes. Ignored while a command runs. */
  const requestDiscard = (draft: types.FixtureDraftView) => {
    if (busy()) return;
    if (draft.dirty) setDiscardId(draft.draft_id);
    else void run(() => discardDraft(draft.draft_id));
  };

  /** Discards the draft the confirmation asked about, if it is still open. */
  const confirmDiscard = () => {
    const draft = pendingDiscard();
    setDiscardId(null);
    if (draft) void run(() => discardDraft(draft.draft_id));
  };

  return (
    <div
      class="flex h-full min-h-0 w-full flex-col bg-neutral-900 text-neutral-100"
      data-testid="fixture-editor-window"
    >
      <header class="flex items-center gap-2 border-b border-neutral-800 px-4 py-3">
        <PencilRulerIcon class="size-5 text-neutral-400" aria-hidden />
        <h1 class="text-base font-semibold">Fixture Editor</h1>
      </header>
      <Show when={error()}>
        {(message) => (
          <div
            role="alert"
            class="flex items-center gap-3 border-b border-red-900/60 bg-red-950/40 px-4 py-2 text-sm text-red-200"
          >
            <span class="min-w-0 flex-1">{message()}</span>
            <Button
              size="compact"
              variant="subtle"
              onClick={() => setError(null)}
            >
              Dismiss
            </Button>
          </div>
        )}
      </Show>
      <main class="min-h-0 flex-1 overflow-y-auto">
        <Show
          when={connected()}
          fallback={
            <EmptyState
              loading
              title="Connecting to Nightfall…"
              description="The editor opens once the app is reachable."
            />
          }
        >
          <Show
            when={openView()}
            fallback={
              <StartPage
                drafts={drafts()}
                busy={busy()}
                onStart={(source) => void start(source)}
                onOpen={(draft) => setOpenId(draft.draft_id)}
                onDiscard={requestDiscard}
              />
            }
          >
            {(view) => (
              <DraftSummary
                draft={view()}
                busy={busy()}
                onBack={() => setOpenId(null)}
                onDiscard={() => requestDiscard(view())}
              />
            )}
          </Show>
        </Show>
      </main>
      <DeleteConfirmModal
        isOpen={pendingDiscard() !== undefined}
        title="Discard draft?"
        message={`${pendingDiscard()?.info.name ?? "This draft"} has changes that were never saved. Discarding it loses them.`}
        confirmLabel="Discard"
        onCancel={() => setDiscardId(null)}
        onConfirm={confirmDiscard}
      />
    </div>
  );
}
