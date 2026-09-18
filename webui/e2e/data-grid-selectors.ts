// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, type Locator } from "@playwright/test";

export interface GridCellByKeyOptions {
  columnKey: string;
  rowKey: string;
}

export interface GridCellByRowIndexOptions {
  columnKey: string;
  rowIndex: number;
}

export interface GridCellByIdentifierOptions {
  columnKey: string;
  identifierColumnKey: string;
  identifierText: string;
}

/** Converts an attribute name into the cue editor's stable grid key segment. */
export function cueGridAttributeKey(attribute: string): string {
  const normalized = attribute === "VirtualIntensity" ? "Intensity" : attribute;
  const slug = normalized
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "attribute";
}

/** Builds the cue editor column key for one attribute value cell. */
export function cueGridAttributeValueColumnKey(attribute: string): string {
  return `attribute:${cueGridAttributeKey(attribute)}:value`;
}

/** Builds the cue editor column key for one attribute timing cell. */
export function cueGridAttributeTimingColumnKey(
  attribute: string,
  field: "delay_in" | "fade_in" | "fade_out" | "delay_out",
): string {
  return `attribute:${cueGridAttributeKey(attribute)}:timing:${field.replaceAll(
    "_",
    "-",
  )}`;
}

/** Formats a CSS attribute value string for Playwright locator selectors. */
function cssString(value: string): string {
  return JSON.stringify(value);
}

/** Locates a data-grid header by its stable column key. */
export function gridHeaderByColumnKey(
  grid: Locator,
  columnKey: string,
): Locator {
  return grid.locator(
    dataAttributeSelector(
      "data-grid-header-id",
      `tanstack-header-${columnKey}`,
    ),
  );
}

/** Builds a CSS attribute selector for one exact data attribute match. */
function dataAttributeSelector(name: string, value: string | number): string {
  return `[${name}=${cssString(String(value))}]`;
}

/** Locates one data-grid body cell by stable row and column keys. */
export function gridCellByKey(
  grid: Locator,
  options: GridCellByKeyOptions,
): Locator {
  return grid.locator(
    [
      dataAttributeSelector("data-grid-column-key", options.columnKey),
      dataAttributeSelector("data-grid-row-key", options.rowKey),
    ].join(""),
  );
}

/** Locates one data-grid body cell by stable column key and visual row index. */
export function gridCellByRowIndex(
  grid: Locator,
  options: GridCellByRowIndexOptions,
): Locator {
  return grid.locator(
    [
      dataAttributeSelector("data-grid-column-key", options.columnKey),
      dataAttributeSelector("data-grid-row-index", options.rowIndex),
    ].join(""),
  );
}

/**
 * Locates one data-grid body cell by resolving the row key from an identifier cell.
 */
export async function gridCellByIdentifier(
  grid: Locator,
  options: GridCellByIdentifierOptions,
): Promise<Locator> {
  const identifierSelector = dataAttributeSelector(
    "data-grid-column-key",
    options.identifierColumnKey,
  );
  let rowKey: string | null = null;
  await expect
    .poll(
      async () => {
        rowKey = await grid
          .locator(identifierSelector)
          .evaluateAll((cells, identifierText) => {
            for (const cell of cells) {
              const text = cell.textContent?.trim() ?? "";
              const tokens = text.split(/\s+/).filter(Boolean);
              if (text === identifierText || tokens.includes(identifierText)) {
                return cell.getAttribute("data-grid-row-key");
              }
            }
            return null;
          }, options.identifierText);
        return rowKey;
      },
      {
        message: `No data-grid row found for ${options.identifierColumnKey}=${options.identifierText}`,
      },
    )
    .not.toBeNull();
  if (!rowKey) throw new Error("Expected grid row key after identifier lookup");
  return gridCellByKey(grid, { columnKey: options.columnKey, rowKey });
}
