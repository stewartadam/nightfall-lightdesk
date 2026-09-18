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
  Show,
} from "solid-js";
import { Portal } from "solid-js/web";
import { ScrollArea } from "../../../components/ui/scroll-area";
import {
  SearchPickerInput,
  SearchPickerOption,
  SearchPickerSurface,
} from "../../../components/ui/search-picker";
import { getFocusedComponentId } from "../../../lib/keyboardShortcuts";
import {
  isPaletteNavigationKey,
  nextPaletteIndex,
  visiblePaletteRowCount,
} from "../../../lib/palette-navigation";
import { durationToMs } from "../../../lib/utils";
import { useWorkspaceActivity } from "../../../lib/workspace-activity";
import type * as types from "../../../types";
import { useTimelineContext } from "../context/timeline-context";
import {
  beatPositionAtMs,
  formatTimelineBeatPosition,
  formatTimelineTimestamp,
  resolveTimelineJumpTargets,
  type TimelineJumpTarget,
} from "../model/timeline-jump";

type MarkerOption = {
  id: string;
  kind: "marker";
  marker: types.TimelineMarker;
  positionMs: number;
  timestamp: string;
  beatPosition: string;
  typeLabel: "Label";
};

type JumpOption = MarkerOption | (TimelineJumpTarget & { id: string });

/** Renders a modal jump palette for timeline labels, timestamps, and beats. */
export const TimelineGotoPopout = () => {
  const ctx = useTimelineContext();
  const workspaceActive = useWorkspaceActivity();
  const [isOpen, setIsOpen] = createSignal(false);
  const [filter, setFilter] = createSignal("");
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  let inputRef: HTMLInputElement | undefined;
  let popoutRef: HTMLDivElement | undefined;
  let optionsListRef: HTMLDivElement | undefined;

  /** Returns the beatgrid configuration used to display and resolve jump positions. */
  const jumpConfig = createMemo(() => ({
    bpm: ctx.bpm(),
    beatsPerBar: ctx.beatsPerBar(),
    markers: ctx.useBeatgrid() ? ctx.beatgrid()?.markers : undefined,
  }));

  /** Builds label jump rows with stable timing details for duplicate label strings. */
  const markerOptions = createMemo<MarkerOption[]>(() =>
    ctx
      .markers()
      .map((marker) => {
        const positionMs = durationToMs(marker.time);
        const beatPosition = beatPositionAtMs(positionMs, jumpConfig());
        return {
          id: `marker-${marker.uid}`,
          kind: "marker" as const,
          marker,
          positionMs,
          timestamp: formatTimelineTimestamp(positionMs),
          beatPosition: formatTimelineBeatPosition(beatPosition),
          typeLabel: "Label" as const,
        };
      })
      .sort((a, b) => a.positionMs - b.positionMs),
  );

  /** Filters labels and prepends a direct jump row when the query parses numerically. */
  const jumpOptions = createMemo<JumpOption[]>(() => {
    const query = filter().trim().toLowerCase();
    if (!query) return markerOptions();

    const matchingMarkers = markerOptions().filter(
      (option) =>
        option.marker.label.toLowerCase().includes(query) ||
        option.timestamp.toLowerCase().includes(query) ||
        option.beatPosition.toLowerCase().includes(query),
    );
    const directTargets = resolveTimelineJumpTargets(filter(), jumpConfig(), {
      includeBareNumericBeat: matchingMarkers.length === 0,
    });
    if (directTargets.length === 0) return matchingMarkers;

    return [
      ...directTargets.map((target) => ({
        ...target,
        id: `${target.kind}-${target.positionMs}`,
      })),
      ...matchingMarkers,
    ];
  });

  /** Opens the jump popout with a clean query and first-row selection. */
  const open = () => {
    setFilter("");
    setSelectedIndex(0);
    setIsOpen(true);
  };

  /** Closes the jump popout and clears transient selection state. */
  const close = () => {
    setIsOpen(false);
    setFilter("");
    setSelectedIndex(0);
  };

  /** Seeks to a selected jump row and selects the source marker when applicable. */
  const jumpToOption = (option: JumpOption | undefined) => {
    if (!option) return;
    ctx.playback.seek(option.positionMs);
    if (option.kind === "marker") {
      ctx.selectTimelineObject({
        type: "Marker",
        data: { marker_uid: option.marker.uid },
      });
    }
    close();
  };

  /** Focuses the search field when its open popout becomes visible. */
  createEffect(() => {
    if (!workspaceActive() || !isOpen()) return;
    const timeout = window.setTimeout(() => {
      inputRef?.focus();
      inputRef?.select();
    }, 0);
    onCleanup(() => window.clearTimeout(timeout));
  });

  /** Keeps the highlighted row valid as the filtered jump list changes. */
  const clampSelectedIndex = () => {
    const lastIndex = jumpOptions().length - 1;
    if (lastIndex < 0) {
      setSelectedIndex(0);
      return;
    }
    setSelectedIndex(Math.min(selectedIndex(), lastIndex));
  };

  createEffect(clampSelectedIndex);

  /** Keeps keyboard navigation from moving the highlighted jump target outside the viewport. */
  createEffect(() => {
    selectedIndex();
    jumpOptions();
    requestAnimationFrame(() => {
      optionsListRef
        ?.querySelector<HTMLElement>('[data-timeline-jump-selected="true"]')
        ?.scrollIntoView({ block: "nearest" });
    });
  });

  /** Fully captures popout keyboard events before other shortcut handlers see them. */
  const capturePopoverKey = (event: KeyboardEvent) => {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  };

  /** Handles the global jump shortcut and modal list navigation while open. */
  const handleWindowKeyDown = (event: KeyboardEvent) => {
    const isOpenShortcut =
      (event.metaKey || event.ctrlKey) &&
      !event.altKey &&
      !event.shiftKey &&
      event.key.toLowerCase() === "g";

    if (isOpenShortcut) {
      if (getFocusedComponentId() !== ctx.componentId && !isOpen()) {
        return;
      }
      capturePopoverKey(event);
      open();
      return;
    }

    if (!isOpen()) return;

    if (event.key === "Escape") {
      capturePopoverKey(event);
      close();
      return;
    }

    if (event.key === "Enter") {
      capturePopoverKey(event);
      jumpToOption(jumpOptions()[selectedIndex()]);
      return;
    }

    if (isPaletteNavigationKey(event.key)) {
      capturePopoverKey(event);
      const count = jumpOptions().length;
      if (count > 0) {
        const selectedElement = optionsListRef?.querySelector<HTMLElement>(
          '[data-timeline-jump-selected="true"]',
        );
        const pageSize = visiblePaletteRowCount(
          optionsListRef,
          selectedElement ?? undefined,
        );
        setSelectedIndex(
          nextPaletteIndex(selectedIndex(), count, event.key, pageSize),
        );
      }
      return;
    }
  };

  /** Closes the popout when the user clicks outside the floating panel. */
  const handleClickOutside = (event: MouseEvent) => {
    if (popoutRef?.contains(event.target as Node)) return;
    close();
  };

  /** Only the active workspace can capture jump shortcuts or outside clicks. */
  createEffect(() => {
    if (!workspaceActive()) return;
    window.addEventListener("keydown", handleWindowKeyDown, { capture: true });
    window.addEventListener("mousedown", handleClickOutside, { capture: true });
    onCleanup(() => {
      window.removeEventListener("keydown", handleWindowKeyDown, {
        capture: true,
      });
      window.removeEventListener("mousedown", handleClickOutside, {
        capture: true,
      });
    });
  });

  /** Returns the primary row text shown for a jump option. */
  const optionLabel = (option: JumpOption) =>
    option.kind === "marker" ? option.marker.label : option.label;

  /** Returns the timestamp printed on the right side of each row. */
  const optionTimestamp = (option: JumpOption) =>
    option.kind === "marker"
      ? option.timestamp
      : formatTimelineTimestamp(option.positionMs);

  /** Returns the beatgrid label printed on the right side of each row. */
  const optionBeatLabel = (option: JumpOption) =>
    `Beat ${
      option.kind === "marker"
        ? option.beatPosition
        : formatTimelineBeatPosition(option.beatPosition)
    }`;

  return (
    <Show when={workspaceActive() && isOpen()}>
      <Portal>
        <div class="fixed inset-0 nightfall-top-layer pointer-events-none">
          <SearchPickerSurface
            ref={popoutRef}
            data-timeline-popout="goto"
            class="pointer-events-auto fixed left-1/2 top-20 -translate-x-1/2"
            style={{
              width: "min(36rem, calc(100vw - 32px))",
              "max-height": "calc(100dvh - 96px)",
            }}
          >
            <SearchPickerInput
              ref={inputRef}
              type="text"
              value={filter()}
              aria-label="Timeline jump target"
              placeholder="Jump to label, t 1:05:05, or b 45:04"
              onInput={(event) => {
                setFilter(event.currentTarget.value);
                setSelectedIndex(0);
              }}
            />
            <ScrollArea
              class="min-h-0 max-h-[340px]"
              viewportProps={{
                ref: (element) => {
                  optionsListRef = element;
                },
                role: "listbox",
                "aria-label": "Timeline jump options",
              }}
            >
              <Show
                when={jumpOptions().length > 0}
                fallback={
                  <div class="px-6 py-10 text-center">
                    <h3 class="text-sm font-medium text-gray-100">
                      No jump target found
                    </h3>
                    <p class="mt-1 text-sm text-gray-400">
                      Try a different search term, or press <code>Escape</code>.
                    </p>
                  </div>
                }
              >
                <ul>
                  <For each={jumpOptions()}>
                    {(option, index) => (
                      <li>
                        <SearchPickerOption
                          type="button"
                          role="option"
                          aria-selected={selectedIndex() === index()}
                          data-timeline-jump-selected={
                            selectedIndex() === index() ? "true" : undefined
                          }
                          selected={selectedIndex() === index()}
                          onMouseDown={(event) => event.preventDefault()}
                          onMouseEnter={() => setSelectedIndex(index())}
                          onClick={() => jumpToOption(option)}
                        >
                          <span class="min-w-0">
                            <span class="block truncate font-medium text-gray-100">
                              {optionLabel(option)}
                            </span>
                            <span class="block truncate text-sm text-gray-400">
                              {option.typeLabel}
                            </span>
                          </span>
                          <span class="shrink-0 text-right font-mono">
                            <span class="block text-sm text-gray-100">
                              {optionTimestamp(option)}
                            </span>
                            <span class="block text-sm text-gray-400">
                              {optionBeatLabel(option)}
                            </span>
                          </span>
                        </SearchPickerOption>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </ScrollArea>
          </SearchPickerSurface>
        </div>
      </Portal>
    </Show>
  );
};
