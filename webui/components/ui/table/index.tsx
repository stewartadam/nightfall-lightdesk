// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { type JSX, splitProps } from "solid-js";
import { ScrollArea } from "../scroll-area";
import "./table.css";

export type TableProps = JSX.IntrinsicElements["table"] & {
  density?: "compact" | "comfortable";
  columnGuides?: boolean;
  stickyHeader?: boolean;
};

/** Styles native table markup without taking ownership of rows, sorting or cell interactions. */
export function Table(props: TableProps) {
  const [local, rest] = splitProps(props, [
    "class",
    "density",
    "columnGuides",
    "stickyHeader",
  ]);
  return (
    <table
      class={`nf-table ${local.class ?? ""}`}
      data-density={local.density ?? "compact"}
      data-column-guides={local.columnGuides || undefined}
      data-sticky-header={local.stickyHeader !== false || undefined}
      {...rest}
    />
  );
}

export interface TableScrollProps extends JSX.HTMLAttributes<HTMLDivElement> {
  "aria-label": string;
}

/** Provides a named, keyboard-scrollable viewport while callers choose its available size. */
export function TableScroll(props: TableScrollProps) {
  const [local, rest] = splitProps(props, ["class", "style", "children"]);
  return (
    <ScrollArea
      class={`nf-table-scroll ${local.class ?? ""}`}
      style={local.style}
      viewportClass="nf-table-viewport"
      viewportProps={{ role: "region", tabIndex: 0, ...rest }}
    >
      {local.children}
    </ScrollArea>
  );
}

/** Keeps empty-state spacing and text consistent across tables with different column counts. */
export function TableEmptyRow(props: {
  colSpan: number;
  children: JSX.Element;
}) {
  return (
    <tr data-table-empty="true">
      <td colSpan={props.colSpan}>{props.children}</td>
    </tr>
  );
}
