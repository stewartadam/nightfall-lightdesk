// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { AppIcon } from "../components/ui/icon";

export type Item = readonly [number, number];

export enum GridCellKind {
  Boolean = "boolean",
  Custom = "custom",
  Loading = "loading",
  Number = "number",
  Text = "text",
}

export interface GridColumn {
  id?: string;
  title: string;
  /** Provides a fallback width before content measurement or the exact width for fixed columns. */
  width?: number;
  /** Chooses intrinsic content measurement by default or preserves an exact fixed width. */
  sizing?: "content" | "fixed";
  /** Prevents content measurement from making the column narrower than this pixel width. */
  minWidth?: number;
  /** Caps content measurement so exceptionally long values remain truncated. */
  maxWidth?: number;
  group?: string;
  icon?: string;
  themeOverride?: Record<string, unknown>;
  hasMenu?: boolean;
}

interface GridCellTheme {
  bgCell?: string;
  bgCellMedium?: string;
  textDark?: string;
  [key: string]: unknown;
}

type GridCellStateIndicatorTone =
  | "manual"
  | "transition"
  | "input"
  | "tracked"
  | "lookahead"
  | "conflict"
  | "error";

export interface GridCellStateIndicator {
  label: string;
  tone: GridCellStateIndicatorTone;
  variant?: "dot" | "tag";
  text?: string;
}

interface BaseGridCell {
  readonly?: boolean;
  allowOverlay?: boolean;
  contentAlign?: "left" | "center" | "right";
  copyData?: string;
  cursor?: string;
  prefixBadge?: string;
  prefixBadgeIcon?: AppIcon;
  prefixBadgeLabel?: string;
  stateIndicators?: GridCellStateIndicator[];
  stateIndicatorPlacement?: "inline" | "floating-end";
  themeOverride?: GridCellTheme;
  activationBehaviorOverride?: string;
}

interface TextCell extends BaseGridCell {
  kind: GridCellKind.Text;
  data: string;
  displayData?: string;
}

interface NumberCell extends BaseGridCell {
  kind: GridCellKind.Number;
  data: number;
  displayData?: string;
}

interface BooleanCell extends BaseGridCell {
  kind: GridCellKind.Boolean;
  data?: boolean;
}

interface LoadingCell extends BaseGridCell {
  kind: GridCellKind.Loading;
}

export interface CustomCell<T = unknown> extends BaseGridCell {
  kind: GridCellKind.Custom;
  data: T;
}

export type GridCell =
  | BooleanCell
  | CustomCell
  | LoadingCell
  | NumberCell
  | TextCell;

export interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export class CompactSelection implements Iterable<number> {
  private constructor(private readonly indices: readonly number[]) {}

  static empty(): CompactSelection {
    return new CompactSelection([]);
  }

  static fromArray(indices: readonly number[]): CompactSelection {
    return new CompactSelection(normalizeSelectionIndices(indices));
  }

  static fromSingleSelection(selection: number | readonly [number, number]) {
    if (typeof selection === "number") {
      return new CompactSelection([selection]);
    }

    const [start, endExclusive] = selection;
    const indices: number[] = [];
    for (let index = start; index < endExclusive; index += 1) {
      indices.push(index);
    }
    return new CompactSelection(indices);
  }

  [Symbol.iterator](): Iterator<number> {
    return this.indices[Symbol.iterator]();
  }

  toArray(): number[] {
    return [...this.indices];
  }
}

function normalizeSelectionIndices(indices: readonly number[]): number[] {
  return [...new Set(indices)].sort((left, right) => left - right);
}

export interface GridSelection {
  columns: CompactSelection;
  rows: CompactSelection;
  current?: {
    cell: Item;
    range: Rectangle;
    rangeStack: Rectangle[];
  };
}

export interface CellClickedEventArgs extends MouseEvent {
  bounds: Rectangle;
  preventDefault(): void;
}

export interface GroupHeaderClickedEventArgs extends MouseEvent {
  preventDefault(): void;
}

interface DataGridTheme {
  accentColor: string;
  accentLight: string;
  textDark: string;
  textMedium: string;
  textLight: string;
  bgCell: string;
  bgCellMedium: string;
  fontFamily: string;
  baseFontStyle: string;
  cellHorizontalPadding: number;
  [key: string]: unknown;
}

interface CustomRendererDrawArgs<TCell extends CustomCell = CustomCell> {
  ctx: CanvasRenderingContext2D;
  cell: TCell;
  col: number;
  row: number;
  rect: Rectangle;
  theme: DataGridTheme;
}

export interface CustomRenderer<TCell extends CustomCell = CustomCell> {
  kind?: GridCellKind.Custom;
  isMatch: (cell: CustomCell) => cell is TCell;
  draw: (args: CustomRendererDrawArgs<TCell>) => unknown;
  measure?: (
    ctx: CanvasRenderingContext2D,
    cell: TCell,
    theme: DataGridTheme,
  ) => number;
  onClick?: (args: { preventDefault: () => void }) => unknown;
}
