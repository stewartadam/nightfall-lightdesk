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
import { Portal } from "solid-js/web";
import { ScrollIndicators } from "../../ui/scroll-area";

export interface PrelineAdvancedSelectOption {
  value: string;
  label: string;
}

type PrelineSelectInstance = {
  element?: {
    close?: (forceFocus?: boolean) => false | undefined;
    destroy?: () => void;
    dropdown?: HTMLElement;
    isOpened?: () => boolean;
    open?: () => void;
    setValue?: (value: string | string[]) => void;
  };
};

type PrelineSelectConstructor = {
  getInstance?: (
    target: string | HTMLSelectElement,
    asObject?: boolean,
  ) => PrelineSelectInstance | undefined;
};

const PANEL_TOGGLE_CLASSES =
  "hs-select-disabled:pointer-events-none hs-select-disabled:opacity-50 relative flex min-h-9 w-full cursor-pointer items-center text-nowrap rounded border border-neutral-700 bg-neutral-800/40 py-2 ps-3 pe-9 text-start text-sm text-neutral-100 transition-colors hover:border-neutral-500 hover:bg-neutral-700/60 focus:border-neutral-500 focus:bg-neutral-700/60 focus:outline-hidden";

const GRID_TOGGLE_CLASSES =
  "hs-select-disabled:pointer-events-none hs-select-disabled:opacity-50 relative flex h-full min-h-full w-full cursor-pointer items-center truncate border-0 bg-transparent px-2 pe-7 py-0 text-start text-sm leading-none text-white outline-hidden hover:bg-white/5 focus:bg-white/10";

const ADVANCED_SELECT_BASE_CONFIG = {
  placeholder: "None",
  toggleTag: '<button type="button" aria-expanded="false"></button>',
  toggleCountText: "selected",
  toggleCountTextMinItems: 2,
  toggleCountTextMode: "nItemsAndCount",
  dropdownPlacement: "bottom-left",
  dropdownAutoPlacement: true,
  dropdownScope: "window",
  dropdownClasses:
    "nf-select-menu mt-2 nightfall-popover-layer w-full min-w-44 max-h-72 p-1 space-y-0.5 bg-neutral-900 border border-white/15 rounded-lg shadow-xl overflow-hidden overflow-y-auto",
  optionClasses:
    "nf-select-option w-full cursor-pointer rounded-lg px-4 py-2 text-sm text-neutral-100 transition-colors hover:bg-neutral-700 focus:bg-neutral-700 focus:outline-hidden",
  optionTemplate:
    '<div class="flex w-full items-center justify-between"><span data-title></span><span class="hidden hs-selected:block"><svg class="size-3.5 shrink-0 text-sky-400" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span></div>',
  extraMarkup:
    '<div class="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-neutral-400"><svg class="size-3.5 shrink-0" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/></svg></div>',
};

let nextSelectId = 0;

/** Returns the Preline Advanced Select constructor attached to the window. */
function prelineSelectConstructor(): PrelineSelectConstructor | undefined {
  return (window as unknown as { HSSelect?: PrelineSelectConstructor })
    .HSSelect;
}

/** Returns the mounted Preline instance for a select element. */
function prelineSelectInstance(
  select: HTMLSelectElement | undefined,
): PrelineSelectInstance | undefined {
  if (!select) return undefined;
  return prelineSelectConstructor()?.getInstance?.(select, true);
}

/** Extracts selected values from the native select backing Preline. */
function selectedValuesFromSelect(select: HTMLSelectElement): string[] {
  if (select.multiple) {
    return Array.from(select.selectedOptions).map((option) => option.value);
  }
  return select.selectedIndex >= 0 ? [select.value] : [];
}

/** Returns whether two selected value lists are identical in order and content. */
function selectedValuesEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length && left.every((value, i) => value === right[i])
  );
}

/** Renders a reusable Preline Advanced Select control. */
export function PrelineAdvancedSelect(props: {
  options: readonly PrelineAdvancedSelectOption[];
  selectedValues: readonly string[];
  onSelectedValuesChange: (selectedValues: readonly string[]) => void;
  ariaLabel?: string;
  containerClass?: string;
  selectIdPrefix?: string;
  variant?: "panel" | "grid";
  multiple?: boolean;
  searchable?: boolean;
  openOnMount?: boolean;
  toggleSummaryText?: (selectedValues: readonly string[]) => string;
}) {
  let selectElement: HTMLSelectElement | undefined;
  let initialized = false;
  let pendingSelectedValues: readonly string[] | undefined;
  let committedSelectedValues: readonly string[] = props.selectedValues;
  let outsidePointerStartedWithOpen = false;
  let restorePrelineClose: (() => void) | undefined;
  const [dropdownViewport, setDropdownViewport] = createSignal<HTMLElement>();
  const selectId = `${props.selectIdPrefix ?? "preline-advanced-select"}-${nextSelectId++}`;

  /** Returns the Preline configuration used to render the select shell. */
  const advancedSelectConfig = createMemo(() => {
    const gridVariant = props.variant === "grid";
    return JSON.stringify({
      ...ADVANCED_SELECT_BASE_CONFIG,
      toggleClasses: `nf-select-toggle ${gridVariant ? GRID_TOGGLE_CLASSES : PANEL_TOGGLE_CLASSES}`,
      wrapperClasses: gridVariant ? "h-full w-full" : "w-full",
      hasSearch: props.searchable ?? false,
      searchPlaceholder: "Search options",
      searchWrapperClasses:
        "nf-select-search-wrapper bg-neutral-900 p-1 sticky top-0",
      searchClasses:
        "nf-select-search block w-full bg-neutral-800 border border-neutral-600 rounded px-3 py-2 text-sm text-neutral-100",
    });
  });

  /** Returns selected values in a stable key for Preline synchronization. */
  const selectedValuesKey = createMemo(() => props.selectedValues.join("|"));

  /** Returns the current selected values as a set for option rendering. */
  const selectedValueSet = createMemo(() => new Set(props.selectedValues));

  /** Returns the generated Preline toggle button for the mounted select. */
  const advancedSelectToggle = () =>
    selectElement
      ?.closest(".hs-select")
      ?.querySelector<HTMLButtonElement>("button[aria-expanded]");

  /** Replaces Preline's toggle label when the caller provides a summary. */
  const syncToggleSummaryText = (selectedValues: readonly string[]) => {
    const toggle = advancedSelectToggle();
    if (!toggle || !props.toggleSummaryText) return;
    toggle.textContent = props.toggleSummaryText(selectedValues);
  };

  /** Returns whether the Preline menu is open or still active in the DOM. */
  const isAdvancedSelectOpen = () => {
    const instance = prelineSelectInstance(selectElement)?.element;
    return Boolean(
      instance?.isOpened?.() ||
        instance?.dropdown?.classList.contains("opened") ||
        selectElement?.closest(".hs-select")?.classList.contains("active"),
    );
  };

  /** Reads the current native selection from the mounted select. */
  const currentSelectedValues = () =>
    selectElement ? selectedValuesFromSelect(selectElement) : [];

  /** Aligns the hidden native select options with the controlled selected values. */
  const syncNativeSelectSelection = (selectedValues: readonly string[]) => {
    if (!selectElement) return;
    const selectedSet = new Set(selectedValues);
    for (const option of Array.from(selectElement.options)) {
      option.selected = selectedSet.has(option.value);
    }
  };

  /** Restores preserved multi-select values when Preline reports an add as a replacement. */
  const normalizedMultipleSelectedValues = (
    selectedValues: readonly string[],
  ): readonly string[] => {
    if (!props.multiple) return selectedValues;
    const previousValues = pendingSelectedValues ?? committedSelectedValues;
    const selectedValueSet = new Set(selectedValues);
    const previousValueSet = new Set(previousValues);
    const addedValues = selectedValues.filter(
      (value) => !previousValueSet.has(value),
    );
    const removedValues = previousValues.filter(
      (value) => !selectedValueSet.has(value),
    );
    if (
      selectedValues.length === 1 &&
      previousValues.length > 1 &&
      !previousValueSet.has(selectedValues[0]!)
    ) {
      return [...previousValues, selectedValues[0]!];
    }
    if (addedValues.length !== 1 || removedValues.length !== 1) {
      return selectedValues;
    }
    return [...previousValues, addedValues[0]];
  };

  /** Commits any selection captured while the Preline menu was open. */
  const flushPendingSelectedValues = (force = false) => {
    if (!pendingSelectedValues) {
      if (force) {
        requestAnimationFrame(() =>
          syncToggleSummaryText(props.selectedValues),
        );
      }
      return;
    }
    const selectedValues = pendingSelectedValues ?? currentSelectedValues();
    pendingSelectedValues = undefined;
    committedSelectedValues = selectedValues;
    props.onSelectedValuesChange(selectedValues);
    requestAnimationFrame(() => syncToggleSummaryText(selectedValues));
  };

  /** Installs a close hook so app state changes do not re-render open menus. */
  const installCloseFlush = () => {
    const instance = prelineSelectInstance(selectElement)?.element;
    if (!instance?.close || restorePrelineClose) return;

    const originalClose = instance.close.bind(instance);
    instance.close = (forceFocus?: boolean) => {
      const wasOpened = instance.isOpened?.() ?? false;
      const result = originalClose(forceFocus);
      if (result !== false && wasOpened && !instance.isOpened?.()) {
        flushPendingSelectedValues(true);
      }
      return result;
    };

    restorePrelineClose = () => {
      instance.close = originalClose;
    };
  };

  /** Records whether an outside pointer action started while the menu was open. */
  const handleDocumentPointerDown = (event: PointerEvent) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const option = target.closest("[data-hs-select-dropdown] [data-value]");
    const dropdown = prelineSelectInstance(selectElement)?.element?.dropdown;
    if (props.multiple && option && dropdown?.contains(option)) {
      const selectedOptionValues = Array.from(
        dropdown.querySelectorAll<HTMLElement>("[data-value].selected"),
        (selectedOption) => selectedOption.getAttribute("data-value"),
      ).filter((value): value is string => value !== null);
      committedSelectedValues =
        pendingSelectedValues ??
        (selectedOptionValues.length > 0
          ? selectedOptionValues
          : currentSelectedValues());
    }
    if (target.closest(".hs-select, [data-hs-select-dropdown]")) return;
    outsidePointerStartedWithOpen = isAdvancedSelectOpen();
  };

  /** Commits buffered changes when an outside click closes the Preline menu. */
  const handleDocumentClick = (event: MouseEvent) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest(".hs-select, [data-hs-select-dropdown]")) return;
    flushPendingSelectedValues(outsidePointerStartedWithOpen);
    outsidePointerStartedWithOpen = false;
  };

  /** Closes a portaled menu on Escape even when clicking an option moved focus outside its wrapper. */
  const handleDocumentKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !isAdvancedSelectOpen()) return;
    event.preventDefault();
    event.stopPropagation();
    prelineSelectInstance(selectElement)?.element?.close?.(true);
  };

  /** Stores open-menu changes locally and commits closed-menu changes directly. */
  const commitSelectedValues = (selectedValues: readonly string[]) => {
    if (!props.multiple) {
      pendingSelectedValues = undefined;
      committedSelectedValues = selectedValues;
      props.onSelectedValuesChange(selectedValues);
      return;
    }

    if (isAdvancedSelectOpen()) {
      pendingSelectedValues = selectedValues;
      return;
    }

    pendingSelectedValues = undefined;
    committedSelectedValues = selectedValues;
    props.onSelectedValuesChange(selectedValues);
  };

  /** Captures native select changes emitted by Preline and test utilities. */
  const handleSelectChange = (event: Event) => {
    const select = event.currentTarget as HTMLSelectElement;
    const rawSelectedValues = selectedValuesFromSelect(select);
    const selectedValues = normalizedMultipleSelectedValues(rawSelectedValues);
    if (!selectedValuesEqual(rawSelectedValues, selectedValues)) {
      const normalizedSet = new Set(selectedValues);
      for (const option of Array.from(select.options)) {
        option.selected = normalizedSet.has(option.value);
      }
    }
    commitSelectedValues(selectedValues);
    requestAnimationFrame(() => syncToggleSummaryText(selectedValues));
  };

  /** Opens the Preline dropdown after initialization when requested. */
  const openInitializedSelect = () => {
    if (!props.openOnMount) return;
    committedSelectedValues = props.selectedValues;
    const toggle = advancedSelectToggle();
    const instance = prelineSelectInstance(selectElement)?.element;
    toggle?.focus();
    toggle?.click();
    if (!isAdvancedSelectOpen()) {
      instance?.open?.();
    }
  };

  /** Initializes the Preline select plugin once for this mounted select. */
  const initializeAdvancedSelect = () => {
    if (!selectElement) return;
    syncNativeSelectSelection(props.selectedValues);
    window.HSStaticMethods?.autoInit(["select"]);
    advancedSelectToggle()?.setAttribute(
      "aria-label",
      props.ariaLabel ?? "Choose value",
    );
    initialized = true;
    setDropdownViewport(
      prelineSelectInstance(selectElement)?.element?.dropdown,
    );
    installCloseFlush();
    selectElement.addEventListener("change", handleSelectChange);
    window.addEventListener("pointerdown", handleDocumentPointerDown, true);
    window.addEventListener("click", handleDocumentClick);
    document.addEventListener("keydown", handleDocumentKeyDown, true);
    syncAdvancedSelectValue();
    requestAnimationFrame(openInitializedSelect);
  };

  /** Pushes external value changes into the existing Preline instance when closed. */
  const syncAdvancedSelectValue = () => {
    if (!initialized) return;
    const instance = prelineSelectInstance(selectElement)?.element;
    if (isAdvancedSelectOpen()) return;
    committedSelectedValues = props.selectedValues;
    syncNativeSelectSelection(props.selectedValues);
    instance?.setValue?.(
      props.multiple
        ? [...props.selectedValues]
        : (props.selectedValues[0] ?? ""),
    );
    requestAnimationFrame(() => syncToggleSummaryText(props.selectedValues));
  };

  /** Initializes the Advanced Select after the hidden select is mounted. */
  onMount(() => {
    requestAnimationFrame(initializeAdvancedSelect);
  });

  /** Re-synchronizes the Preline instance whenever selected values change. */
  createEffect(() => {
    selectedValuesKey();
    requestAnimationFrame(syncAdvancedSelectValue);
  });

  /** Destroys the Preline select instance before Solid removes the selector. */
  onCleanup(() => {
    flushPendingSelectedValues();
    selectElement?.removeEventListener("change", handleSelectChange);
    window.removeEventListener("pointerdown", handleDocumentPointerDown, true);
    window.removeEventListener("click", handleDocumentClick);
    document.removeEventListener("keydown", handleDocumentKeyDown, true);
    restorePrelineClose?.();
    prelineSelectInstance(selectElement)?.element?.destroy?.();
  });

  return (
    <div class={props.containerClass ?? "h-full w-full"}>
      <Show when={dropdownViewport()}>
        {(viewport) => (
          <Portal>
            <ScrollIndicators
              viewport={viewport()}
              stickyHeader={viewport().querySelector<HTMLElement>(
                ".nf-select-search-wrapper",
              )}
              fixed
            />
          </Portal>
        )}
      </Show>
      <select
        id={selectId}
        ref={(element) => {
          selectElement = element;
        }}
        multiple={props.multiple}
        aria-label={props.ariaLabel ?? "Choose value"}
        data-hs-select={advancedSelectConfig()}
        class="hidden"
      >
        <For each={props.options}>
          {(option) => (
            <option
              value={option.value}
              selected={selectedValueSet().has(option.value)}
            >
              {option.label}
            </option>
          )}
        </For>
      </select>
    </div>
  );
}
