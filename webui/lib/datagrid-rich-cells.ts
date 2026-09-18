// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  type CustomCell,
  type CustomRenderer,
  GridCellKind,
} from "./data-grid-types";
import {
  CELL_PADDING,
  formatDurationInputValue,
  type RichActionButtonCellData,
  type RichBadgeTag,
  type RichColorSwatchCellData,
  type RichTimeCellData,
} from "./datagrid-rich-cell-helpers";

export type {
  RichColorSwatchCellData,
  RichTimeCellData,
  RichTimeDisplayUnit,
} from "./datagrid-rich-cell-helpers";
export {
  getActionAtPosition,
  normalizeGridClickPosition,
} from "./datagrid-rich-cell-helpers";

export type RichActionButtonCell = CustomCell<RichActionButtonCellData>;
export type RichColorSwatchCell = CustomCell<RichColorSwatchCellData>;
export type RichTimeCell = CustomCell<RichTimeCellData>;

function middleCenterBias(ctx: CanvasRenderingContext2D): number {
  const metrics = ctx.measureText("M");
  if (
    metrics.actualBoundingBoxAscent !== undefined &&
    metrics.actualBoundingBoxDescent !== undefined
  ) {
    return (
      (metrics.actualBoundingBoxAscent - metrics.actualBoundingBoxDescent) / 2
    );
  }
  return 0;
}

const TIME_BADGE_HEIGHT = 18;
const TIME_BADGE_GAP = 6;
const TIME_BADGE_PADDING_X = 5;

/** Returns canvas colors for a compact rich time-cell badge. */
function timeBadgeColors(tag: RichBadgeTag): {
  background: string;
  border: string;
  text: string;
} {
  switch (tag.tone) {
    case "warning":
      return {
        background: "rgba(245, 158, 11, 0.2)",
        border: "rgba(245, 158, 11, 0.75)",
        text: "#fbbf24",
      };
    case "danger":
      return {
        background: "rgba(239, 68, 68, 0.2)",
        border: "rgba(239, 68, 68, 0.75)",
        text: "#fca5a5",
      };
    case "accent":
    case "info":
      return {
        background: "rgba(59, 130, 246, 0.2)",
        border: "rgba(59, 130, 246, 0.75)",
        text: "#93c5fd",
      };
    case "success":
      return {
        background: "rgba(34, 197, 94, 0.18)",
        border: "rgba(34, 197, 94, 0.72)",
        text: "#86efac",
      };
    default:
      return {
        background: "rgba(115, 115, 115, 0.22)",
        border: "rgba(163, 163, 163, 0.7)",
        text: "#d4d4d4",
      };
  }
}

/** Measures one compact rich time-cell badge. */
function measureTimeBadge(
  ctx: CanvasRenderingContext2D,
  tag: RichBadgeTag,
): number {
  return ctx.measureText(tag.label).width + TIME_BADGE_PADDING_X * 2;
}

export function isRichActionButtonCell(
  cell: CustomCell,
): cell is RichActionButtonCell {
  return (cell.data as { kind?: unknown }).kind === "rich-action-button-cell";
}

export function makeColorSwatchCell(
  data: Omit<RichColorSwatchCellData, "kind">,
): RichColorSwatchCell {
  return {
    kind: GridCellKind.Custom,
    data: { ...data, kind: "rich-color-swatch-cell" },
    copyData: data.color,
    allowOverlay: false,
  };
}

function isRichColorSwatchCell(cell: CustomCell): cell is RichColorSwatchCell {
  const kind = (cell.data as { kind?: unknown }).kind;
  return kind === "rich-color-swatch-cell" || kind === "color-cell";
}

export function makeTimeCell(
  data: Omit<RichTimeCellData, "kind">,
  options?: {
    readonly?: boolean;
    allowOverlay?: boolean;
  },
): RichTimeCell {
  const fullData: RichTimeCellData = { ...data, kind: "rich-time-cell" };
  const display = formatTimeCellDisplay(fullData);
  return {
    kind: GridCellKind.Custom,
    data: fullData,
    copyData: display,
    allowOverlay: options?.allowOverlay ?? options?.readonly !== true,
    readonly: options?.readonly,
    activationBehaviorOverride: "double-click",
    cursor: options?.readonly === true ? undefined : "text",
  };
}

export function isRichTimeCell(cell: CustomCell): cell is RichTimeCell {
  return (cell.data as { kind?: unknown }).kind === "rich-time-cell";
}

/** Formats the visible text for a rich time cell, honoring aggregate overrides. */
function formatTimeCellDisplay(data: RichTimeCellData): string {
  const text =
    data.displayValue ??
    formatDurationInputValue(data.value, data.displayUnit, data.precision);
  const badges = data.badges?.map((badge) => `[${badge.label}]`) ?? [];
  return [...badges, text].filter((part) => part !== "").join(" ");
}

function drawText(
  args: Parameters<CustomRenderer["draw"]>[0],
  text: string,
  x: number,
  color?: string,
) {
  const { ctx, theme, rect } = args;
  ctx.fillStyle = color ?? theme.textDark;
  ctx.font = `${theme.baseFontStyle} ${theme.fontFamily}`;
  ctx.textBaseline = "middle";
  ctx.fillText(text, x, rect.y + rect.height / 2 + middleCenterBias(ctx));
}

/** Draws one compact badge and returns its width. */
function drawTimeBadge(
  args: Parameters<CustomRenderer["draw"]>[0],
  tag: RichBadgeTag,
  x: number,
): number {
  const { ctx, rect, theme } = args;
  ctx.save();
  ctx.font = `${theme.baseFontStyle} ${theme.fontFamily}`;
  const width = measureTimeBadge(ctx, tag);
  const y = rect.y + (rect.height - TIME_BADGE_HEIGHT) / 2;
  const colors = timeBadgeColors(tag);
  ctx.fillStyle = colors.background;
  ctx.strokeStyle = colors.border;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(x, y, width, TIME_BADGE_HEIGHT, 3);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = colors.text;
  ctx.textBaseline = "middle";
  ctx.fillText(
    tag.label,
    x + TIME_BADGE_PADDING_X,
    rect.y + rect.height / 2 + middleCenterBias(ctx),
  );
  ctx.restore();
  return width;
}

function clampUnit(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

export const richTimeCellRenderer: CustomRenderer<RichTimeCell> = {
  kind: GridCellKind.Custom,
  isMatch: isRichTimeCell,
  draw: (args) => {
    const cell = args.cell;
    const fill = clampUnit(cell.data.backgroundFill ?? 0);
    if (fill > 0) {
      const { ctx, rect } = args;
      const padding = 1;
      ctx.save();
      ctx.fillStyle =
        cell.data.backgroundFillColor ?? "rgba(59, 130, 246, 0.42)";
      ctx.fillRect(
        rect.x + padding,
        rect.y + padding,
        (rect.width - padding * 2) * fill,
        rect.height - padding * 2,
      );
      ctx.restore();
    }

    let x = args.rect.x + CELL_PADDING;
    for (const badge of args.cell.data.badges ?? []) {
      x += drawTimeBadge(args, badge, x) + TIME_BADGE_GAP;
    }
    const displayText =
      args.cell.data.displayValue ??
      formatDurationInputValue(
        args.cell.data.value,
        args.cell.data.displayUnit,
        args.cell.data.precision,
      );
    if (displayText !== "") {
      drawText(args, displayText, x);
    }
  },
  measure: (ctx, cell, theme) => {
    const displayText =
      cell.data.displayValue ??
      formatDurationInputValue(
        cell.data.value,
        cell.data.displayUnit,
        cell.data.precision,
      );
    const badgeWidth = (cell.data.badges ?? []).reduce(
      (width, badge, index) =>
        width +
        measureTimeBadge(ctx, badge) +
        (index === 0 ? 0 : TIME_BADGE_GAP),
      0,
    );
    const gap = badgeWidth > 0 && displayText !== "" ? TIME_BADGE_GAP : 0;
    return (
      badgeWidth +
      gap +
      ctx.measureText(displayText).width +
      theme.cellHorizontalPadding * 2
    );
  },
};

export const richColorSwatchCellRenderer: CustomRenderer<RichColorSwatchCell> =
  {
    kind: GridCellKind.Custom,
    isMatch: isRichColorSwatchCell,
    draw: (args) => {
      const { ctx, theme, rect } = args;
      const cell = args.cell;
      const swatchSize = Math.min(rect.height - 10, 24);
      const swatchX = rect.x + CELL_PADDING;
      const swatchY = rect.y + (rect.height - swatchSize) / 2;
      const withLabel = cell.data.withLabel ?? cell.data.with_label ?? false;

      ctx.fillStyle = cell.data.color;
      ctx.fillRect(swatchX, swatchY, swatchSize, swatchSize);
      ctx.strokeStyle = theme.textLight;
      ctx.strokeRect(swatchX, swatchY, swatchSize, swatchSize);

      if (withLabel) {
        drawText(
          args,
          cell.data.color || cell.data.emptyLabel || "",
          swatchX + swatchSize + 10,
        );
      }
    },
    measure: (ctx, cell, theme) =>
      (cell.data.withLabel ?? cell.data.with_label ?? false)
        ? ctx.measureText(cell.data.color).width +
          theme.cellHorizontalPadding * 2 +
          34
        : 34,
  };
