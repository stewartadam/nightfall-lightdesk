// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { FunnelIcon } from "@squidlab/phosphor-solid/funnel";
import { MagnifyingGlassIcon } from "@squidlab/phosphor-solid/magnifying-glass";
import { XIcon } from "@squidlab/phosphor-solid/x";
import { For, Index, Match, Show, Switch } from "solid-js";
import {
  type DataGridFilterColumnMeta,
  type DataGridFilterKind,
  type DataGridFilterOperator,
  type DataGridFilterRule,
  type DataGridFilterValue,
  EMPTY_TABLE_FILTERS,
  getActiveTableFilterCount,
  hasActiveTableFilters,
  type TableFilterSettings,
} from "../../../../lib/datagrid-filtering";
import { DropdownMenu, DropdownMenuSeparator } from "../../../ui/dropdown-menu";
import { ScrollArea } from "../../../ui/scroll-area";
import { TOOLBAR_BUTTON_CLASS } from "../../../ui/toolbar-button";

interface DataGridFilterMenuProps {
  columns: readonly DataGridFilterColumnMeta[];
  filters: TableFilterSettings;
  visibleRows: number;
  totalRows: number;
  onFiltersChange: (filters: TableFilterSettings) => void;
  placement?: "above" | "below";
}

interface OperatorOption {
  value: DataGridFilterOperator;
  label: string;
}

const FIELD_CLASS =
  "min-w-0 rounded border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-xs text-neutral-100 outline-none focus:border-blue-500";

const TEXT_OPERATORS: OperatorOption[] = [
  { value: "contains", label: "contains" },
  { value: "not_contains", label: "does not contain" },
  { value: "equals", label: "equals" },
  { value: "not_equals", label: "does not equal" },
  { value: "starts_with", label: "starts with" },
  { value: "is_empty", label: "is empty" },
  { value: "is_not_empty", label: "is not empty" },
];

const NUMBER_OPERATORS: OperatorOption[] = [
  { value: "equals", label: "=" },
  { value: "not_equals", label: "!=" },
  { value: "lt", label: "<" },
  { value: "lte", label: "<=" },
  { value: "gt", label: ">" },
  { value: "gte", label: ">=" },
  { value: "between", label: "between" },
  { value: "is_empty", label: "is empty" },
  { value: "is_not_empty", label: "is not empty" },
];

const BOOLEAN_OPERATORS: OperatorOption[] = [{ value: "equals", label: "is" }];

const ENUM_OPERATORS: OperatorOption[] = [
  { value: "equals", label: "is" },
  { value: "not_equals", label: "is not" },
  { value: "is_empty", label: "is empty" },
  { value: "is_not_empty", label: "is not empty" },
];

const TAG_OPERATORS: OperatorOption[] = [
  { value: "has", label: "has" },
  { value: "not_has", label: "does not have" },
  { value: "has_any", label: "has any" },
  { value: "has_all", label: "has all" },
  { value: "is_empty", label: "is empty" },
  { value: "is_not_empty", label: "is not empty" },
];

function operatorsFor(kind: DataGridFilterKind): OperatorOption[] {
  switch (kind) {
    case "number":
      return NUMBER_OPERATORS;
    case "boolean":
      return BOOLEAN_OPERATORS;
    case "enum":
      return ENUM_OPERATORS;
    case "tag":
      return TAG_OPERATORS;
    default:
      return TEXT_OPERATORS;
  }
}

function defaultOperatorFor(kind: DataGridFilterKind): DataGridFilterOperator {
  return operatorsFor(kind)[0]?.value ?? "contains";
}

function defaultValueFor(kind: DataGridFilterKind): DataGridFilterValue {
  switch (kind) {
    case "boolean":
      return true;
    case "number":
      return "";
    case "tag":
      return "";
    default:
      return "";
  }
}

function operatorNeedsValue(operator: DataGridFilterOperator): boolean {
  return operator !== "is_empty" && operator !== "is_not_empty";
}

function stringifyFilterValue(value: DataGridFilterValue | undefined): string {
  if (Array.isArray(value)) return value.join(", ");
  if (value === null || value === undefined) return "";
  return String(value);
}

function parseTagValue(value: string, operator: DataGridFilterOperator) {
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (operator === "has_any" || operator === "has_all") {
    return entries;
  }
  return entries[0] ?? "";
}

function normalizeRuleForColumn(
  rule: DataGridFilterRule,
  column: DataGridFilterColumnMeta,
): DataGridFilterRule {
  const operator = operatorsFor(column.kind).some(
    (option) => option.value === rule.operator,
  )
    ? rule.operator
    : defaultOperatorFor(column.kind);

  return {
    columnId: column.id,
    operator,
    value: operatorNeedsValue(operator) ? defaultValueFor(column.kind) : null,
  };
}

export default function DataGridFilterMenu(props: DataGridFilterMenuProps) {
  const activeCount = () => getActiveTableFilterCount(props.filters);

  const isActive = () => hasActiveTableFilters(props.filters);

  const columnForRule = (rule: DataGridFilterRule) =>
    props.columns.find((column) => column.id === rule.columnId) ??
    props.columns[0];

  const updateFilters = (partial: Partial<TableFilterSettings>) => {
    props.onFiltersChange({
      ...props.filters,
      ...partial,
    });
  };

  const setQuickFilter = (quickFilter: string) => {
    updateFilters({ quickFilter });
  };

  const addRule = () => {
    const column = props.columns[0];
    if (!column) return;

    updateFilters({
      rules: [
        ...props.filters.rules,
        {
          columnId: column.id,
          operator: defaultOperatorFor(column.kind),
          value: defaultValueFor(column.kind),
        },
      ],
    });
  };

  const updateRule = (index: number, rule: DataGridFilterRule) => {
    updateFilters({
      rules: props.filters.rules.map((current, currentIndex) =>
        currentIndex === index ? rule : current,
      ),
    });
  };

  const removeRule = (index: number) => {
    updateFilters({
      rules: props.filters.rules.filter(
        (_, currentIndex) => currentIndex !== index,
      ),
    });
  };

  const clearFilters = () => {
    props.onFiltersChange({ ...EMPTY_TABLE_FILTERS });
  };

  return (
    <DropdownMenu
      placement={props.placement ?? "below"}
      align="end"
      triggerLabel="Table filters"
      trigger={
        <span
          class={`${TOOLBAR_BUTTON_CLASS} relative ${
            isActive() ? "bg-blue-500/20 text-blue-100" : ""
          }`.trim()}
        >
          <FunnelIcon class="size-5" aria-hidden />
          <Show when={activeCount() > 0}>
            <span class="-right-0.5 -top-0.5 absolute rounded bg-blue-600 px-1 text-[10px] leading-4 text-white">
              {activeCount()}
            </span>
          </Show>
        </span>
      }
    >
      <div class="w-[34rem] py-1" data-menu-kind="datagrid-filter">
        <div class="px-3 py-2">
          <div class="mb-2 flex items-center justify-between gap-2">
            <span class="text-xs font-medium uppercase tracking-wide text-neutral-400">
              Filters
            </span>
            <span class="text-xs text-neutral-500">
              {props.visibleRows} of {props.totalRows} rows
            </span>
          </div>
          <div class="relative">
            <MagnifyingGlassIcon
              class="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-neutral-500"
              aria-hidden
            />
            <input
              type="text"
              value={props.filters.quickFilter}
              onInput={(event) => setQuickFilter(event.currentTarget.value)}
              aria-label="Quick row filter"
              placeholder="Filter rows"
              class="w-full rounded border border-neutral-700 bg-neutral-900 py-1.5 pl-8 pr-8 text-sm text-neutral-100 placeholder-neutral-500 outline-none focus:border-blue-500"
            />
            <Show when={props.filters.quickFilter.trim().length > 0}>
              <button
                type="button"
                class="absolute right-1 top-1/2 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded text-neutral-400 hover:bg-neutral-700 hover:text-neutral-100"
                onClick={() => setQuickFilter("")}
                aria-label="Clear quick row filter"
              >
                <XIcon class="size-4" aria-hidden />
              </button>
            </Show>
          </div>
        </div>
        <DropdownMenuSeparator />
        <ScrollArea
          class="max-h-80"
          viewportClass="space-y-2 px-3 py-2"
          viewportProps={{
            role: "region",
            "aria-label": "Column filters",
            tabIndex: 0,
          }}
        >
          <Show
            when={props.filters.rules.length > 0}
            fallback={
              <div class="rounded border border-dashed border-neutral-700 px-3 py-3 text-center text-xs text-neutral-500">
                No column filters
              </div>
            }
          >
            <Index each={props.filters.rules}>
              {(rule, index) => {
                const column = () => columnForRule(rule());

                const operators = () =>
                  column() ? operatorsFor(column()!.kind) : TEXT_OPERATORS;

                return (
                  <div class="grid grid-cols-[8rem_8rem_minmax(0,1fr)_2rem] items-center gap-2 rounded border border-neutral-700 bg-neutral-900/60 p-2">
                    <select
                      class={FIELD_CLASS}
                      value={rule().columnId}
                      aria-label="Filter column"
                      onChange={(event) => {
                        const nextColumn = props.columns.find(
                          (candidate) =>
                            candidate.id === event.currentTarget.value,
                        );
                        if (!nextColumn) return;
                        updateRule(
                          index,
                          normalizeRuleForColumn(rule(), nextColumn),
                        );
                      }}
                    >
                      <For each={props.columns}>
                        {(column) => (
                          <option value={column.id}>{column.label}</option>
                        )}
                      </For>
                    </select>
                    <select
                      class={FIELD_CLASS}
                      value={rule().operator}
                      aria-label="Filter operator"
                      onChange={(event) => {
                        const nextOperator = event.currentTarget
                          .value as DataGridFilterOperator;
                        const currentRule = rule();
                        updateRule(index, {
                          ...currentRule,
                          operator: nextOperator,
                          value: operatorNeedsValue(nextOperator)
                            ? (currentRule.value ??
                              defaultValueFor(column()?.kind ?? "text"))
                            : null,
                          secondValue:
                            nextOperator === "between"
                              ? (currentRule.secondValue ?? "")
                              : undefined,
                        });
                      }}
                    >
                      <For each={operators()}>
                        {(operator) => (
                          <option value={operator.value}>
                            {operator.label}
                          </option>
                        )}
                      </For>
                    </select>
                    <div class="min-w-0">
                      <Show
                        when={column() && operatorNeedsValue(rule().operator)}
                        fallback={
                          <span class="block px-2 text-xs text-neutral-500">
                            No value
                          </span>
                        }
                      >
                        <FilterValueEditor
                          column={column()!}
                          rule={rule()}
                          onRuleChange={(nextRule) =>
                            updateRule(index, nextRule)
                          }
                        />
                      </Show>
                    </div>
                    <button
                      type="button"
                      class="inline-flex size-8 items-center justify-center rounded text-neutral-400 hover:bg-neutral-700 hover:text-neutral-100"
                      onClick={() => removeRule(index)}
                      aria-label="Remove column filter"
                    >
                      <XIcon class="size-4" aria-hidden />
                    </button>
                  </div>
                );
              }}
            </Index>
          </Show>
        </ScrollArea>
        <DropdownMenuSeparator />
        <div class="flex items-center justify-between gap-2 px-3 py-2">
          <button
            type="button"
            class="text-xs text-blue-300 hover:text-blue-200 disabled:text-neutral-600"
            disabled={props.columns.length === 0}
            onClick={addRule}
          >
            Add filter
          </button>
          <button
            type="button"
            class="text-xs text-blue-300 hover:text-blue-200 disabled:text-neutral-600"
            disabled={!isActive()}
            onClick={clearFilters}
          >
            Clear all
          </button>
        </div>
      </div>
    </DropdownMenu>
  );
}

function FilterValueEditor(props: {
  column: DataGridFilterColumnMeta;
  rule: DataGridFilterRule;
  onRuleChange: (rule: DataGridFilterRule) => void;
}) {
  const setValue = (value: DataGridFilterValue) => {
    props.onRuleChange({
      ...props.rule,
      value,
    });
  };

  return (
    <Switch
      fallback={
        <input
          type={props.column.kind === "number" ? "number" : "text"}
          class={`${FIELD_CLASS} w-full`}
          value={stringifyFilterValue(props.rule.value)}
          aria-label="Filter value"
          placeholder={
            props.column.kind === "tag" &&
            (props.rule.operator === "has_any" ||
              props.rule.operator === "has_all")
              ? "tag, tag"
              : "Value"
          }
          onInput={(event) => {
            const inputValue = event.currentTarget.value;
            setValue(
              props.column.kind === "tag"
                ? parseTagValue(inputValue, props.rule.operator)
                : inputValue,
            );
          }}
        />
      }
    >
      <Match when={props.column.kind === "boolean"}>
        <select
          class={`${FIELD_CLASS} w-full`}
          value={String(props.rule.value ?? true)}
          aria-label="Filter value"
          onChange={(event) => setValue(event.currentTarget.value === "true")}
        >
          <option value="true">True</option>
          <option value="false">False</option>
        </select>
      </Match>
      <Match
        when={props.column.kind === "enum" && props.column.options?.length}
      >
        <select
          class={`${FIELD_CLASS} w-full`}
          value={stringifyFilterValue(props.rule.value)}
          aria-label="Filter value"
          onChange={(event) => setValue(event.currentTarget.value)}
        >
          <For each={props.column.options}>
            {(option) => (
              <option value={String(option.value)}>{option.label}</option>
            )}
          </For>
        </select>
      </Match>
      <Match when={props.rule.operator === "between"}>
        <div class="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
          <input
            type="number"
            class={`${FIELD_CLASS} w-full`}
            value={stringifyFilterValue(props.rule.value)}
            aria-label="Filter value"
            onInput={(event) => setValue(event.currentTarget.value)}
          />
          <span class="text-xs text-neutral-500">and</span>
          <input
            type="number"
            class={`${FIELD_CLASS} w-full`}
            value={stringifyFilterValue(props.rule.secondValue)}
            aria-label="Second filter value"
            onInput={(event) =>
              props.onRuleChange({
                ...props.rule,
                secondValue: event.currentTarget.value,
              })
            }
          />
        </div>
      </Match>
    </Switch>
  );
}
