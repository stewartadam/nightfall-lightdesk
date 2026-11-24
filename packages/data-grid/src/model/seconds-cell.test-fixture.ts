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
} from "../data-grid-types";
import type { DataGridCellEditors } from "./types";

/** Data of the whole-seconds custom cell tests use to exercise custom text editors. */
export interface SecondsCellData {
  kind: "test-seconds";
  seconds: number | undefined;
}

export type SecondsCell = CustomCell<SecondsCellData>;

/** Builds an editable whole-seconds custom cell. */
export function secondsCell(seconds: number | undefined): SecondsCell {
  return {
    kind: GridCellKind.Custom,
    data: { kind: "test-seconds", seconds },
    copyData: seconds === undefined ? "" : `${seconds}s`,
    allowOverlay: true,
  };
}

/** Returns the seconds held by a test cell, failing loudly for any other cell. */
export function secondsCellValue(cell: unknown): number | undefined {
  const data = (cell as SecondsCell).data;
  if (data?.kind !== "test-seconds") {
    throw new Error("Expected a seconds test cell");
  }
  return data.seconds;
}

/** Clears a seconds cell, as Delete or blank text would. */
function clearedSecondsCell(cell: SecondsCell): SecondsCell {
  return { ...cell, copyData: "", data: { ...cell.data, seconds: undefined } };
}

/** Matches the seconds test cells among custom cells. */
function isSecondsCell(cell: CustomCell): cell is SecondsCell {
  return (cell.data as { kind?: unknown }).kind === "test-seconds";
}

/** Parses whole seconds such as "5s", clearing on blank text and ignoring anything else. */
function makeEditedSecondsCell(cell: SecondsCell, value: string): SecondsCell {
  if (value.trim() === "") return clearedSecondsCell(cell);
  const match = /^(\d+)s$/.exec(value.trim());
  if (!match) return cell;
  const seconds = Number(match[1]);
  return { ...cell, copyData: `${seconds}s`, data: { ...cell.data, seconds } };
}

/** Draws nothing; the clipboard and editing tests never paint cells. */
function drawNothing() {
  return undefined;
}

/**
 * Renderer whose text editor accepts whole seconds such as "5s", clears on
 * blank text or Delete, and leaves the cell unchanged for anything else.
 */
export const secondsRenderer: CustomRenderer<SecondsCell> = {
  isMatch: isSecondsCell,
  draw: drawNothing,
  textEditor: {
    makeEditedCell: makeEditedSecondsCell,
    makeDeletedCell: clearedSecondsCell,
  },
};

/** Editors registering the seconds renderer, as a grid owner would through props. */
export const secondsEditors: DataGridCellEditors = {
  customRenderers: [secondsRenderer],
};
