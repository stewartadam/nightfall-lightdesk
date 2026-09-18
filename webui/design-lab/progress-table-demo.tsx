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
  onCleanup,
  untrack,
} from "solid-js";
import { RangeSlider } from "../components/ui/range-slider";
import { Button } from "../components/ui/visual-language/button";
import DataGrid, {
  createKeyedDataGridCellProvider,
} from "../components/widgets/data-grid";
import {
  type GridCell,
  GridCellKind,
  type GridColumn,
} from "../lib/data-grid-types";
import { makeTimeCell, richTimeCellRenderer } from "../lib/datagrid-rich-cells";
import { secondsToDuration } from "../lib/duration";

const previewDuration = 8;
const samples = [
  { id: "wash", name: "Front wash", delay: 0.5, fade: 4 },
  { id: "spots", name: "Moving spots", delay: 3, fade: 5 },
  { id: "house", name: "House lights", delay: 0, fade: 2 },
  { id: "side", name: "Side wash", delay: 1, fade: 6 },
  { id: "strobes", name: "Strobes", delay: 4, fade: 1 },
];
const columns: GridColumn[] = [
  { id: "name", title: "Fixture group", width: 210, sizing: "fixed" },
  { id: "delay", title: "Delay in", width: 130, sizing: "fixed" },
  { id: "fade", title: "Fade in", width: 150, sizing: "fixed" },
  { id: "state", title: "State", width: 140, sizing: "fixed" },
];

/** Demonstrates the cue editor's background time-cell fills with a local, scrubbable playback clock. */
export function ProgressTableDemo(props: {
  active: boolean;
  compact: boolean;
  columnGuides: boolean;
}) {
  const [elapsed, setElapsed] = createSignal(2.5);
  const [running, setRunning] = createSignal(false);

  /** Cancels playback when hidden or unmounted and stops at the end of the sample. */
  createEffect(() => {
    if (!props.active) {
      setRunning(false);
      return;
    }
    if (!running()) return;
    const startTime = performance.now();
    const startValue = untrack(elapsed);
    let frame: number;
    /** Advances elapsed time from the animation clock without accumulating frame drift. */
    const tick = (now: number) => {
      const next = Math.min(
        previewDuration,
        startValue + (now - startTime) / 1000,
      );
      setElapsed(next);
      if (next >= previewDuration) setRunning(false);
      else frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    onCleanup(() => cancelAnimationFrame(frame));
  });

  /** Produces the same rich time cells and blue background fill used by cue timing columns. */
  const provider = createMemo(() => {
    const time = elapsed();
    return createKeyedDataGridCellProvider({
      rows: samples,
      columns,
      rowKey: (row) => row.id,
      columnKey: (column) => column.id!,
      getCellContent: ({ row, column }): GridCell => {
        if (column.id === "delay" || column.id === "fade") {
          const duration = row[column.id];
          const passed = column.id === "delay" ? time : time - row.delay;
          const fill =
            passed < 0
              ? 0
              : duration === 0
                ? 1
                : Math.min(1, passed / duration);
          return makeTimeCell(
            {
              value: secondsToDuration(duration),
              displayUnit: "seconds",
              backgroundFill: fill,
              backgroundFillColor: "rgba(59, 130, 246, 0.42)",
            },
            { readonly: true },
          );
        }
        return {
          kind: GridCellKind.Text,
          data:
            column.id === "name"
              ? row.name
              : time < row.delay
                ? "Waiting"
                : time < row.delay + row.fade
                  ? "Fading"
                  : "Complete",
          readonly: true,
        };
      },
    });
  });

  /** Pauses animation before applying an exact time from the shared slider or numeric input. */
  function scrub(value: number) {
    setRunning(false);
    setElapsed(value);
  }

  return (
    <div class="data-grid-demo lab-panel">
      <div class="panel-toolbar progress-table-toolbar">
        <span class="toolbar-title">Cue timing preview</span>
        <div class="button-samples">
          <Button
            onClick={() => {
              if (elapsed() >= previewDuration) setElapsed(0);
              setRunning((current) => !current);
            }}
          >
            {running() ? "Pause preview" : "Play preview"}
          </Button>
          <Button onClick={() => scrub(0)}>Reset preview</Button>
        </div>
        <div class="progress-table-scrubber">
          <RangeSlider
            value={elapsed()}
            onChange={scrub}
            min={0}
            max={previewDuration}
            step={0.1}
            suffix="s"
            ariaLabel="Preview time"
          />
        </div>
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
          rows={samples.length}
          cellProvider={provider}
          customRenderers={[richTimeCellRenderer]}
          rowMarkers="none"
          rowHeight={props.compact ? 32 : 42}
        />
      </div>
      <div class="panel-footnote">
        <span role="status">
          {running()
            ? "Playing"
            : elapsed() >= previewDuration
              ? "Complete"
              : "Paused"}{" "}
          · {elapsed().toFixed(1)} / 8.0 s
        </span>
        <span>Sample playback · No live output</span>
      </div>
    </div>
  );
}
