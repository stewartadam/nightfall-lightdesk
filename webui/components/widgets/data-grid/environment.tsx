// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { type Component, For, type JSX } from "solid-js";

/** Receives the grid's diagnostic messages. */
export interface DataGridLogger {
  debug: (message: string) => void;
}

/** Unit of a performance sample recorded by an instrumented grid. */
export type DataGridPerformanceUnit = "ms" | "count";

/** One choice offered by the dropdown cell editor. */
export interface DataGridDropdownSelectOption {
  /** Stable option key reported back through `onSelect`. */
  value: string;
  label: string;
  /** Optional CSS color shown beside the label. */
  swatch?: string;
}

/** Props the grid passes to the dropdown cell editor. */
export interface DataGridDropdownSelectProps {
  options: readonly DataGridDropdownSelectOption[];
  /** Key of the currently selected option, or undefined when nothing is selected. */
  selectedKey: string | undefined;
  /** Called with the chosen option key when the user picks a different option. */
  onSelect: (key: string) => void;
  /** Ends editing without a change, such as on Escape; editors that already close themselves may ignore it. */
  onClose: () => void;
  ariaLabel: string;
}

/** Props the grid passes to the empty-state view shown below the headers. */
export interface DataGridEmptyStateProps {
  class: string;
  style: JSX.CSSProperties;
  /** The owner's `emptyState` message. */
  children: JSX.Element;
}

/**
 * Host services the grid needs but does not own: diagnostics, overlay
 * placement and the design-system components it embeds. A host application
 * installs its implementations once with `configureDataGrid`; anything left
 * unconfigured falls back to a self-contained default.
 */
export interface DataGridEnvironment {
  logger: DataGridLogger;
  /** Records one sample from a grid that sets `performanceScope`. */
  recordPerformanceMeasure: (
    name: string,
    value: number,
    unit?: DataGridPerformanceUnit,
  ) => void;
  /** Returns the element that floating grid overlays portal into; undefined uses the document body. */
  overlayMount: () => Node | undefined;
  /** Editor rendered inside a dropdown cell while it is being edited. */
  DropdownSelect: Component<DataGridDropdownSelectProps>;
  /** View shown when a grid with an `emptyState` message has no rows. */
  EmptyState: Component<DataGridEmptyStateProps>;
}

/** Native `<select>` editor used until the host installs a styled one. */
function NativeDropdownSelect(props: DataGridDropdownSelectProps) {
  return (
    <select
      class="h-full w-full bg-transparent"
      aria-label={props.ariaLabel}
      value={props.selectedKey ?? ""}
      ref={(element) => queueMicrotask(() => element.focus())}
      onChange={(event) => props.onSelect(event.currentTarget.value)}
      on:keydown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          props.onClose();
        }
      }}
    >
      <option value="" disabled hidden />
      <For each={props.options}>
        {(option) => <option value={option.value}>{option.label}</option>}
      </For>
    </select>
  );
}

/** Plain status line used until the host installs its own empty-state view. */
function PlainEmptyState(props: DataGridEmptyStateProps) {
  return (
    <div role="status" class={props.class} style={props.style}>
      {props.children}
    </div>
  );
}

/** Builds the self-contained environment used before any host configuration. */
function defaultEnvironment(): DataGridEnvironment {
  return {
    logger: { debug: () => {} },
    recordPerformanceMeasure: () => {},
    overlayMount: () => undefined,
    DropdownSelect: NativeDropdownSelect,
    EmptyState: PlainEmptyState,
  };
}

let environment = defaultEnvironment();

/**
 * Installs the host's implementations of the grid's environment services.
 * Call it once at startup, before the first grid renders; services that are
 * not passed keep their defaults.
 */
export function configureDataGrid(overrides: Partial<DataGridEnvironment>) {
  environment = { ...defaultEnvironment(), ...overrides };
}

/** Returns the environment services the grid currently uses. */
export function dataGridEnvironment(): DataGridEnvironment {
  return environment;
}
