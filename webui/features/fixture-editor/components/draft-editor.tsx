// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { ArrowLeftIcon } from "@squidlab/phosphor-solid/arrow-left";
import { ArrowUUpLeftIcon } from "@squidlab/phosphor-solid/arrow-u-up-left";
import { ArrowUUpRightIcon } from "@squidlab/phosphor-solid/arrow-u-up-right";
import { FloppyDiskIcon } from "@squidlab/phosphor-solid/floppy-disk";
import { TrashIcon } from "@squidlab/phosphor-solid/trash";
import {
  createSignal,
  createUniqueId,
  For,
  Match,
  Show,
  Switch,
} from "solid-js";
import { Badge } from "../../../components/ui/badge";
import { SegmentedTabs } from "../../../components/ui/segmented-tabs";
import { Button } from "../../../components/ui/visual-language/button";
import * as types from "../../../types";
import { problemLocation } from "../model/draft-editing";
import { draftOriginLabel } from "../model/start-page";
import type { SaveOptions } from "../services/fixture-editor-client";
import { type DraftEditing, DraftEditingContext } from "./draft-context";
import InfoSection from "./info-section";
import ModesSection from "./modes-section";
import SaveDialog from "./save-dialog";
import WheelsSection from "./wheels-section";

/** Parts of a draft the editor shows one at a time. */
type EditorTab = "info" | "modes" | "wheels";

interface DraftEditorProps {
  /** The draft on screen and the way to change it, shared with every section. */
  editing: DraftEditing;
  /** Disables the header actions while an editor command runs. */
  busy: boolean;
  onBack: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onSave: (options: SaveOptions) => Promise<void>;
  onDiscard: () => void;
}

/** Lists what keeps the draft from saving or may make it behave unexpectedly. */
function ProblemList(props: { draft: types.FixtureDraftView }) {
  return (
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
                <span>
                  <Show when={problemLocation(props.draft, problem)}>
                    {(location) => (
                      <span class="text-neutral-400">{location()}: </span>
                    )}
                  </Show>
                  {problem.message}
                </span>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </section>
  );
}

/** Lists the parts of a source file the editor cannot keep, which a save drops. */
function LostContent(props: { paths: readonly string[] }) {
  return (
    <Show when={props.paths.length > 0}>
      <section class="flex flex-col gap-2">
        <h3 class="text-sm font-semibold text-neutral-200">Not kept on save</h3>
        <p class="text-xs text-neutral-400">
          The editor does not support these parts of the source file yet, so
          saving drops them.
        </p>
        <ul class="list-disc pl-5 text-xs text-neutral-300">
          <For each={props.paths}>
            {(path) => <li class="font-mono">{path}</li>}
          </For>
        </ul>
      </section>
    </Show>
  );
}

/**
 * The editing page of one draft: a header with undo, redo, save and discard,
 * then the fixture's names, modes or wheels, then what is wrong with it.
 * Every change is sent to the backend at once, so other windows showing the
 * same draft follow along.
 */
export default function DraftEditor(props: DraftEditorProps) {
  const tabsId = createUniqueId();
  const contentId = createUniqueId();
  const [tab, setTab] = createSignal<EditorTab>("modes");
  const [saving, setSaving] = createSignal(false);
  /** The draft's latest view. */
  const draft = () => props.editing.draft();

  return (
    <DraftEditingContext.Provider value={props.editing}>
      <div
        class="mx-auto flex w-full max-w-5xl flex-col gap-6 p-6"
        data-testid="fixture-draft-editor"
      >
        <div class="flex flex-wrap items-center gap-3">
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
              {draft().info.manufacturer} {draft().info.name}
            </h2>
            <span class="text-xs text-neutral-400">
              {draftOriginLabel(draft().origin)}
              <Show when={draft().file_name}>
                {(name) => <> · saves to {name()}</>}
              </Show>
            </span>
          </div>
          <Show when={draft().dirty}>
            <Badge tone="info">Unsaved</Badge>
          </Show>
          <Button
            size="icon-compact"
            variant="subtle"
            aria-label="Undo"
            tooltip="Undo"
            disabled={props.busy || !draft().can_undo}
            onClick={() => props.onUndo()}
          >
            <ArrowUUpLeftIcon class="size-4" aria-hidden />
          </Button>
          <Button
            size="icon-compact"
            variant="subtle"
            aria-label="Redo"
            tooltip="Redo"
            disabled={props.busy || !draft().can_redo}
            onClick={() => props.onRedo()}
          >
            <ArrowUUpRightIcon class="size-4" aria-hidden />
          </Button>
          <Button
            size="compact"
            variant="primary"
            disabled={props.busy}
            onClick={() => setSaving(true)}
          >
            <FloppyDiskIcon class="size-4" aria-hidden />
            Save
          </Button>
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

        <SegmentedTabs
          id={tabsId}
          label="Draft sections"
          contentId={contentId}
          options={[
            { key: "info", label: "Fixture" },
            { key: "modes", label: "Modes" },
            { key: "wheels", label: "Wheels" },
          ]}
          value={tab()}
          onChange={setTab}
        />
        <div
          id={contentId}
          role="tabpanel"
          aria-labelledby={`${tabsId}-${tab()}`}
        >
          <Switch>
            <Match when={tab() === "info"}>
              <InfoSection />
            </Match>
            <Match when={tab() === "modes"}>
              <ModesSection />
            </Match>
            <Match when={tab() === "wheels"}>
              <WheelsSection />
            </Match>
          </Switch>
        </div>

        <ProblemList draft={draft()} />
        <LostContent paths={draft().lost_content} />
      </div>
      <SaveDialog
        isOpen={saving()}
        draft={draft()}
        onSave={props.onSave}
        onClose={() => setSaving(false)}
      />
    </DraftEditingContext.Provider>
  );
}
