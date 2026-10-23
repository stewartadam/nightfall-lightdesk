// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { ClipboardIcon } from "@squidlab/phosphor-solid/clipboard";
import { ClockIcon } from "@squidlab/phosphor-solid/clock";
import { PlayCircleIcon } from "@squidlab/phosphor-solid/play-circle";
import { SquaresFourIcon } from "@squidlab/phosphor-solid/squares-four";
import { ThreeDIcon } from "@squidlab/phosphor-solid/three-d";
import type { DockviewApi } from "dockview";
import { type Component, createSignal, For } from "solid-js";
import { openContextMenu } from "../components/providers/context-menu";
import {
  createPanelCapabilityRegistry,
  PanelCapabilityRegistryContext,
  usePanelCapability,
} from "../components/providers/panel-capabilities/context-core";
import {
  DockviewHost,
  visualLanguageDockTheme,
} from "../components/shell/docking/dockview/dockview-host";
import { IconTabRenderer } from "../components/shell/docking/dockview/icon-tab-renderer";
import type { AppIcon } from "../components/ui/icon";
import { OPEN_PANEL_SETTINGS_CAPABILITY } from "../lib/panel-capabilities";
import { registerSolidComponent } from "../lib/panel-registry";
import "./tab-menu-demo.css";

interface SamplePanel {
  id: string;
  title: string;
  icon: AppIcon;
  /** Sample settings; panels without any leave Settings out of their tab menu. */
  settings: string[];
  group: "left" | "right";
}

const samplePanels: SamplePanel[] = [
  {
    id: "tab-menu-clips",
    title: "Clips",
    icon: PlayCircleIcon,
    settings: ["Show stopped clips", "Compact rows", "Show tags"],
    group: "left",
  },
  {
    id: "tab-menu-board",
    title: "Board",
    icon: SquaresFourIcon,
    settings: ["Show grid", "Show labels"],
    group: "left",
  },
  {
    id: "tab-menu-timecodes",
    title: "Timecodes",
    icon: ClockIcon,
    settings: [],
    group: "left",
  },
  {
    id: "tab-menu-visualizer",
    title: "Visualizer",
    icon: ThreeDIcon,
    settings: ["Show beams", "Show labels", "High quality"],
    group: "right",
  },
  {
    id: "tab-menu-programmer",
    title: "Programmer",
    icon: ClipboardIcon,
    settings: [],
    group: "right",
  },
];

/** Registry name for a sample panel, so the production tab finds its icon. */
const componentName = (panel: SamplePanel) => `designLabTabMenu.${panel.id}`;

for (const panel of samplePanels)
  registerSolidComponent(
    componentName(panel),
    panel.title,
    () => null,
    panel.icon,
    { showInPalette: false },
  );

/** Shows the production tab menu: hovering the active tab turns its icon into a caret. */
export function TabMenuDemo() {
  const [enabled, setEnabled] = createSignal<ReadonlySet<string>>(new Set());
  const panelComponentById = new Map<string, string>();
  const capabilities = createPanelCapabilityRegistry();

  /** Opens a checkable sample settings menu under the panel's tab. */
  const openSampleSettings = (panel: SamplePanel) => {
    const tab = document.querySelector(
      `[data-dockview-panel-id="${panel.id}"]`,
    );
    const rect = tab?.getBoundingClientRect();
    openContextMenu({
      x: rect?.left ?? 0,
      y: (rect?.bottom ?? 0) + 4,
      items: [
        { type: "heading", id: "heading", label: `${panel.title} settings` },
        ...panel.settings.map((label) => {
          const key = `${panel.id}:${label}`;
          return {
            id: key,
            label,
            checked: enabled().has(key),
            onSelect: () =>
              setEnabled((current) => {
                const next = new Set(current);
                if (!next.delete(key)) next.add(key);
                return next;
              }),
          };
        }),
      ],
    });
  };

  /** Lays out the sample panels in two groups with the first of each active. */
  const populate = (api: DockviewApi) => {
    let left: string | undefined;
    let right: string | undefined;
    for (const panel of samplePanels) {
      const reference = panel.group === "left" ? left : right;
      panelComponentById.set(panel.id, componentName(panel));
      api.addPanel({
        id: panel.id,
        component: componentName(panel),
        title: panel.title,
        inactive: reference !== undefined,
        position: reference
          ? { referencePanel: reference, direction: "within" }
          : panel.group === "right" && left
            ? { referencePanel: left, direction: "right" }
            : undefined,
      });
      if (panel.group === "left") left ??= panel.id;
      else right ??= panel.id;
    }
  };

  /** Placeholder content that offers its sample settings in the tab menu. */
  const panelContent = (panel: SamplePanel): Component =>
    function SamplePanelContent() {
      if (panel.settings.length > 0)
        usePanelCapability(panel.id, OPEN_PANEL_SETTINGS_CAPABILITY, () =>
          openSampleSettings(panel),
        );
      return (
        <div class="tab-menu-sample">
          <strong>{panel.title}</strong>
          {panel.settings.length === 0 ? (
            <span>No settings, so the tab menu leaves Settings out.</span>
          ) : (
            <For each={panel.settings}>
              {(label) => (
                <span>
                  {label}:{" "}
                  {enabled().has(`${panel.id}:${label}`) ? "on" : "off"}
                </span>
              )}
            </For>
          )}
        </div>
      );
    };

  return (
    <section class="lab-panel tab-menu-demo" aria-label="Tab menu examples">
      <p class="field-help">
        Hover the active tab: its icon turns into a caret that opens the tab
        menu, with the panel's settings first. Right-clicking any tab opens the
        same menu. Without hover, the active tab always shows the caret.
      </p>
      <PanelCapabilityRegistryContext.Provider value={capabilities}>
        <DockviewHost
          class="tab-menu-dock"
          ariaLabel="Tab menu sample workspace"
          components={Object.fromEntries(
            samplePanels.map((panel) => [
              componentName(panel),
              panelContent(panel),
            ]),
          )}
          options={{
            theme: { ...visualLanguageDockTheme, gap: 8 },
            defaultTabComponent: "PanelTab",
            createTabComponent: () =>
              new IconTabRenderer(panelComponentById, capabilities),
          }}
          onReady={populate}
        />
      </PanelCapabilityRegistryContext.Provider>
    </section>
  );
}
