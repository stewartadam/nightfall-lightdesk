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
import { MenuHeading } from "../../../../components/ui/menu";
import { ScrollArea } from "../../../../components/ui/scroll-area";
import {
  SearchPickerInput,
  SearchPickerOption,
  SearchPickerSurface,
} from "../../../../components/ui/search-picker";
import { Button } from "../../../../components/ui/visual-language/button";
import {
  isPaletteNavigationKey,
  nextPaletteIndex,
  type PaletteNavigationKey,
  visiblePaletteRowCount,
} from "../../../../lib/palette-navigation";
import { useWorkspaceActivity } from "../../../../lib/workspace-activity";
import type {
  ActionTargetOption,
  InsertableActionType,
} from "../../model/insertion/action-catalog";
import {
  type ActionTargets,
  getActionFamilyForType,
  getInsertableActionDefinition,
  getTargetsForAction,
  INSERTABLE_ACTIONS,
  type InsertableActionDefinition,
} from "../../model/insertion/action-catalog";

type InsertActionPickerProps = {
  x: number;
  y: number;
  targets: ActionTargets;
  onInsert: (selection: {
    actionType: InsertableActionType;
    targetUid: string;
    targetLabel: string;
    cueIndex?: number;
    rate?: number;
  }) => void;
  onClose: () => void;
};

type PickerStep = "action" | "command" | "target" | "rate";

type ActionCommand = {
  action: InsertableActionDefinition;
  category: string;
  available: boolean;
};

const hasTargetForAction = (
  action: InsertableActionDefinition,
  targets: ActionTargets,
) => {
  if (action.requiresCommand) return true;
  return getTargetsForAction(action.type, targets).length > 0;
};

export const InsertActionPicker = (props: InsertActionPickerProps) => {
  const workspaceActive = useWorkspaceActivity();
  const [step, setStep] = createSignal<PickerStep>("action");
  const [actionQuery, setActionQuery] = createSignal("");
  const [targetQuery, setTargetQuery] = createSignal("");
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  const [selectedActionType, setSelectedActionType] = createSignal<
    InsertableActionType | undefined
  >(undefined);
  const [pendingTarget, setPendingTarget] = createSignal<
    ActionTargetOption | undefined
  >(undefined);
  let containerRef: HTMLDivElement | undefined;
  let optionsListRef: HTMLDivElement | undefined;
  let inputRef: HTMLInputElement | undefined;

  /** Keeps the picker width inside both viewport edges while retaining the pointer anchor. */
  const getLeft = () => {
    if (typeof window === "undefined") return props.x;
    const width = Math.min(512, window.innerWidth - 24);
    return Math.max(12, Math.min(props.x, window.innerWidth - width - 12));
  };

  /** Raises a bottom-edge picker to leave room for its scrollable result list. */
  const getTop = () => {
    if (typeof window === "undefined") return props.y;
    return Math.max(12, Math.min(props.y, window.innerHeight - 420));
  };

  const allActions = createMemo<ActionCommand[]>(() =>
    INSERTABLE_ACTIONS.map((action) => ({
      action,
      category:
        getActionFamilyForType(action.type) === "cue"
          ? "Cue Actions"
          : getActionFamilyForType(action.type) === "desk"
            ? "Desk Actions"
            : "Clip Actions",
      available: hasTargetForAction(action, props.targets),
    })),
  );

  const filteredActions = createMemo<ActionCommand[]>(() => {
    const normalizedQuery = actionQuery().trim().toLowerCase();
    if (!normalizedQuery) {
      return allActions();
    }

    return allActions().filter(({ action }) => {
      return (
        action.label.toLowerCase().includes(normalizedQuery) ||
        action.description.toLowerCase().includes(normalizedQuery)
      );
    });
  });

  const groupedActions = createMemo(() => {
    const grouped: Record<string, ActionCommand[]> = {};
    for (const command of filteredActions()) {
      if (!grouped[command.category]) {
        grouped[command.category] = [];
      }
      grouped[command.category].push(command);
    }
    return grouped;
  });

  const selectedAction = createMemo(() => {
    const actionType = selectedActionType();
    return actionType ? getInsertableActionDefinition(actionType) : undefined;
  });

  const targetOptions = createMemo<ActionTargetOption[]>(() => {
    const action = selectedAction();
    if (!action) return [];
    return getTargetsForAction(action.type, props.targets);
  });

  const filteredTargets = createMemo<ActionTargetOption[]>(() => {
    const normalizedQuery = targetQuery().trim().toLowerCase();
    if (!normalizedQuery) return targetOptions();

    const isIdLikeQuery = /^[0-9]+(?:\.[0-9]+)?$/.test(normalizedQuery);

    return targetOptions().filter((target) => {
      const searchableParts = [
        target.label,
        target.description,
        target.searchText,
      ].filter((part): part is string => Boolean(part));
      const haystack = searchableParts.join(" ").toLowerCase();

      if (isIdLikeQuery) {
        const tokens = haystack
          .split(/[^a-z0-9.]+/g)
          .filter((token) => token.length > 0);
        return tokens.includes(normalizedQuery);
      }

      return haystack.includes(normalizedQuery);
    });
  });

  /** Moves the highlighted action or target row, preserving disabled action skip behavior. */
  const moveSelection = (key: PaletteNavigationKey, pageSize = 1) => {
    if (step() === "command" || step() === "rate") return;
    const list = step() === "action" ? filteredActions() : filteredTargets();
    if (list.length === 0) return;

    const direction = key === "ArrowDown" || key === "PageDown" ? 1 : -1;
    if (step() === "action" && (key === "ArrowDown" || key === "ArrowUp")) {
      let nextIndex = selectedIndex();
      for (let i = 0; i < list.length; i += 1) {
        nextIndex = (nextIndex + direction + list.length) % list.length;
        if (filteredActions()[nextIndex]?.available) {
          setSelectedIndex(nextIndex);
          return;
        }
      }
      return;
    }

    const nextIndex = nextPaletteIndex(
      selectedIndex(),
      list.length,
      key,
      pageSize,
    );

    if (step() === "target" || filteredActions()[nextIndex]?.available) {
      setSelectedIndex(nextIndex);
      return;
    }

    for (let i = nextIndex; i >= 0 && i < list.length; i += direction) {
      if (filteredActions()[i]?.available) {
        setSelectedIndex(i);
        return;
      }
    }

    for (let i = nextIndex; i >= 0 && i < list.length; i -= direction) {
      if (filteredActions()[i]?.available) {
        setSelectedIndex(i);
        return;
      }
    }
  };

  /** Returns the current picker page size based on the visible option rows. */
  const currentPageSize = () => {
    const selectedElement = optionsListRef?.querySelector<HTMLElement>(
      '[data-insert-action-option-selected="true"]',
    );
    return visiblePaletteRowCount(optionsListRef, selectedElement ?? undefined);
  };

  /** Returns keyboard focus to the picker filter after pointer actions update the list. */
  const focusSearchInput = () => {
    requestAnimationFrame(() => inputRef?.focus());
  };

  const selectAction = (actionType: InsertableActionType) => {
    const action = filteredActions().find(
      (entry) => entry.action.type === actionType,
    );
    if (!action?.available) return;
    setSelectedActionType(actionType);
    setTargetQuery("");
    setPendingTarget(undefined);
    setStep(action.action.requiresCommand ? "command" : "target");
    setSelectedIndex(0);
    focusSearchInput();
  };

  const selectTarget = (target: ActionTargetOption) => {
    const action = selectedAction();
    if (!action) return;
    if (action.requiresRate) {
      setPendingTarget(target);
      setTargetQuery("1");
      setStep("rate");
      setSelectedIndex(0);
      focusSearchInput();
      return;
    }
    props.onInsert({
      actionType: action.type,
      targetUid: target.uid,
      targetLabel: target.label,
      cueIndex: action.requiresCueIndex ? (target.cueIndex ?? 1) : undefined,
    });
  };

  /** Inserts the current command text as a desk eval timeline action. */
  const insertCommandAction = () => {
    const action = selectedAction();
    const commandText = targetQuery().trim();
    if (!action || commandText.length === 0) return;
    props.onInsert({
      actionType: action.type,
      targetUid: commandText,
      targetLabel: commandText,
    });
  };

  /** Inserts the selected clip target with the typed playback rate multiplier. */
  const insertRateAction = () => {
    const action = selectedAction();
    const target = pendingTarget();
    const rate = Number.parseFloat(targetQuery().trim());
    if (!action || !target || !Number.isFinite(rate)) return;
    props.onInsert({
      actionType: action.type,
      targetUid: target.uid,
      targetLabel: `${target.label} @ ${Math.max(0, rate)}x`,
      rate: Math.max(0, rate),
    });
  };

  const executeSelected = () => {
    if (step() === "action") {
      const command = filteredActions()[selectedIndex()];
      if (!command?.available) return;
      selectAction(command.action.type);
      return;
    }

    if (step() === "command") {
      insertCommandAction();
      return;
    }

    if (step() === "rate") {
      insertRateAction();
      return;
    }

    const target = filteredTargets()[selectedIndex()];
    if (!target) return;
    selectTarget(target);
  };

  /** Captures picker input and restores focus only while its workspace is active. */
  createEffect(() => {
    if (!workspaceActive()) return;
    /** Handles picker navigation and submission before panel shortcuts. */
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (step() === "rate") {
          setStep("target");
          setTargetQuery("");
          setSelectedIndex(0);
          return;
        }
        if (step() === "target" || step() === "command") {
          setStep("action");
          setPendingTarget(undefined);
          setSelectedIndex(0);
          return;
        }
        props.onClose();
        return;
      }

      if (isPaletteNavigationKey(event.key)) {
        event.preventDefault();
        event.stopPropagation();
        const pageSize =
          event.key === "PageDown" || event.key === "PageUp"
            ? currentPageSize()
            : 1;
        moveSelection(event.key, pageSize);
        return;
      }

      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        executeSelected();
      }
    };

    /** Dismisses the active picker when a click lands outside its surface. */
    const handleMouseDown = (event: MouseEvent) => {
      if (containerRef && !containerRef.contains(event.target as Node)) {
        props.onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    window.addEventListener("mousedown", handleMouseDown, { capture: true });

    const focusFrame = requestAnimationFrame(() => {
      inputRef?.focus();
      inputRef?.select();
    });

    onCleanup(() => {
      cancelAnimationFrame(focusFrame);
      window.removeEventListener("keydown", handleKeyDown, {
        capture: true,
      });
      window.removeEventListener("mousedown", handleMouseDown, {
        capture: true,
      });
    });
  });

  createEffect(() => {
    if (step() === "command" || step() === "rate") return;
    const list = step() === "action" ? filteredActions() : filteredTargets();
    if (list.length === 0) {
      setSelectedIndex(0);
      return;
    }

    if (selectedIndex() >= list.length) {
      setSelectedIndex(0);
      return;
    }

    if (step() === "action" && !filteredActions()[selectedIndex()]?.available) {
      const firstAvailableIndex = filteredActions().findIndex(
        (entry) => entry.available,
      );
      if (firstAvailableIndex >= 0) {
        setSelectedIndex(firstAvailableIndex);
      }
    }
  });

  /** Keeps keyboard navigation from moving the highlighted option outside the picker viewport. */
  createEffect(() => {
    const listLength =
      step() === "action"
        ? filteredActions().length
        : step() === "target"
          ? filteredTargets().length
          : 0;
    if (listLength === 0 || selectedIndex() < 0) return;

    requestAnimationFrame(() => {
      optionsListRef
        ?.querySelector<HTMLElement>(
          '[data-insert-action-option-selected="true"]',
        )
        ?.scrollIntoView({ block: "nearest" });
    });
  });

  return (
    <SearchPickerSurface
      ref={containerRef}
      class="fixed nightfall-top-layer"
      data-component="InsertActionPicker"
      style={{
        display: workspaceActive() ? undefined : "none",
        left: `${getLeft()}px`,
        top: `${getTop()}px`,
        width: "min(512px, calc(100vw - 24px))",
        "max-height": `calc(100dvh - ${getTop() + 12}px)`,
      }}
    >
      <SearchPickerInput
        ref={inputRef}
        type="text"
        placeholder={
          step() === "action"
            ? "Insert action..."
            : step() === "command"
              ? "Desk command..."
              : step() === "rate"
                ? "Rate multiplier..."
                : `Select target for ${selectedAction()?.label ?? "action"}...`
        }
        value={step() === "action" ? actionQuery() : targetQuery()}
        onInput={(event) => {
          if (step() === "action") {
            setActionQuery(event.currentTarget.value);
          } else {
            setTargetQuery(event.currentTarget.value);
          }
          setSelectedIndex(0);
        }}
        trailing={
          <Show
            when={
              step() === "target" || step() === "command" || step() === "rate"
            }
          >
            <Button
              size="compact"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                if (step() === "rate") {
                  setStep("target");
                  setTargetQuery("");
                } else {
                  setStep("action");
                  setPendingTarget(undefined);
                }
                setSelectedIndex(0);
                focusSearchInput();
              }}
            >
              Back
            </Button>
          </Show>
        }
      />

      <ScrollArea
        class="min-h-0 max-h-[340px]"
        viewportProps={{
          ref: (element) => {
            optionsListRef = element;
          },
          role: "region",
          "aria-label": "Insert action options",
          tabIndex: 0,
          "data-slot": "options",
          "data-insert-action-options-list": "true",
        }}
      >
        <Show
          when={step() === "action"}
          fallback={
            <Show
              when={step() === "command"}
              fallback={
                <Show
                  when={step() === "rate"}
                  fallback={
                    <Show
                      when={filteredTargets().length > 0}
                      fallback={
                        <div class="px-6 py-10 text-center">
                          <h3 class="text-sm font-medium text-gray-100">
                            No targets found
                          </h3>
                          <p class="mt-1 text-sm text-gray-400">
                            Try a different search term, or press{" "}
                            <code>Escape</code>.
                          </p>
                        </div>
                      }
                    >
                      <ul>
                        <For each={filteredTargets()}>
                          {(target, index) => (
                            <li>
                              <SearchPickerOption
                                type="button"
                                data-insert-action-option-selected={
                                  index() === selectedIndex()
                                    ? "true"
                                    : undefined
                                }
                                selected={index() === selectedIndex()}
                                onMouseDown={(event) => event.preventDefault()}
                                onMouseEnter={() => setSelectedIndex(index())}
                                onClick={() => selectTarget(target)}
                              >
                                <div class="min-w-0 flex-1">
                                  <div class="font-medium">{target.label}</div>
                                  <Show when={target.description}>
                                    <div class="text-sm text-gray-400">
                                      {target.description}
                                    </div>
                                  </Show>
                                </div>
                              </SearchPickerOption>
                            </li>
                          )}
                        </For>
                      </ul>
                    </Show>
                  }
                >
                  <div class="px-3 py-3">
                    <SearchPickerOption
                      type="button"
                      selected
                      disabled={
                        !Number.isFinite(
                          Number.parseFloat(targetQuery().trim()),
                        )
                      }
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={insertRateAction}
                    >
                      Set {pendingTarget()?.label ?? "clip"} Rate
                    </SearchPickerOption>
                  </div>
                </Show>
              }
            >
              <div class="px-3 py-3">
                <SearchPickerOption
                  type="button"
                  selected
                  disabled={targetQuery().trim().length === 0}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={insertCommandAction}
                >
                  Insert Command
                </SearchPickerOption>
              </div>
            </Show>
          }
        >
          <Show
            when={filteredActions().length > 0}
            fallback={
              <div class="px-6 py-10 text-center">
                <h3 class="text-sm font-medium text-gray-100">
                  No actions found
                </h3>
                <p class="mt-1 text-sm text-gray-400">
                  Try a different search term, or press <code>Escape</code>.
                </p>
              </div>
            }
          >
            <ul>
              <For each={Object.entries(groupedActions())}>
                {([category, group]) => (
                  <li class="border-b border-gray-800">
                    <MenuHeading>{category}</MenuHeading>
                    <ul>
                      <For each={group}>
                        {(command) => {
                          const index = createMemo(() =>
                            filteredActions().findIndex(
                              (entry) =>
                                entry.action.type === command.action.type,
                            ),
                          );
                          const isSelected = createMemo(
                            () => index() === selectedIndex(),
                          );
                          return (
                            <li>
                              <SearchPickerOption
                                type="button"
                                data-insert-action-option-selected={
                                  isSelected() ? "true" : undefined
                                }
                                selected={isSelected()}
                                disabled={!command.available}
                                onMouseDown={(event) => event.preventDefault()}
                                onMouseEnter={() => {
                                  if (index() >= 0) {
                                    setSelectedIndex(index());
                                  }
                                }}
                                onClick={() => {
                                  if (!command.available) return;
                                  selectAction(command.action.type);
                                }}
                              >
                                <div class="min-w-0 flex-1">
                                  <div class="font-medium">
                                    {command.action.label}
                                  </div>
                                  <div class="text-sm text-gray-400">
                                    {command.action.description}
                                  </div>
                                  <Show when={!command.available}>
                                    <div class="mt-1 text-xs text-amber-400">
                                      No compatible targets loaded for this
                                      action.
                                    </div>
                                  </Show>
                                </div>
                              </SearchPickerOption>
                            </li>
                          );
                        }}
                      </For>
                    </ul>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </Show>
      </ScrollArea>
    </SearchPickerSurface>
  );
};
