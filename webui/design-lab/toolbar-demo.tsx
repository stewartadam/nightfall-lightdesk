// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { ArrowsOutCardinalIcon } from "@squidlab/phosphor-solid/arrows-out-cardinal";
import { CopyIcon } from "@squidlab/phosphor-solid/copy";
import { DeviceRotateIcon } from "@squidlab/phosphor-solid/device-rotate";
import { ListIcon } from "@squidlab/phosphor-solid/list";
import { PauseIcon } from "@squidlab/phosphor-solid/pause";
import { PlayIcon } from "@squidlab/phosphor-solid/play";
import { PlusIcon } from "@squidlab/phosphor-solid/plus";
import { RepeatIcon } from "@squidlab/phosphor-solid/repeat";
import { RulerIcon } from "@squidlab/phosphor-solid/ruler";
import { SelectionIcon } from "@squidlab/phosphor-solid/selection";
import { SquaresFourIcon } from "@squidlab/phosphor-solid/squares-four";
import { StopIcon } from "@squidlab/phosphor-solid/stop";
import { VideoCameraIcon } from "@squidlab/phosphor-solid/video-camera";
import { createSignal, createUniqueId, For, Show } from "solid-js";
import PanelToolbar, { ToolbarSeparator } from "../components/ui/panel-toolbar";
import { SegmentedControl } from "../components/ui/segmented-control";
import { SegmentedTabs } from "../components/ui/segmented-tabs";
import {
  ToggleToolbarButton,
  ToolbarButton,
} from "../components/ui/toolbar-button";
import { Button } from "../components/ui/visual-language/button";
import DataGridToolbar from "../components/widgets/data-grid/extensions/data-grid-toolbar";
import "./toolbar-demo.css";

const toolModes = [
  { label: "Camera", icon: VideoCameraIcon },
  { label: "Measure", icon: RulerIcon },
  { label: "Move", icon: ArrowsOutCardinalIcon },
  { label: "Rotate", icon: DeviceRotateIcon },
  { label: "Select", icon: SelectionIcon },
] as const;

const groupingOptions = ["None", "Fixture", "Universe"] as const;
type Grouping = (typeof groupingOptions)[number];

const sampleRoutes = [
  { fixture: "Wash left", universe: "Universe 1", address: "001" },
  { fixture: "Wash right", universe: "Universe 1", address: "017" },
  { fixture: "Wash left", universe: "Universe 2", address: "001" },
];

/** Exercises toolbar actions, exclusive tool modes, grouping tabs, and selection-dependent commands. */
export function ToolbarDemo() {
  const id = createUniqueId();
  const [toolMode, setToolMode] =
    createSignal<(typeof toolModes)[number]["label"]>("Camera");
  const [grouping, setGrouping] = createSignal<Grouping>("None");
  /** Regroups the same sample routes when a grouping tab is selected. */
  const routeGroups = () => {
    const groups = new Map<string, typeof sampleRoutes>();
    for (const route of sampleRoutes) {
      const key =
        grouping() === "Fixture"
          ? route.fixture
          : grouping() === "Universe"
            ? route.universe
            : "All routes";
      const rows = groups.get(key) ?? [];
      rows.push(route);
      groups.set(key, rows);
    }
    return [...groups];
  };

  const [view, setView] = createSignal("grid");
  const [playing, setPlaying] = createSignal(false);
  const [loop, setLoop] = createSignal(false);
  const [selected, setSelected] = createSignal(2);
  const [notice, setNotice] = createSignal(
    "Toolbar actions affect only this demo.",
  );
  return (
    <section class="properties lab-panel" aria-label="Toolbar examples">
      <div class="eyebrow">PANEL TOOLBAR</div>
      <h2>Grouped actions. Clear states.</h2>
      <div class="property-section" role="group" aria-label="Library toolbar">
        <div class="section-label">Library actions</div>
        <PanelToolbar
          left={
            <>
              <ToolbarButton
                label="Add sample group"
                size="labeled"
                onClick={() => setNotice("Sample group added.")}
              >
                <PlusIcon size={16} />
                Add group
              </ToolbarButton>
              <ToolbarButton
                label="Duplicate sample group"
                onClick={() => setNotice("Sample group duplicated.")}
              >
                <CopyIcon size={16} />
              </ToolbarButton>
            </>
          }
          right={
            <SegmentedControl
              label="View"
              density="compact"
              options={[
                {
                  value: "grid",
                  icon: SquaresFourIcon,
                  ariaLabel: "Grid view",
                  tooltip: "Grid view",
                },
                {
                  value: "list",
                  icon: ListIcon,
                  ariaLabel: "List view",
                  tooltip: "List view",
                },
              ]}
              value={view()}
              onChange={setView}
            />
          }
        />
      </div>
      <div class="property-section" role="group" aria-label="Tool mode toolbar">
        <div class="section-label">Radio modes · 3D visualizer</div>
        <PanelToolbar
          left={
            <SegmentedControl
              label="Interaction mode"
              density="compact"
              options={toolModes.map((mode) => ({
                value: mode.label,
                icon: mode.icon,
                ariaLabel: mode.label,
                tooltip: mode.label,
              }))}
              value={toolMode()}
              onChange={setToolMode}
            />
          }
          right={<span class="toolbar-readout">{toolMode()} mode</span>}
        />
        <p class="field-help">
          One active tool at a time. Selecting it again keeps it active.
        </p>
      </div>
      <div class="property-section" role="group" aria-label="Grouping toolbar">
        <div class="section-label">Tab switcher · DMX Routes</div>
        <PanelToolbar
          left={
            <>
              <span class="toolbar-readout">Group by</span>
              <SegmentedTabs
                id={`${id}-group`}
                density="compact"
                label="Group by"
                contentId={`${id}-routes`}
                options={groupingOptions.map((key) => ({ key, label: key }))}
                value={grouping()}
                onChange={setGrouping}
              />
            </>
          }
          right={<span class="toolbar-readout">3 routes</span>}
        />
        <div
          class="toolbar-route-preview"
          id={`${id}-routes`}
          role="tabpanel"
          aria-labelledby={`${id}-group-${grouping()}`}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: The static tab panel must be reachable after its tab for keyboard readers.
          tabIndex={0}
        >
          <For each={routeGroups()}>
            {([label, routes]) => (
              <div class="toolbar-route-group" role="group" aria-label={label}>
                <div class="toolbar-route-heading">{label}</div>
                <For each={routes}>
                  {(route) => (
                    <div class="toolbar-route-row">
                      <span>{route.fixture}</span>
                      <span>
                        {route.universe} · {route.address}
                      </span>
                    </div>
                  )}
                </For>
              </div>
            )}
          </For>
        </div>
      </div>
      <div class="property-section" role="group" aria-label="Transport toolbar">
        <div class="section-label">Transport controls</div>
        <PanelToolbar
          left={
            <>
              <ToggleToolbarButton
                label="Play preview"
                pressed={playing()}
                onClick={() => setPlaying(!playing())}
              >
                <Show when={playing()} fallback={<PlayIcon size={16} />}>
                  <PauseIcon size={16} />
                </Show>
              </ToggleToolbarButton>
              <ToolbarButton
                label="Stop preview"
                disabled={!playing()}
                onClick={() => setPlaying(false)}
              >
                <StopIcon size={16} />
              </ToolbarButton>
              <ToolbarSeparator />
              <ToggleToolbarButton
                label="Loop preview"
                pressed={loop()}
                onClick={() => setLoop(!loop())}
              >
                <RepeatIcon size={16} />
              </ToggleToolbarButton>
            </>
          }
          right={
            <span class="toolbar-readout">
              {playing() ? "Playing" : "Stopped"} ·{" "}
              {loop() ? "Loop on" : "Loop off"}
            </span>
          }
        />
      </div>
      <div class="property-section" role="group" aria-label="Selection toolbar">
        <div class="section-label">Selection actions</div>
        <DataGridToolbar
          selectedCount={selected()}
          onDelete={() => {
            setSelected(0);
            setNotice("Sample selection deleted.");
          }}
        >
          <span class="toolbar-readout">{selected()} selected</span>
          <Button variant="subtle" onClick={() => setSelected(2)}>
            Select sample rows
          </Button>
        </DataGridToolbar>
      </div>
      <p class="field-help" role="status">
        {notice()}
      </p>
    </section>
  );
}
