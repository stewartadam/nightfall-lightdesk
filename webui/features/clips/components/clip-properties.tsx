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
  Match,
  Show,
  Switch,
} from "solid-js";
import { Checkbox, Input } from "../../../components/ui/form-controls";
import { ToggleToolbarButton } from "../../../components/ui/toolbar-button";
import ObjectSelector from "../../../components/widgets/object-selector";
import { engineRuntime } from "../../../lib/engine-runtime";
import { useShallowStore } from "../../../lib/use-shallow-store";
import {
  clips,
  flows,
  fx,
  fxModules,
  runtimeCapabilities,
  sequences,
  stepFx,
} from "../../../state/appStores";
import type * as types from "../../../types";

type SourceKind = types.Source["type"];

const SOURCE_KIND_OPTIONS: Array<{ kind: SourceKind; label: string }> = [
  { kind: "Sequence", label: "Sequence" },
  { kind: "Fx", label: "FX" },
  { kind: "StepFx", label: "Step FX" },
  { kind: "FxModule", label: "Module FX" },
  { kind: "Flow", label: "Flow" },
];

const MIN_PRIORITY = -128;
const MAX_PRIORITY = 127;

interface ClipPropertiesProps {
  clipUid: string | null;
}

/** Sorts identified objects by their console-facing numeric ID. */
function sortById<T extends { identifiers: { id: number } }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.identifiers.id - b.identifiers.id);
}

export default function ClipProperties(props: ClipPropertiesProps) {
  const $clips = useStore(clips);
  const $sequences = useShallowStore(sequences);
  const $fx = useStore(fx);
  const $stepFx = useStore(stepFx);
  const $fxModules = useStore(fxModules);
  const $flows = useStore(flows);
  const capabilities = useStore(runtimeCapabilities);
  const [sourceKind, setSourceKind] = createSignal<SourceKind>("Sequence");
  const [draftLabel, setDraftLabel] = createSignal("");
  const [draftPriority, setDraftPriority] = createSignal("0");

  const clipEntry = createMemo(() =>
    props.clipUid ? $clips()[props.clipUid] : undefined,
  );
  const clip = createMemo(() => clipEntry()?.[0]);
  const isActive = createMemo(() => clipEntry()?.[1] ?? false);
  const sequenceItems = createMemo(() => sortById(Object.values($sequences())));
  const fxItems = createMemo(() => sortById(Object.values($fx())));
  const stepFxItems = createMemo(() => sortById(Object.values($stepFx())));
  const fxModuleItems = createMemo(() => sortById(Object.values($fxModules())));
  const flowItems = createMemo(() => sortById(Object.values($flows())));
  const source = createMemo(() => clip()?.source);
  const clipOptions = createMemo<types.ClipOptions>(() => ({
    auto_release: clip()?.options?.auto_release ?? false,
    deactivate_on_sequence_end:
      clip()?.options?.deactivate_on_sequence_end ?? false,
  }));

  createEffect(() => {
    const currentSource = source();
    if (currentSource) {
      setSourceKind(currentSource.type);
    } else {
      setSourceKind("Sequence");
    }
  });

  /** Keeps the clip label draft aligned outside active typing. */
  createEffect(() => {
    const currentClip = clip();
    if (document.activeElement?.getAttribute("aria-label") === "Clip label") {
      return;
    }
    setDraftLabel(currentClip?.identifiers.label ?? "");
  });

  /** Keeps the clip priority draft aligned outside active numeric edits. */
  createEffect(() => {
    const currentClip = clip();
    if (
      document.activeElement?.getAttribute("aria-label") === "Clip priority"
    ) {
      return;
    }
    setDraftPriority(String(currentClip?.priority ?? 0));
  });

  const sendClipCommand = (command: types.ClipCommand) => {
    engineRuntime.sendCommand({ module: "ClipCommand", command });
  };

  const assignSource = (nextSource: types.Source) => {
    const currentClip = clip();
    if (!currentClip) return;
    sendClipCommand({
      type: "AssignSource",
      data: {
        clip_id: currentClip.identifiers.id,
        source: nextSource,
      },
    });
  };

  const clearSource = () => {
    const currentClip = clip();
    if (!currentClip) return;
    sendClipCommand({
      type: "ClearSource",
      data: currentClip.identifiers.id,
    });
  };

  const updateOptions = (options: types.ClipOptions) => {
    const currentClip = clip();
    if (!currentClip) return;
    sendClipCommand({
      type: "UpdateClipOptions",
      data: {
        clip_id: currentClip.identifiers.id,
        options,
      },
    });
  };

  /** Commits the clip label draft through a StoreClip command. */
  const commitLabel = () => {
    const currentClip = clip();
    if (!currentClip || draftLabel() === currentClip.identifiers.label) {
      return;
    }
    sendClipCommand({
      type: "StoreClip",
      data: {
        ...currentClip,
        identifiers: {
          ...currentClip.identifiers,
          label: draftLabel(),
        },
      },
    });
  };

  /** Commits a valid priority draft through a StoreClip command. */
  const commitPriority = () => {
    const currentClip = clip();
    if (!currentClip) return;

    const normalizedDraft = draftPriority().trim();
    const nextPriority = Number(normalizedDraft);
    if (
      normalizedDraft === "" ||
      !Number.isInteger(nextPriority) ||
      nextPriority < MIN_PRIORITY ||
      nextPriority > MAX_PRIORITY
    ) {
      setDraftPriority(String(currentClip.priority));
      return;
    }

    if (nextPriority === currentClip.priority) return;
    sendClipCommand({
      type: "StoreClip",
      data: {
        ...currentClip,
        priority: nextPriority,
      },
    });
  };

  const sourceSummary = createMemo(() => {
    const currentSource = source();
    if (!currentSource) return "No source assigned";

    if (currentSource.type === "Sequence") {
      const sequence = Object.values($sequences()).find(
        (item) => item.identifiers.uid === currentSource.data,
      );
      return sequence
        ? `Sequence ${sequence.identifiers.id}: ${sequence.identifiers.label}`
        : "Assigned sequence";
    }

    if (currentSource.type === "Fx") {
      const fxItem = Object.values($fx()).find(
        (item) => item.identifiers.uid === currentSource.data,
      );
      return fxItem
        ? `FX ${fxItem.identifiers.id}: ${fxItem.identifiers.label}`
        : "Assigned FX";
    }

    if (currentSource.type === "StepFx") {
      const stepFxItem = Object.values($stepFx()).find(
        (item) => item.identifiers.uid === currentSource.data,
      );
      return stepFxItem
        ? `Step FX ${stepFxItem.identifiers.id}: ${stepFxItem.identifiers.label}`
        : "Assigned step FX";
    }

    if (currentSource.type === "FxModule") {
      const fxModule = Object.values($fxModules()).find(
        (item) => item.identifiers.uid === currentSource.data,
      );
      return fxModule
        ? `Module FX ${fxModule.identifiers.id}: ${fxModule.identifiers.label}`
        : "Assigned module FX";
    }

    const flow = Object.values($flows()).find(
      (item) => item.identifiers.uid === currentSource.data,
    );
    return flow
      ? `Flow ${flow.identifiers.id}: ${flow.identifiers.label}`
      : "Assigned flow";
  });

  const activeSourceKey = createMemo(() => {
    const currentSource = source();
    if (!currentSource || currentSource.type !== sourceKind()) return undefined;
    return currentSource.data;
  });

  return (
    <Show
      when={clip()}
      fallback={
        <div class="p-4 text-sm text-neutral-500">
          Select one clip to edit its source assignment and options.
        </div>
      }
    >
      {(currentClip) => (
        <div class="space-y-4 p-4">
          <div class="border-b border-neutral-700 pb-3">
            <div class="flex items-center justify-between gap-3">
              <div>
                <h3 class="font-medium text-neutral-100">
                  Clip {currentClip().identifiers.id}
                </h3>
                <p class="text-xs text-neutral-400">
                  {currentClip().identifiers.label || "Untitled"}
                </p>
              </div>
              <span
                class="rounded-full px-2 py-1 text-[10px] font-medium uppercase tracking-wide"
                classList={{
                  "bg-emerald-500/20 text-emerald-200": isActive(),
                  "bg-neutral-700 text-neutral-300": !isActive(),
                }}
              >
                {isActive() ? "Active" : "Idle"}
              </span>
            </div>
            <label class="mt-3 block text-xs font-medium text-neutral-300">
              Label
              <Input
                density="compact"
                type="text"
                aria-label="Clip label"
                class="mt-1 w-full"
                value={draftLabel()}
                onInput={(event) => setDraftLabel(event.currentTarget.value)}
                onBlur={commitLabel}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    commitLabel();
                    event.currentTarget.blur();
                    return;
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setDraftLabel(currentClip().identifiers.label);
                    event.currentTarget.blur();
                  }
                }}
              />
            </label>
            <label class="mt-3 block text-xs font-medium text-neutral-300">
              Priority
              <Input
                density="compact"
                type="number"
                aria-label="Clip priority"
                class="mt-1 w-full"
                min={MIN_PRIORITY}
                max={MAX_PRIORITY}
                step={1}
                value={draftPriority()}
                onInput={(event) => setDraftPriority(event.currentTarget.value)}
                onBlur={commitPriority}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    event.currentTarget.blur();
                    return;
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setDraftPriority(String(currentClip().priority));
                    event.currentTarget.blur();
                  }
                }}
              />
            </label>
          </div>

          <section class="space-y-3">
            <div>
              <h4 class="text-xs font-semibold uppercase tracking-wide text-neutral-400">
                Source
              </h4>
              <p class="mt-1 text-xs text-neutral-500">{sourceSummary()}</p>
            </div>

            <div class="flex flex-wrap gap-2">
              <ToggleToolbarButton
                size="labeled"
                label="None"
                pressed={!source()}
                onClick={clearSource}
              >
                None
              </ToggleToolbarButton>
              <For
                each={SOURCE_KIND_OPTIONS.filter(
                  (option) =>
                    option.kind !== "Flow" ||
                    capabilities()?.experimental_flows,
                )}
              >
                {(option) => (
                  <ToggleToolbarButton
                    size="labeled"
                    label={option.label}
                    pressed={sourceKind() === option.kind}
                    onClick={() => setSourceKind(option.kind)}
                  >
                    {option.label}
                  </ToggleToolbarButton>
                )}
              </For>
            </div>

            <Switch>
              <Match when={sourceKind() === "Sequence"}>
                <ObjectSelector
                  items={sequenceItems()}
                  selectedKey={activeSourceKey()}
                  onSelect={(item) =>
                    assignSource({
                      type: "Sequence",
                      data: item.identifiers.uid,
                    })
                  }
                  getKey={(item) => item.identifiers.uid}
                  getPrimaryText={(item) =>
                    `${item.identifiers.id}: ${item.identifiers.label}`
                  }
                  getSecondaryText={(item) =>
                    `${item.steps.length} cue${item.steps.length === 1 ? "" : "s"}`
                  }
                  getSearchText={(item) =>
                    `${item.identifiers.id} ${item.identifiers.label}`
                  }
                  placeholder="Find a sequence..."
                  emptyMessage="No sequences available."
                />
              </Match>
              <Match when={sourceKind() === "Fx"}>
                <ObjectSelector
                  items={fxItems()}
                  selectedKey={activeSourceKey()}
                  onSelect={(item) =>
                    assignSource({
                      type: "Fx",
                      data: item.identifiers.uid,
                    })
                  }
                  getKey={(item) => item.identifiers.uid}
                  getPrimaryText={(item) =>
                    `${item.identifiers.id}: ${item.identifiers.label}`
                  }
                  getSearchText={(item) =>
                    `${item.identifiers.id} ${item.identifiers.label}`
                  }
                  placeholder="Find an FX..."
                  emptyMessage="No FX available."
                />
              </Match>
              <Match when={sourceKind() === "StepFx"}>
                <ObjectSelector
                  items={stepFxItems()}
                  selectedKey={activeSourceKey()}
                  onSelect={(item) =>
                    assignSource({
                      type: "StepFx",
                      data: item.identifiers.uid,
                    })
                  }
                  getKey={(item) => item.identifiers.uid}
                  getPrimaryText={(item) =>
                    `${item.identifiers.id}: ${item.identifiers.label}`
                  }
                  getSearchText={(item) =>
                    `${item.identifiers.id} ${item.identifiers.label}`
                  }
                  placeholder="Find a step FX..."
                  emptyMessage="No step FX available."
                />
              </Match>
              <Match when={sourceKind() === "FxModule"}>
                <ObjectSelector
                  items={fxModuleItems()}
                  selectedKey={activeSourceKey()}
                  onSelect={(item) =>
                    assignSource({
                      type: "FxModule",
                      data: item.identifiers.uid,
                    })
                  }
                  getKey={(item) => item.identifiers.uid}
                  getPrimaryText={(item) =>
                    `${item.identifiers.id}: ${item.identifiers.label}`
                  }
                  getSearchText={(item) =>
                    `${item.identifiers.id} ${item.identifiers.label}`
                  }
                  placeholder="Find a module FX..."
                  emptyMessage="No module FX available."
                />
              </Match>
              <Match
                when={
                  sourceKind() === "Flow" && capabilities()?.experimental_flows
                }
              >
                <ObjectSelector
                  items={flowItems()}
                  selectedKey={activeSourceKey()}
                  onSelect={(item) =>
                    assignSource({
                      type: "Flow",
                      data: item.identifiers.uid,
                    })
                  }
                  getKey={(item) => item.identifiers.uid}
                  getPrimaryText={(item) =>
                    `${item.identifiers.id}: ${item.identifiers.label}`
                  }
                  getSearchText={(item) =>
                    `${item.identifiers.id} ${item.identifiers.label}`
                  }
                  placeholder="Find a flow..."
                  emptyMessage="No flows available."
                />
              </Match>
            </Switch>
          </section>

          <section class="space-y-2 border-t border-neutral-700 pt-3">
            <h4 class="text-xs font-semibold uppercase tracking-wide text-neutral-400">
              Options
            </h4>
            <label class="flex items-center justify-between gap-3 text-sm text-neutral-200">
              <div>
                <div>Auto-release</div>
                <p class="text-xs text-neutral-500">
                  Release existing playback output after this clip finishes
                  stopping.
                </p>
              </div>
              <Checkbox
                checked={clipOptions().auto_release}
                onChange={(event) =>
                  updateOptions({
                    ...clipOptions(),
                    auto_release: event.currentTarget.checked,
                  })
                }
              />
            </label>
            <label class="flex items-center justify-between gap-3 text-sm text-neutral-200">
              <div>
                <div>Deactivate on sequence end</div>
                <p class="text-xs text-neutral-500">
                  Stop this clip after a non-wrapping sequence reaches its final
                  cue.
                </p>
              </div>
              <Checkbox
                checked={clipOptions().deactivate_on_sequence_end}
                onChange={(event) =>
                  updateOptions({
                    ...clipOptions(),
                    deactivate_on_sequence_end: event.currentTarget.checked,
                  })
                }
              />
            </label>
          </section>
        </div>
      )}
    </Show>
  );
}
