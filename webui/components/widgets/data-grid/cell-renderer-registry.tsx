// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { Accessor, JSX, Setter } from "solid-js";
import { createSignal, onCleanup, Show } from "solid-js";
import { Dynamic, Portal } from "solid-js/web";
import type {
  CustomCell,
  CustomRenderer,
  GridCell,
  GridCellStateIndicator,
  GridSelection,
  Item,
} from "../../../lib/data-grid-types";
import { GridCellKind } from "../../../lib/data-grid-types";
import { isPrintableTextEntryEvent } from "../../../lib/keyboardShortcutEvents";
import {
  type DropdownGridCell,
  dropdownDisplayValue,
  dropdownOptions,
  isDropdownCell,
  makeDropdownEditedCellByValue,
} from "../../../lib/tanstack-dropdown-cell";
import { DropdownCellAffordance } from "./cells/dropdown-cell-affordance";
import { DropdownCellSelect } from "./cells/dropdown-cell-select";
import {
  canEditBooleanCell,
  canEditDropdownCell,
  cellDisplayValue,
  findCustomRenderer,
  isReadonlyCell,
} from "./model/cell-utils";
import { findRichCellExtension } from "./model/rich-cell-extension";
import type {
  DataGridCellEditFactory,
  DataGridEditCommitContext,
  DataGridInlineEditTooltipContext,
  DataGridRichCellExtension,
  EditingCell,
} from "./model/types";

export interface CellContentContext {
  cell: GridCell;
  col: number;
  row: number;
  customRenderers?: readonly CustomRenderer<any>[];
  richCellExtensions?: readonly DataGridRichCellExtension[];
  editingCellKind?: EditingCell["kind"];
  editingExtensionId?: string;
  editingValue: Accessor<string>;
  commitDiscreteEdit: (
    cell: Item,
    makeEditedCell: DataGridCellEditFactory,
  ) => void;
  onCellEdited?: (
    cell: Item,
    newValue: GridCell,
    selection?: GridSelection,
    context?: DataGridEditCommitContext,
  ) => void;
  inlineEditTooltip?: (
    context: DataGridInlineEditTooltipContext,
  ) => string | undefined;
  selectCell: (
    target: Item,
    options: { append?: boolean; extend: boolean; scroll?: boolean },
  ) => void;
  setActiveCell: (cell: Item | undefined) => void;
  setEditingCell: Setter<EditingCell | undefined>;
  setInputRef: (element: HTMLInputElement) => void;
  commitEdit: (mode?: "default" | "alternate") => void;
  cancelEdit: () => void;
}

export interface CellContentResolution {
  element: JSX.Element;
  padded: boolean;
  customCanvasRenderer?: CustomRenderer;
}

interface DataGridCellRenderer {
  id: string;
  matches: (context: CellContentContext) => boolean;
  render: (context: CellContentContext) => JSX.Element;
  padded?: boolean | ((context: CellContentContext) => boolean);
}

interface DataGridCellEditor {
  id: string;
  matches: (context: CellContentContext) => boolean;
  render: (context: CellContentContext) => JSX.Element;
  padded?: boolean;
}

const textCellEditor: DataGridCellEditor = {
  id: "text",
  matches: ({ editingCellKind }) => editingCellKind === GridCellKind.Text,
  render: renderTextInputEditor,
};

const numberCellEditor: DataGridCellEditor = {
  id: "number",
  matches: ({ editingCellKind }) => editingCellKind === GridCellKind.Number,
  render: renderTextInputEditor,
};

const booleanCellEditor: DataGridCellEditor = {
  id: "boolean",
  matches: ({ cell }) => canEditBooleanCell(cell),
  render: renderBooleanCheckbox,
};

const dropdownCellEditor: DataGridCellEditor = {
  id: "dropdown",
  matches: ({ cell, editingCellKind }) =>
    editingCellKind === "dropdown" && canEditDropdownCell(cell),
  render: renderDropdownSelect,
  padded: false,
};

const builtInCellEditors: readonly DataGridCellEditor[] = [
  textCellEditor,
  numberCellEditor,
  booleanCellEditor,
  dropdownCellEditor,
];

const textCellRenderer: DataGridCellRenderer = {
  id: "text",
  matches: ({ cell }) => cell.kind === GridCellKind.Text,
  render: renderDisplayText,
};

const numberCellRenderer: DataGridCellRenderer = {
  id: "number",
  matches: ({ cell }) => cell.kind === GridCellKind.Number,
  render: renderDisplayText,
};

const booleanCellRenderer: DataGridCellRenderer = {
  id: "boolean",
  matches: ({ cell }) => cell.kind === GridCellKind.Boolean,
  render: renderBooleanCheckbox,
};

const loadingCellRenderer: DataGridCellRenderer = {
  id: "loading",
  matches: ({ cell }) => cell.kind === GridCellKind.Loading,
  render: renderDisplayText,
};

const dropdownCellRenderer: DataGridCellRenderer = {
  id: "dropdown",
  matches: ({ cell }) => isDropdownCell(cell),
  render: renderDropdownDisplayText,
  padded: ({ cell }) => !canEditDropdownCell(cell),
};

const builtInCellRenderers: readonly DataGridCellRenderer[] = [
  textCellRenderer,
  numberCellRenderer,
  booleanCellRenderer,
  dropdownCellRenderer,
  loadingCellRenderer,
];

/** Resolves the editor or renderer used for a body cell. */
export function resolveCellContent(
  context: CellContentContext,
): CellContentResolution {
  const richCellExtension = findRichCellExtension(
    context.richCellExtensions,
    context.cell,
  );
  if (
    richCellExtension &&
    !context.cell.readonly &&
    context.editingCellKind === "rich" &&
    richCellExtension.id === context.editingExtensionId &&
    richCellExtension.isEditable(context.cell)
  ) {
    return {
      element: richCellExtension.renderEditor({
        cell: context.cell,
        coordinate: [context.col, context.row],
        commit: (makeEditedCell) =>
          context.commitDiscreteEdit(
            [context.col, context.row],
            makeEditedCell,
          ),
        onFocus: () => context.setActiveCell([context.col, context.row]),
        close: () => context.setEditingCell(undefined),
      }),
      padded: false,
    };
  }

  const editor =
    !context.cell.readonly &&
    builtInCellEditors.find((entry) => entry.matches(context));
  if (editor) {
    return {
      element: editor.render(context),
      padded: editor.padded ?? true,
    };
  }

  if (richCellExtension) {
    const editable =
      !context.cell.readonly && richCellExtension.isEditable(context.cell);
    return {
      element: richCellExtension.render({ cell: context.cell, editable }),
      padded: !editable,
    };
  }

  const customCanvasRenderer =
    context.cell.kind === GridCellKind.Custom
      ? findCustomRenderer(context.customRenderers, context.cell as CustomCell)
      : undefined;
  if (customCanvasRenderer) {
    return {
      element: renderDisplayText(context),
      padded: true,
      customCanvasRenderer,
    };
  }

  const renderer = builtInCellRenderers.find((entry) => entry.matches(context));
  if (renderer) {
    const padded =
      typeof renderer.padded === "function"
        ? renderer.padded(context)
        : (renderer.padded ?? true);
    return {
      element: renderer.render(context),
      padded,
    };
  }

  return {
    element: renderDisplayText(context),
    padded: true,
  };
}

/** Renders the inline text/number editor used for active editable cells. */
function renderTextInputEditor(context: CellContentContext) {
  const [inputRect, setInputRect] = createSignal<DOMRect>();
  let inputElement: HTMLInputElement | undefined;

  /** Returns contextual guidance for the active inline edit value. */
  const tooltipContent = () =>
    context.inlineEditTooltip?.({
      cell: context.cell,
      value: context.editingValue(),
    });

  /** Updates the fixed tooltip anchor to the active input element. */
  const updateTooltipAnchor = () => {
    setInputRect(inputElement?.getBoundingClientRect());
  };

  /** Returns fixed-position tooltip style anchored below the active input. */
  const tooltipStyle = (): JSX.CSSProperties | undefined => {
    const rect = inputRect();
    if (!rect) return undefined;
    return {
      position: "fixed",
      top: `${Math.min(rect.bottom + 8, window.innerHeight - 8)}px`,
      left: `${Math.min(
        Math.max(rect.left + rect.width / 2, 8),
        window.innerWidth - 8,
      )}px`,
      transform: "translateX(-50%)",
      "z-index": 2147483647,
    };
  };

  window.addEventListener("scroll", updateTooltipAnchor, true);
  window.addEventListener("resize", updateTooltipAnchor);
  onCleanup(() => {
    window.removeEventListener("scroll", updateTooltipAnchor, true);
    window.removeEventListener("resize", updateTooltipAnchor);
  });

  return (
    <form
      class="h-full w-full"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        context.commitEdit();
      }}
    >
      <input
        ref={(element) => {
          inputElement = element;
          context.setInputRef(element);
          requestAnimationFrame(updateTooltipAnchor);
        }}
        class={`h-full w-full select-text bg-[#101014] px-1 text-white outline-none ${textContentAlignClass(context.cell.contentAlign)}`}
        value={context.editingValue()}
        onInput={(event) => {
          context.setEditingCell((current) =>
            current && current.kind !== "dropdown" && current.kind !== "rich"
              ? {
                  ...current,
                  dirty: true,
                  value: event.currentTarget.value,
                }
              : current,
          );
          updateTooltipAnchor();
        }}
        onFocus={updateTooltipAnchor}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.stopPropagation();
            context.commitEdit(event.shiftKey ? "alternate" : "default");
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            context.cancelEdit();
          } else if (isPrintableTextEntryEvent(event)) {
            event.stopPropagation();
          }
        }}
        onBlur={() => context.commitEdit()}
      />
      <Show when={tooltipContent()}>
        {(content) => (
          <Show when={tooltipStyle()}>
            {(style) => (
              <Portal>
                <div
                  class="pointer-events-none whitespace-nowrap rounded border border-neutral-600 bg-neutral-900 px-2 py-1 text-xs text-neutral-100 shadow-lg"
                  data-grid-inline-tooltip="true"
                  style={style()}
                >
                  {content()}
                </div>
              </Portal>
            )}
          </Show>
        )}
      </Show>
      <button type="submit" class="hidden" tabIndex={-1} aria-hidden="true">
        Commit
      </button>
    </form>
  );
}

/** Renders text-like cell content. */
function renderDisplayText(context: CellContentContext) {
  const indicators = context.cell.stateIndicators ?? [];
  const PrefixBadgeIcon = context.cell.prefixBadgeIcon;
  const prefixBadgeLabel =
    context.cell.prefixBadgeLabel ?? context.cell.prefixBadge;
  const textAlignClass = textContentAlignClass(context.cell.contentAlign);
  if (context.cell.prefixBadge || PrefixBadgeIcon || indicators.length > 0) {
    return (
      <span class="relative flex w-full items-center gap-1">
        <span class="pointer-events-none flex shrink-0 items-center gap-1">
          {context.cell.prefixBadge || PrefixBadgeIcon ? (
            <span
              class="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-blue-400/60 bg-blue-400/15 px-1 text-[12px] leading-none text-blue-200"
              title={prefixBadgeLabel}
              role="img"
              aria-label={prefixBadgeLabel}
            >
              {PrefixBadgeIcon ? (
                <Dynamic
                  component={PrefixBadgeIcon}
                  class="size-3.5"
                  aria-hidden="true"
                />
              ) : (
                context.cell.prefixBadge
              )}
            </span>
          ) : null}
          {indicators.map((indicator) => renderStateIndicator(indicator))}
        </span>
        <span class={`min-w-0 flex-1 truncate ${textAlignClass}`}>
          {cellDisplayValue(context.cell)}
        </span>
      </span>
    );
  }

  return (
    <span class={`w-full truncate ${textAlignClass}`}>
      {cellDisplayValue(context.cell)}
    </span>
  );
}

/** Renders dropdown cells as passive text until the grid enters edit mode. */
function renderDropdownDisplayText(context: CellContentContext) {
  if (canEditDropdownCell(context.cell)) {
    return (
      <DropdownCellAffordance
        text={dropdownDisplayValue(context.cell as DropdownGridCell)}
      />
    );
  }

  return (
    <span class="w-full truncate text-right">
      {dropdownDisplayValue(context.cell as DropdownGridCell)}
    </span>
  );
}

/** Returns the text alignment class for plain grid-cell content. */
function textContentAlignClass(align: GridCell["contentAlign"]): string {
  switch (align) {
    case "left":
      return "text-left";
    case "center":
      return "text-center";
    case "right":
    case undefined:
      return "text-right";
  }
}

/** Renders one compact state dot or tag for a text-like grid cell. */
function renderStateIndicator(indicator: GridCellStateIndicator) {
  const title = indicator.label;
  if (indicator.variant === "tag") {
    return (
      <span
        class={`inline-flex h-[18px] items-center rounded px-1 text-[10px] font-semibold leading-none ${stateIndicatorTagClass(indicator.tone)}`}
        title={title}
        role="img"
        aria-label={title}
      >
        {indicator.text ?? stateIndicatorFallbackText(indicator)}
      </span>
    );
  }

  return (
    <span
      class={`inline-block size-2 shrink-0 rounded-full ${stateIndicatorDotClass(indicator.tone)}`}
      title={title}
      role="img"
      aria-label={title}
    />
  );
}

/** Returns the visible fallback text for a tag indicator without explicit text. */
function stateIndicatorFallbackText(indicator: GridCellStateIndicator): string {
  switch (indicator.tone) {
    case "manual":
      return "M";
    case "transition":
      return "T";
    case "input":
      return "I";
    case "tracked":
      return "Tr";
    case "lookahead":
      return "Lookahead";
    case "conflict":
      return "Mix";
    case "error":
      return "!";
  }
}

/** Maps indicator tones to dark-theme dot colors. */
function stateIndicatorDotClass(tone: GridCellStateIndicator["tone"]): string {
  switch (tone) {
    case "manual":
      return "bg-pink-300";
    case "transition":
      return "bg-yellow-300";
    case "input":
      return "bg-cyan-300";
    case "tracked":
      return "bg-emerald-300";
    case "lookahead":
      return "bg-violet-300";
    case "conflict":
      return "bg-zinc-400";
    case "error":
      return "bg-rose-400";
  }
}

/** Maps indicator tones to dark-theme tag colors. */
function stateIndicatorTagClass(tone: GridCellStateIndicator["tone"]): string {
  switch (tone) {
    case "manual":
      return "border border-pink-300/50 bg-pink-300/15 text-pink-200";
    case "transition":
      return "border border-yellow-300/50 bg-yellow-300/15 text-yellow-200";
    case "input":
      return "border border-cyan-300/50 bg-cyan-300/15 text-cyan-200";
    case "tracked":
      return "border border-emerald-300/50 bg-emerald-300/15 text-emerald-200";
    case "lookahead":
      return "border border-violet-300/50 bg-violet-300/15 text-violet-200";
    case "conflict":
      return "border border-zinc-400/50 bg-zinc-400/15 text-zinc-200";
    case "error":
      return "border border-rose-400/60 bg-rose-400/15 text-rose-200";
  }
}

/** Renders the checkbox editor/display for boolean cells. */
function renderBooleanCheckbox(context: CellContentContext) {
  const checked =
    context.cell.kind === GridCellKind.Boolean && context.cell.data === true;
  const readonly = !canEditBooleanCell(context.cell);
  const indicators = context.cell.stateIndicators ?? [];
  const indicatorClass =
    context.cell.stateIndicatorPlacement === "floating-end"
      ? "pointer-events-none absolute right-0 top-1/2 flex -translate-y-1/2 items-center justify-end gap-1"
      : "pointer-events-none flex shrink-0 items-center gap-1";

  return (
    <span class="relative flex w-full items-center justify-center gap-1">
      <input
        type="checkbox"
        disabled={readonly}
        checked={checked}
        class={readonly ? "pointer-events-none" : ""}
        onClick={(event) => {
          event.stopPropagation();
          if (
            context.cell.kind !== GridCellKind.Boolean ||
            isReadonlyCell(context.cell)
          ) {
            return;
          }
          context.onCellEdited?.([context.col, context.row], {
            ...context.cell,
            data: context.cell.data !== true,
          });
        }}
      />
      <Show when={indicators.length > 0}>
        <span class={indicatorClass}>
          {indicators.map((indicator) => renderStateIndicator(indicator))}
        </span>
      </Show>
    </span>
  );
}

/** Renders the dropdown editor for dropdown custom cells. */
function renderDropdownSelect(context: CellContentContext) {
  return (
    <DropdownCellSelect
      cell={context.cell as DropdownGridCell}
      onFocus={() => context.setActiveCell([context.col, context.row])}
      onCommit={(selectedKey) => {
        const sourceCell = context.cell;
        if (!canEditDropdownCell(sourceCell)) return;
        const selected = dropdownOptions(sourceCell).find(
          (option) => option.key === selectedKey,
        );
        if (!selected) return;
        context.commitDiscreteEdit([context.col, context.row], (original) =>
          canEditDropdownCell(original)
            ? makeDropdownEditedCellByValue(original, selected.value)
            : undefined,
        );
        context.setActiveCell([context.col, context.row]);
        context.setEditingCell(undefined);
      }}
    />
  );
}
