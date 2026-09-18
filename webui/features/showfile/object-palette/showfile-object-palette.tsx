// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { ArchiveIcon } from "@squidlab/phosphor-solid/archive";
import { XIcon } from "@squidlab/phosphor-solid/x";
import {
  type Component,
  createEffect,
  createMemo,
  createRenderEffect,
  createSignal,
  For,
  Show,
  untrack,
} from "solid-js";
import { Dynamic } from "solid-js/web";
import { usePanelCapabilityRegistry } from "../../../components/providers/panel-capabilities/context-core";
import { DialogBackdrop } from "../../../components/ui/dialog";
import { ScrollArea } from "../../../components/ui/scroll-area";
import {
  SearchPickerInput,
  SearchPickerOption,
  SearchPickerSurface,
} from "../../../components/ui/search-picker";
import { Button } from "../../../components/ui/visual-language/button";
import { formatCueEditorTitle } from "../../../lib/cue-editor-title";
import { setStoreAction } from "../../../lib/nanostore-action";
import {
  isPaletteNavigationKey,
  nextPaletteIndex,
  visiblePaletteRowCount,
} from "../../../lib/palette-navigation";
import { REVEAL_OBJECT_CAPABILITY } from "../../../lib/panel-capabilities";
import { openOrFocusPanel } from "../../../lib/panel-open-command";
import {
  buildShowfileObjectSearchEntries,
  filterShowfileObjectSearchEntries,
  parseShowfileObjectTypeToken,
  type ShowfileObjectResultTag,
  type ShowfileObjectSearchEntry,
  type ShowfileObjectType,
  showfileObjectResultDescription,
  showfileObjectResultLabel,
  showfileObjectTypeDefinition,
} from "../../../lib/showfile-object-search";
import { useShallowStore } from "../../../lib/use-shallow-store";
import {
  blueprints,
  clips,
  colorPaths,
  cues,
  dockApi,
  fixtures,
  flows,
  fx,
  fxModules,
  groups,
  masters,
  requestSceneObjectNavigation,
  requestSequenceNavigation,
  runtimeCapabilities,
  sceneObjects,
  sequences,
  stepFx,
  timecodes,
  timelines,
  visualizerEditSelection,
  visualizerSceneObjectSelection,
} from "../../../state/appStores";
import SequenceWrapTag from "../../sequences";

interface ShowfileObjectPaletteProps {
  isOpen: boolean;
  onClose: () => void;
}

/** Renders a compact metadata tag for a showfile object result row. */
const ShowfileObjectResultTagBadge: Component<{
  tag: ShowfileObjectResultTag;
}> = (props) => (
  <Show
    fallback={
      <span
        class="inline-flex h-6 max-w-32 shrink-0 items-center justify-center rounded border border-gray-300 bg-gray-50 px-2 text-xs font-medium text-gray-600 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300"
        data-showfile-object-tag={props.tag.id}
        title={props.tag.label}
      >
        <Show
          fallback={
            <span class="truncate">{props.tag.text ?? props.tag.label}</span>
          }
          when={props.tag.icon}
        >
          {(icon) => <Dynamic component={icon()} class="size-4" aria-hidden />}
        </Show>
      </span>
    }
    when={props.tag.id === "wrap"}
  >
    <SequenceWrapTag />
  </Show>
);

/** Renders the dedicated showfile object palette opened by Cmd/Ctrl+P. */
export const ShowfileObjectPaletteUI: Component<ShowfileObjectPaletteProps> = (
  props,
) => {
  const $fixtures = useStore(fixtures);
  const $groups = useStore(groups);
  const $cues = useShallowStore(cues);
  const $sequences = useShallowStore(sequences);
  const $fx = useStore(fx);
  const $stepFx = useStore(stepFx);
  const $fxModules = useStore(fxModules);
  const $clips = useStore(clips);
  const $flows = useStore(flows);
  const capabilities = useStore(runtimeCapabilities);
  const $blueprints = useStore(blueprints);
  const $colorPaths = useStore(colorPaths);
  const $masters = useStore(masters);
  const $sceneObjects = useStore(sceneObjects);
  const $timecodes = useStore(timecodes);
  const $timelines = useShallowStore(timelines);
  const $dockApi = useStore(dockApi);
  const { invokePanelCapability } = usePanelCapabilityRegistry();

  const [query, setQuery] = createSignal("");
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  const [activeType, setActiveType] = createSignal<ShowfileObjectType>();
  const [panelSelectionMode, setPanelSelectionMode] = createSignal(false);
  let inputRef: HTMLInputElement | undefined;
  let containerRef: HTMLDivElement | undefined;
  let scrollContainerRef: HTMLDivElement | undefined;

  /** Builds the latest object search index from nanostore snapshots. */
  const entries = createMemo(() =>
    buildShowfileObjectSearchEntries({
      fixtures: $fixtures(),
      groups: $groups(),
      cues: $cues(),
      sequences: $sequences(),
      fx: $fx(),
      stepFx: $stepFx(),
      fxModules: $fxModules(),
      clips: $clips(),
      flows: capabilities()?.experimental_flows ? $flows() : {},
      blueprints: $blueprints(),
      colorPaths: $colorPaths(),
      masters: $masters(),
      sceneObjects: $sceneObjects(),
      timecodes: $timecodes(),
      timelines: $timelines(),
    }),
  );

  /** Returns the rows visible for the current type badge and search phrase. */
  const filteredEntries = createMemo(() =>
    filterShowfileObjectSearchEntries(entries(), query(), activeType()).slice(
      0,
      100,
    ),
  );

  /** Returns the type definition currently represented by the badge. */
  const activeTypeDefinition = createMemo(() => {
    const type = activeType();
    return type ? showfileObjectTypeDefinition(type) : undefined;
  });

  /** Resets transient search state and synchronizes focus after shell visibility. */
  createRenderEffect(() => {
    if (!props.isOpen) {
      queueMicrotask(() => {
        if (!props.isOpen) inputRef?.blur();
      });
      return;
    }
    setQuery("");
    setActiveType(undefined);
    setSelectedIndex(0);
    setPanelSelectionMode(false);
    inputRef?.focus();
    inputRef?.select();
    queueMicrotask(() => {
      if (!props.isOpen) return;
      inputRef?.focus();
      inputRef?.select();
    });
  });

  /** Keeps the highlighted row inside the current filtered result bounds. */
  createEffect(() => {
    const count = filteredEntries().length;
    if (count === 0) {
      setSelectedIndex(0);
      return;
    }
    const currentIndex = untrack(selectedIndex);
    if (currentIndex >= count) {
      setSelectedIndex(count - 1);
    }
  });

  /** Keeps keyboard-selected results visible inside the palette scroll area. */
  createEffect(() => {
    const index = selectedIndex();
    filteredEntries();
    const scrollContainer = scrollContainerRef;
    if (!scrollContainer) return;
    const selectedElement = scrollContainer.querySelector<HTMLElement>(
      `[data-showfile-object-index="${index}"]`,
    );
    selectedElement?.scrollIntoView({ block: "nearest" });
  });

  /** Returns the action label shown on the currently selected result row. */
  const selectedActionLabel = () =>
    panelSelectionMode() ? "Select in panel" : "Open editor";

  /** Applies a leading type token to the badge slot when followed by whitespace. */
  const setQueryFromInput = (value: string) => {
    if (!activeType()) {
      const parsed = parseShowfileObjectTypeToken(value);
      if (parsed) {
        setActiveType(parsed.definition.type);
        setQuery(parsed.rest);
        setSelectedIndex(0);
        return;
      }
    }

    setQuery(value);
    setSelectedIndex(0);
  };

  /** Opens the owning object panel and requests that the selected object is revealed. */
  const openObjectPanel = (entry: ShowfileObjectSearchEntry) => {
    openOrFocusPanel(
      $dockApi(),
      entry.panelId,
      entry.componentName,
      entry.panelTitle,
    );
    invokePanelCapability(entry.panelId, REVEAL_OBJECT_CAPABILITY, {
      type: entry.type,
      uid: entry.uid,
    });

    if (entry.type === "sceneObject") {
      setStoreAction(visualizerSceneObjectSelection, "Select Scene Object", [
        entry.uid,
      ]);
      setStoreAction(visualizerEditSelection, "Edit Scene Object", [entry.uid]);
      requestSceneObjectNavigation(entry.uid);
    } else if (entry.type === "sequence") {
      requestSequenceNavigation(entry.uid);
    }

    props.onClose();
  };

  /** Opens or focuses the cue editor panel for a palette-selected cue. */
  const openCueEditor = (entry: ShowfileObjectSearchEntry) => {
    const api = $dockApi();
    if (!api) return;

    const cue = $cues()[entry.uid];
    if (!cue) return;

    const sequence = Object.values($sequences()).find((candidate) =>
      candidate.steps.includes(entry.uid),
    );
    const panelId = `cue-list-panel-${entry.uid}`;
    const panel = api.getPanel(panelId);
    if (panel) {
      panel.focus();
      props.onClose();
      return;
    }

    api.addPanel({
      id: panelId,
      component: "CueEditor",
      title: formatCueEditorTitle({
        cueId: cue.identifiers.id,
        sequenceId: sequence?.identifiers.id,
        partId: 0,
        hasAdditionalParts: (cue.parts?.length ?? 0) > 0,
      }),
      params: {
        initialCueUid: entry.uid,
        initialSequenceId: sequence?.identifiers.id,
        initialSequenceUid: sequence?.identifiers.uid,
      },
    });
    props.onClose();
  };

  /** Opens or focuses the sequence editor panel for a palette-selected sequence. */
  const openSequenceEditor = (entry: ShowfileObjectSearchEntry) => {
    const api = $dockApi();
    if (!api) return;

    const sequence = $sequences()[entry.uid];
    if (!sequence) return;

    const panelId = `sequence-editor-panel-${entry.uid}`;
    const panel = api.getPanel(panelId);
    if (panel) {
      panel.focus();
      props.onClose();
      return;
    }

    api.addPanel({
      id: panelId,
      component: "SequenceEditor",
      title: sequence.identifiers.label.trim()
        ? `Sequence ${sequence.identifiers.id}: ${sequence.identifiers.label}`
        : `Sequence ${sequence.identifiers.id}`,
      params: { initialSequenceUid: entry.uid },
    });
    props.onClose();
  };

  /** Opens or focuses the FX editor panel for a palette-selected regular FX. */
  const openFxEditor = (entry: ShowfileObjectSearchEntry) => {
    const api = $dockApi();
    if (!api) return;

    const fxEntry = $fx()[entry.uid];
    if (!fxEntry) return;

    const panelId = `fx-editor-${entry.uid}`;
    const panel = api.getPanel(panelId);
    if (panel) {
      panel.focus();
      props.onClose();
      return;
    }

    api.addPanel({
      id: panelId,
      component: "FxEditor",
      title: `FX ${fxEntry.identifiers.id}: ${fxEntry.identifiers.label}`,
      params: { initialFxUid: entry.uid },
    });
    props.onClose();
  };

  /** Opens or focuses the flow editor panel for a palette-selected flow. */
  const openFlowEditor = (entry: ShowfileObjectSearchEntry) => {
    const api = $dockApi();
    if (!api) return;

    const flow = $flows()[entry.uid];
    if (!flow) return;

    const panelId = `flow-editor-${entry.uid}`;
    const panel = api.getPanel(panelId);
    if (panel) {
      panel.focus();
      props.onClose();
      return;
    }

    api.addPanel({
      id: panelId,
      component: "FlowEditor",
      title: `Flow ${flow.identifiers.id}: ${flow.identifiers.label}`,
      params: { initialFlowUid: entry.uid },
      renderer: "onlyWhenVisible",
    });
    props.onClose();
  };

  /** Opens the editor for editable object types, or falls back to panel highlight. */
  const openObjectEditor = (entry: ShowfileObjectSearchEntry) => {
    switch (entry.type) {
      case "cue":
        openCueEditor(entry);
        return;
      case "sequence":
        openSequenceEditor(entry);
        return;
      case "fx":
        openFxEditor(entry);
        return;
      case "flow":
        openFlowEditor(entry);
        return;
      default:
        openObjectPanel(entry);
    }
  };

  /** Handles modal keyboard navigation and badge removal. */
  const handleKeyDown = (event: KeyboardEvent) => {
    if (!props.isOpen) return;
    setPanelSelectionMode(event.metaKey || event.ctrlKey);

    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      props.onClose();
      return;
    }

    if (event.key === "Backspace" && query() === "" && activeType()) {
      event.preventDefault();
      setActiveType(undefined);
      setSelectedIndex(0);
      return;
    }

    const results = filteredEntries();
    if (results.length === 0) return;

    if (isPaletteNavigationKey(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      const currentIndex = selectedIndex();
      const selectedElement = scrollContainerRef?.querySelector<HTMLElement>(
        `[data-showfile-object-index="${currentIndex}"]`,
      );
      const pageSize = visiblePaletteRowCount(
        scrollContainerRef,
        selectedElement ?? undefined,
      );
      setSelectedIndex(
        nextPaletteIndex(currentIndex, results.length, event.key, pageSize),
      );
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      const entry = results[selectedIndex()];
      if (event.metaKey || event.ctrlKey) {
        openObjectPanel(entry);
        return;
      }
      openObjectEditor(entry);
    }
  };

  /** Tracks modifier release so the selected-row action badge stays current. */
  const handleKeyUp = (event: KeyboardEvent) => {
    if (!props.isOpen) return;
    setPanelSelectionMode(event.metaKey || event.ctrlKey);
  };

  /** Closes the palette when clicking outside the dialog body. */
  const handleClickOutside = (event: MouseEvent) => {
    if (containerRef && !containerRef.contains(event.target as Node)) {
      props.onClose();
    }
  };

  return (
    <DialogBackdrop
      style={{
        display: props.isOpen ? "flex" : "none",
        "align-items": "flex-start",
        "padding-top": "80px",
      }}
      aria-hidden={!props.isOpen}
      data-dialog-kind="showfile-object-palette"
      data-dialog-visible={props.isOpen ? "true" : "false"}
      data-showfile-object-palette-shell="true"
      on:keydown={{ handleEvent: handleKeyDown, capture: true }}
      on:keyup={{ handleEvent: handleKeyUp, capture: true }}
      on:mousedown={{ handleEvent: handleClickOutside, capture: true }}
    >
      <SearchPickerSurface
        ref={containerRef}
        class="max-w-2xl"
        style={{ "max-height": "calc(100dvh - 96px)" }}
      >
        <SearchPickerInput
          ref={inputRef}
          type="text"
          placeholder="Search showfile objects..."
          value={query()}
          onInput={(event) => setQueryFromInput(event.currentTarget.value)}
          leading={
            <Show when={activeTypeDefinition()}>
              {(definition) => (
                <Button
                  size="compact"
                  class="shrink-0 gap-1 self-center"
                  aria-label={`Remove ${definition().label} filter`}
                  onClick={() => {
                    setActiveType(undefined);
                    inputRef?.focus();
                  }}
                >
                  {definition().badge}
                  <XIcon class="size-3" aria-hidden />
                </Button>
              )}
            </Show>
          }
          trailing={
            <span
              class="shrink-0 self-center text-xs text-gray-400"
              data-showfile-object-action-badge="true"
            >
              {selectedActionLabel()}
            </span>
          }
        />

        <ScrollArea
          class="min-h-0 max-h-[32rem]"
          viewportProps={{
            ref: (element) => {
              scrollContainerRef = element;
            },
            role: "region",
            "aria-label": "Showfile objects",
            tabIndex: 0,
          }}
        >
          <Show
            when={filteredEntries().length > 0}
            fallback={
              <div class="px-6 py-12 text-center">
                <ArchiveIcon
                  class="mx-auto size-12 text-gray-400"
                  aria-hidden
                />
                <h3 class="mt-2 text-sm font-medium text-gray-900 dark:text-gray-100">
                  No objects found
                </h3>
              </div>
            }
          >
            <ul>
              <For each={filteredEntries()}>
                {(entry, index) => {
                  /** Indicates whether this row is currently keyboard-selected. */
                  const selected = createMemo(
                    () => index() === selectedIndex(),
                  );
                  return (
                    <li
                      data-showfile-object-id={`${entry.type}:${entry.id}`}
                      data-showfile-object-index={index()}
                      data-selected={selected()}
                    >
                      <SearchPickerOption
                        selected={selected()}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => openObjectEditor(entry)}
                      >
                        <div class="flex min-w-0 w-full items-center justify-between gap-4">
                          <div class="min-w-0">
                            <div class="min-h-6 truncate font-medium text-gray-900 dark:text-gray-100">
                              {showfileObjectResultLabel(entry)}
                            </div>
                            <div class="truncate text-sm text-gray-500 dark:text-gray-400">
                              {showfileObjectResultDescription(entry)}
                            </div>
                          </div>
                          <div class="ml-3 flex shrink-0 items-center gap-2">
                            <For each={entry.tags}>
                              {(tag) => (
                                <ShowfileObjectResultTagBadge tag={tag} />
                              )}
                            </For>
                          </div>
                        </div>
                      </SearchPickerOption>
                    </li>
                  );
                }}
              </For>
            </ul>
          </Show>
        </ScrollArea>
      </SearchPickerSurface>
    </DialogBackdrop>
  );
};
