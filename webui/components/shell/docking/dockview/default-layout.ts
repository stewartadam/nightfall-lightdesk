// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { DockviewApi, EdgeGroupPosition } from "dockview";
import { areExperimentalFlowsEnabled } from "../../../../lib/experimental-features";
import { isVisualizerDefaultPanelEnabled } from "../../../../lib/feature-flags";
import { clearLayout } from "../../../../lib/layoutStorage";
import { getLogger } from "../../../../lib/logger";
import {
  type PanelDefinition,
  panelDefinitionByName,
} from "../../../../lib/panel-definitions";
import {
  getComponentNames,
  getComponentRegistration,
} from "../../../../lib/panel-registry";
import {
  DEFAULT_EDGE_GROUP_IDS,
  DEFAULT_EDGE_GROUP_POSITIONS,
  EDGE_GROUP_COLLAPSED_SIZE,
} from "./default-edge-groups";
import { visualLanguageDockTheme } from "./dockview-host";

const log = getLogger(import.meta.url);

interface DefaultLayoutOptions {
  /** Dockview host element whose size drives the seeded column widths. */
  host: HTMLElement | undefined;
  /** Compact workspaces never persist, so they keep the saved docked session. */
  compact: boolean | undefined;
}

/** Seeds the performance workspace with visible clips, show objects, and visualization. */
export function createDefaultLayout(
  api: DockviewApi,
  options: DefaultLayoutOptions,
) {
  /** Removes structural edge slots that survive Dockview's panel clear. */
  const removeDefaultEdgeGroups = () => {
    for (const edgePosition of DEFAULT_EDGE_GROUP_POSITIONS) {
      if (api.getEdgeGroup(edgePosition)) {
        api.removeEdgeGroup(edgePosition);
      }
    }
  };

  /** Opens clips when the three columns fit, keeping utility panels collapsed. */
  const applyDefaultEdgeState = () => {
    for (const edgePosition of ["bottom", "right"] as const) {
      api.getEdgeGroup(edgePosition)?.collapse();
    }
    if (expandClips) api.getEdgeGroup("left")?.expand();
    else api.getEdgeGroup("left")?.collapse();
  };

  // Clear the saved layout and panel UI. A compact workspace never persists,
  // so it leaves the docked session for when the window widens again.
  if (!options.compact) clearLayout();
  removeDefaultEdgeGroups();
  api.clear();

  /** Adds a registered panel and reports missing components or docking failures. */
  const addPanel = <T extends Record<string, unknown>>(
    definition: PanelDefinition,
    position: {
      direction: string;
      referencePanel?: string;
      referenceGroup?: string;
    } = {
      direction: "right",
    },
    params: T = {} as T,
    inactive = false,
  ) => {
    const { componentName, panelId, title } = definition;
    // Verify component exists before trying to create it
    const registration = getComponentRegistration(componentName);
    if (!registration) {
      const available = getComponentNames().join(", ");
      log.error(
        `Attempted to create panel with unregistered component: ${componentName}`,
        {
          panelId,
          availableComponents: available,
        },
      );
      throw new Error(
        `Cannot create panel: component "${componentName}" is not registered. Available: ${available}`,
      );
    }

    log.debug(`Creating panel ${panelId} with component ${componentName}`);

    try {
      return api.addPanel({
        id: panelId,
        component: componentName,
        title,
        position,
        params,
        inactive,
      });
    } catch (error) {
      log.error(
        `Failed to create panel ${panelId} with component ${componentName}:`,
        error,
      );
      throw error;
    }
  };

  /** Creates a permanent collapsible edge group and seeds its first panel. */
  const addEdgePanel = (
    edgePosition: EdgeGroupPosition,
    groupId: string,
    definition: PanelDefinition,
    initialSize: number,
  ) => {
    api.addEdgeGroup(edgePosition, {
      collapsedSize: EDGE_GROUP_COLLAPSED_SIZE,
      id: groupId,
      initialSize,
      minimumSize:
        edgePosition === "left" || edgePosition === "right"
          ? definition.minWidth
          : definition.minHeight,
    });

    return addPanel(
      definition,
      {
        referenceGroup: groupId,
        direction: "within",
      },
      {},
      true,
    );
  };

  const width = options.host?.clientWidth ?? api.width;
  const height = options.host?.clientHeight ?? api.height;
  const clipsWidth = Math.max(550, Math.round(width * 0.28));
  const visualizerEnabled = isVisualizerDefaultPanelEnabled();
  const gridMinimumWidth =
    panelDefinitionByName("GroupsPanel").minWidth +
    (visualizerEnabled ? panelDefinitionByName("Visualizer").minWidth : 0);
  const expandClips =
    width >=
    clipsWidth +
      gridMinimumWidth +
      EDGE_GROUP_COLLAPSED_SIZE +
      4 * (visualLanguageDockTheme.gap ?? 0);

  addEdgePanel(
    "left",
    DEFAULT_EDGE_GROUP_IDS.left,
    panelDefinitionByName("ClipList"),
    clipsWidth,
  );

  addEdgePanel(
    "bottom",
    DEFAULT_EDGE_GROUP_IDS.bottom,
    panelDefinitionByName("StatusDisplay"),
    260,
  );

  addEdgePanel(
    "right",
    DEFAULT_EDGE_GROUP_IDS.right,
    panelDefinitionByName("PropertiesInspector"),
    340,
  );

  for (const componentName of [
    "ProgrammerGrid",
    "SelectionVisualizer",
    "FixtureGrid",
    "PatchEditor",
  ] as const) {
    addPanel(
      panelDefinitionByName(componentName),
      {
        referenceGroup: DEFAULT_EDGE_GROUP_IDS.bottom,
        direction: "within",
      },
      {},
      true,
    );
  }

  for (const componentName of [
    "Tempo",
    "TapPattern",
    "CommandLine",
    "Instrumentation",
  ] as const) {
    addPanel(
      panelDefinitionByName(componentName),
      {
        referenceGroup: DEFAULT_EDGE_GROUP_IDS.right,
        direction: "within",
      },
      {},
      true,
    );
  }

  const groupsPanel = addPanel(panelDefinitionByName("GroupsPanel"), {
    direction: "left",
  });

  addPanel(
    panelDefinitionByName("SequenceList"),
    {
      referencePanel: groupsPanel.id,
      direction: "within",
    },
    {},
    true,
  );

  addPanel(
    panelDefinitionByName("FxList"),
    {
      referencePanel: groupsPanel.id,
      direction: "within",
    },
    {},
    true,
  );

  if (areExperimentalFlowsEnabled()) {
    addPanel(
      panelDefinitionByName("FlowList"),
      {
        referencePanel: groupsPanel.id,
        direction: "within",
      },
      {},
      true,
    );
  }

  addPanel(panelDefinitionByName("TimelinesPanel"), {
    referencePanel: groupsPanel.id,
    direction: "below",
  });

  // Add the visualizer beside the entire vertically split center column.
  if (visualizerEnabled) {
    addPanel(panelDefinitionByName("Visualizer"), {
      direction: "right",
    });
  }

  groupsPanel.api.setActive();
  applyDefaultEdgeState();

  if (width > 0 && height > 0) {
    requestAnimationFrame(() => {
      applyDefaultEdgeState();
      api.layout(width, height, true);
      groupsPanel.api.setSize({
        height: Math.round((height - EDGE_GROUP_COLLAPSED_SIZE) / 2),
      });
      const visualizer = api.getPanel("panel-Visualizer");
      visualizer?.api.setSize({
        width: Math.round(
          (width -
            (expandClips ? clipsWidth : EDGE_GROUP_COLLAPSED_SIZE) -
            EDGE_GROUP_COLLAPSED_SIZE) *
            0.43,
        ),
      });
    });
  }
}
