// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { PlusIcon } from "@squidlab/phosphor-solid/plus";
import { createMemo, createSignal, createUniqueId } from "solid-js";
import { openContextMenu } from "../components/providers/context-menu";
import { SegmentedTabs } from "../components/ui/segmented-tabs";
import { ToggleSwitch } from "../components/ui/toggle-switch";
import { Button } from "../components/ui/visual-language/button";
import DataGrid, {
  createKeyedDataGridCellProvider,
  type DataGridCellEdit,
} from "../components/widgets/data-grid";
import {
  CompactSelection,
  type GridCell,
  GridCellKind,
  type GridColumn,
  type GridSelection,
} from "../lib/data-grid-types";
import { isDropdownCell } from "../lib/tanstack-dropdown-cell";
import { ProgressTableDemo } from "./progress-table-demo";
import { ReadOnlyTableDemo } from "./read-only-table-demo";
import "./data-grid-demo.css";

interface DataGridDemoProps {
  compact: boolean;
  columnGuides: boolean;
  onColumnGuides: (enabled: boolean) => void;
  onNotice: (message: string) => void;
}

const tableVariants = [
  { id: "editable", label: "Editable cues" },
  { id: "readonly", label: "Read-only status" },
  { id: "progress", label: "Progress bars" },
] as const;

/** Switches between editing and monitoring tables while preserving each view's mounted state. */
export function DataGridDemo(props: DataGridDemoProps) {
  const id = createUniqueId();
  const [activeTab, setActiveTab] = createSignal("editable");

  return (
    <section class="data-grid-demo lab-panel" aria-label="Data grid example">
      <div class="panel-toolbar" role="group" aria-label="Table structure">
        <span class="toolbar-title">Table structure</span>
        <ToggleSwitch
          label="Column guides"
          ariaLabel="Column guides"
          checked={props.columnGuides}
          onChange={props.onColumnGuides}
        />
      </div>
      <SegmentedTabs
        id={`${id}-tab`}
        label="Table variants"
        contentId={`${id}-${activeTab()}-panel`}
        options={tableVariants.map((tab) => ({
          key: tab.id,
          label: tab.label,
          contentId: `${id}-${tab.id}-panel`,
        }))}
        value={activeTab()}
        onChange={setActiveTab}
      />
      <div
        class="data-grid-variant-content"
        id={`${id}-editable-panel`}
        role="tabpanel"
        aria-labelledby={`${id}-tab-editable`}
        hidden={activeTab() !== "editable"}
      >
        <EditableCueGrid {...props} />
      </div>
      <div
        class="data-grid-variant-content"
        id={`${id}-readonly-panel`}
        role="tabpanel"
        aria-labelledby={`${id}-tab-readonly`}
        hidden={activeTab() !== "readonly"}
      >
        <ReadOnlyTableDemo
          active={activeTab() === "readonly"}
          compact={props.compact}
          columnGuides={props.columnGuides}
        />
      </div>
      <div
        class="data-grid-variant-content"
        id={`${id}-progress-panel`}
        role="tabpanel"
        aria-labelledby={`${id}-tab-progress`}
        hidden={activeTab() !== "progress"}
      >
        <ProgressTableDemo
          active={activeTab() === "progress"}
          compact={props.compact}
          columnGuides={props.columnGuides}
        />
      </div>
    </section>
  );
}

interface CueRow {
  id: number;
  name: string;
  trigger: string;
  fade: number;
  delay: number;
  tracking: string;
}
const triggers = ["Manual", "After previous", "Timecode"];
const trackingModes = ["Track", "Cue only"];
const columns: GridColumn[] = [
  { id: "id", title: "Cue", group: "Cue details", width: 62, sizing: "fixed" },
  {
    id: "name",
    title: "Label",
    group: "Cue details",
    width: 220,
    sizing: "fixed",
  },
  {
    id: "trigger",
    title: "Trigger",
    group: "Timing",
    width: 154,
    sizing: "fixed",
  },
  { id: "fade", title: "Fade in", group: "Timing", width: 95, sizing: "fixed" },
  { id: "delay", title: "Delay", group: "Timing", width: 95, sizing: "fixed" },
  { id: "tracking", title: "Tracking", width: 120, sizing: "fixed" },
];

/** Supplies a representative editable show sequence long enough to exercise virtualization. */
function sampleRows(): CueRow[] {
  const names = [
    "House to half",
    "Opening wash",
    "Reveal downstage",
    "Full stage",
  ];
  return Array.from({ length: 120 }, (_, index) => ({
    id: index + 1,
    name: names[index] ?? `Stage look ${index + 1}`,
    trigger: triggers[index % 3],
    fade: [2, 1.5, 3, 1][index % 4],
    delay: index === 1 ? 0.5 : 0,
    tracking: index === 2 ? "Cue only" : "Track",
  }));
}

/** Converts sample values into the same typed cell contract used by application grids. */
function cueCell(row: CueRow, column: GridColumn): GridCell {
  switch (column.id) {
    case "id":
      return {
        kind: GridCellKind.Number,
        data: row.id,
        displayData: String(row.id).padStart(2, "0"),
        readonly: true,
        contentAlign: "left",
      };
    case "fade":
    case "delay":
      return {
        kind: GridCellKind.Number,
        data: row[column.id],
        displayData: `${row[column.id].toFixed(1)} s`,
        allowOverlay: true,
      };
    case "trigger":
    case "tracking":
      return {
        kind: GridCellKind.Custom,
        data: {
          kind: "dropdown-cell",
          value: row[column.id],
          allowedValues: column.id === "trigger" ? triggers : trackingModes,
        },
        copyData: row[column.id],
        allowOverlay: true,
      };
    default:
      return {
        kind: GridCellKind.Text,
        data: row.name,
        allowOverlay: true,
        contentAlign: "left",
      };
  }
}

/** Demonstrates the production virtualized grid with grouped columns, editing, selection, resizing, and menus. */
function EditableCueGrid(props: DataGridDemoProps) {
  const [rows, setRows] = createSignal(sampleRows());
  const [selection, setSelection] = createSignal<GridSelection>({
    rows: CompactSelection.fromSingleSelection(1),
    columns: CompactSelection.empty(),
  });
  let nextId = 121;
  /** Exposes stable row IDs and typed cells to the production grid. */
  const provider = createMemo(() =>
    createKeyedDataGridCellProvider({
      rows: rows(),
      columns,
      contentSizingKey: rows(),
      rowKey: (row) => row.id,
      columnKey: (column) => column.id!,
      getCellContent: ({ row, column }) => cueCell(row, column),
    }),
  );

  /** Commits validated single or pasted cell edits against the current row positions. */
  function applyEdits(edits: readonly DataGridCellEdit[]) {
    setRows((current) =>
      current.map((row, rowIndex) => {
        let updated = row;
        for (const {
          cell: [columnIndex, editRow],
          newValue,
        } of edits) {
          if (rowIndex !== editRow) continue;
          const key = columns[columnIndex]?.id;
          if (key === "name" && newValue.kind === GridCellKind.Text)
            updated = { ...updated, name: newValue.data };
          if (
            (key === "fade" || key === "delay") &&
            newValue.kind === GridCellKind.Number &&
            Number.isFinite(newValue.data) &&
            newValue.data >= 0
          )
            updated = { ...updated, [key]: newValue.data };
          if (
            (key === "trigger" || key === "tracking") &&
            isDropdownCell(newValue)
          ) {
            const allowed = key === "trigger" ? triggers : trackingModes;
            if (allowed.includes(newValue.data.value ?? ""))
              updated = { ...updated, [key]: newValue.data.value! };
          }
        }
        return updated;
      }),
    );
  }

  /** Opens sample cue commands through the application's shared context-menu service. */
  function showCueMenu(
    rowIndex: number,
    event: { clientX: number; clientY: number; preventDefault: () => void },
  ) {
    event.preventDefault();
    const row = rows()[rowIndex];
    if (!row) return;
    openContextMenu({
      x: event.clientX,
      y: event.clientY,
      items: [
        {
          type: "heading",
          id: "heading",
          label: `Cue ${row.id} · ${row.name}`,
        },
        {
          id: "duplicate",
          label: "Duplicate cue",
          onSelect: () => {
            setRows((current) => [
              ...current.slice(0, rowIndex + 1),
              { ...row, id: nextId++, name: `${row.name} copy` },
              ...current.slice(rowIndex + 1),
            ]);
            props.onNotice(`Duplicated ${row.name}`);
          },
        },
        {
          type: "submenu",
          id: "trigger",
          label: "Set trigger",
          items: triggers.map((trigger) => ({
            id: trigger,
            label: trigger,
            checked: row.trigger === trigger,
            onSelect: () =>
              setRows((current) =>
                current.map((item) =>
                  item.id === row.id ? { ...item, trigger } : item,
                ),
              ),
          })),
        },
        { type: "separator", id: "divider" },
        {
          id: "reveal",
          label: "Reveal in timeline",
          disabled: true,
          onSelect: () => undefined,
        },
        {
          id: "delete",
          label: "Delete cue",
          danger: true,
          onSelect: () => {
            setRows((current) => current.filter((item) => item.id !== row.id));
            setSelection({
              rows: CompactSelection.empty(),
              columns: CompactSelection.empty(),
            });
            props.onNotice(`Deleted sample cue ${row.id}`);
          },
        },
      ],
    });
  }

  return (
    <div class="data-grid-demo lab-panel">
      <div class="panel-toolbar">
        <span class="toolbar-title">
          Sample cues <span class="count">{rows().length} rows</span>
        </span>
        <Button
          variant="subtle"
          onClick={() => {
            const id = nextId++;
            setRows((current) => [
              {
                id,
                name: `Cue ${id}`,
                trigger: "Manual",
                fade: 1,
                delay: 0,
                tracking: "Track",
              },
              ...current,
            ]);
            setSelection({
              rows: CompactSelection.empty(),
              columns: CompactSelection.empty(),
            });
          }}
        >
          {" "}
          <PlusIcon size={15} />
          Add cue
        </Button>
      </div>
      <div
        class="lab-data-grid"
        style={{
          "--data-grid-column-border": props.columnGuides
            ? "#ffffff18"
            : "transparent",
        }}
      >
        <DataGrid
          columns={columns}
          rows={rows().length}
          cellProvider={provider}
          rowMarkers="checkbox"
          freezeColumns={2}
          rowHeight={props.compact ? 32 : 42}
          gridSelection={selection()}
          onGridSelectionChange={setSelection}
          onCellEdited={(cell, newValue) => applyEdits([{ cell, newValue }])}
          onCellsEdited={applyEdits}
          onCellContextMenu={([, row], event) => showCueMenu(row, event)}
        />
      </div>
      <div class="panel-footnote">
        <span>{selection().rows.toArray().length} rows selected</span>
        <span>Double-click to edit · Right-click for actions</span>
      </div>
    </div>
  );
}
