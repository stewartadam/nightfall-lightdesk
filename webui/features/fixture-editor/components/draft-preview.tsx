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
  on,
  onCleanup,
  Show,
} from "solid-js";
import { NativeSelect } from "../../../components/ui/form-controls";
import { getLogger } from "../../../lib/logger";
import type * as types from "../../../types";
import { FixturePreview, profileToPreviewFixture } from "../../visualizer";
import { previewDraft } from "../services/fixture-editor-client";
import { useDraftEditing } from "./draft-context";

const log = getLogger(import.meta.url);

/** Time to wait after a change before asking for a new render, so a burst of edits asks once. */
const PREVIEW_DELAY_MS = 150;

/** One render the preview asks the engine for. */
interface PreviewRequest {
  draftId: types.DraftId;
  version: number;
  mode: string | undefined;
}

/** A render the engine answered, with the request it answers. */
interface DrawnPreview {
  request: PreviewRequest;
  profile: types.GetFixtureProfileResponse;
}

/**
 * Shows the draft in 3D, the way the fixture library previews a fixture, and redraws it after
 * every change. The view keeps its angle while one mode of one draft is edited, and is framed
 * again when another mode or draft is shown. A mode picker appears when the draft has more than
 * one mode. While a new render is on its way the last one stays on screen, and a draft that
 * cannot be drawn says why.
 */
export default function DraftPreview() {
  const editing = useDraftEditing();
  /** The draft's latest view. */
  const draft = () => editing.draft();
  /** Name of the mode the user picked, or null for the draft's first mode. */
  const [chosenMode, setChosenMode] = createSignal<string | null>(null);
  const [drawn, setDrawn] = createSignal<DrawnPreview | null>(null);
  const [failure, setFailure] = createSignal<string | null>(null);

  /** Name of the mode to draw: the picked one while it exists, otherwise the first. */
  const modeName = createMemo(() => {
    const modes = draft().modes;
    const chosen = chosenMode();
    return chosen !== null && modes.some((mode) => mode.name === chosen)
      ? chosen
      : modes[0]?.name;
  });

  /** Describes the render the draft and mode on screen need. */
  const wantedRender = (): PreviewRequest => ({
    draftId: draft().draft_id,
    version: draft().version,
    mode: modeName(),
  });

  /** The render the preview needs now; it changes only when the draft, its version or the mode does. */
  const request = createMemo<PreviewRequest>(wantedRender, wantedRender(), {
    equals: (previous, next) =>
      previous.draftId === next.draftId &&
      previous.version === next.version &&
      previous.mode === next.mode,
  });

  /** Starts over when another draft is shown, so nothing of the previous draft lingers. */
  createEffect(
    on(
      () => draft().draft_id,
      () => {
        setChosenMode(null);
        setDrawn(null);
        setFailure(null);
      },
      { defer: true },
    ),
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));

  /** Asks for a new render after each change, keeping only the answer to the newest request. */
  createEffect(
    on(request, (wanted) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        previewDraft(wanted.draftId, wanted.mode)
          .then((profile) => {
            if (request() !== wanted) return;
            setFailure(null);
            setDrawn({ request: wanted, profile });
          })
          .catch((cause: unknown) => {
            if (request() !== wanted) return;
            log.debug("Draft preview failed", { error: cause });
            setFailure(cause instanceof Error ? cause.message : String(cause));
          });
      }, PREVIEW_DELAY_MS);
    }),
  );

  /** Previous render, to tell an edit of the same mode from a switch to another mode or draft. */
  let shownBefore: PreviewRequest | null = null;

  /** Whether the latest render shows the same draft and mode as the one before it. */
  const sameSubject = createMemo(() => {
    const current = drawn()?.request ?? null;
    const same =
      current !== null &&
      shownBefore !== null &&
      current.draftId === shownBefore.draftId &&
      current.mode === shownBefore.mode;
    shownBefore = current;
    return same;
  });

  /** The fixture as the 3D preview draws it, from the latest render. */
  const previewFixture = createMemo(() =>
    profileToPreviewFixture(drawn()?.profile ?? null),
  );

  return (
    <section
      class="flex flex-col gap-2"
      aria-label="Fixture preview"
      data-testid="fixture-draft-preview"
      data-state={failure() ? "failed" : previewFixture() ? "ready" : "loading"}
      data-version={drawn()?.request.version}
    >
      <Show when={draft().modes.length > 1}>
        <label class="flex items-center gap-2 text-xs text-neutral-400">
          <span>Mode</span>
          <NativeSelect
            density="compact"
            class="min-w-0 flex-1"
            value={modeName() ?? ""}
            onInput={(event) => setChosenMode(event.currentTarget.value)}
          >
            <For each={draft().modes}>
              {(mode) => <option value={mode.name}>{mode.name}</option>}
            </For>
          </NativeSelect>
        </label>
      </Show>
      <div class="relative h-64 overflow-hidden rounded-md border border-neutral-800 bg-neutral-950 lg:h-80">
        <FixturePreview
          class="h-full w-full"
          fixture={previewFixture()}
          keepCamera={sameSubject()}
        />
        <Show when={failure()}>
          {(message) => (
            <p
              role="status"
              class="absolute inset-x-0 bottom-0 bg-neutral-950/85 px-3 py-2 text-xs text-neutral-300"
            >
              Cannot draw this draft yet: {message()}
            </p>
          )}
        </Show>
      </div>
    </section>
  );
}
