// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { AppWindowIcon } from "@squidlab/phosphor-solid/app-window";
import { ArrowLeftIcon } from "@squidlab/phosphor-solid/arrow-left";
import { ArrowRightIcon } from "@squidlab/phosphor-solid/arrow-right";
import { BrowsersIcon } from "@squidlab/phosphor-solid/browsers";
import { XSquareIcon } from "@squidlab/phosphor-solid/x-square";
import { createEffect } from "solid-js";
import { isExperimentalFlowPanel } from "../../../../lib/experimental-features";
import { panelDefinitionsForPalette } from "../../../../lib/panel-definitions";
import {
  openOrFocusPanelDefinition,
  panelOpenPlacementFromExecutionContext,
} from "../../../../lib/panel-open-command";
import { isTauriRuntime } from "../../../../lib/tauri";
import { runtimeCapabilities } from "../../../../state/appStores";
import { useAppShell } from "../../../providers/app-shell";
import { useCommand } from "../../../providers/command-registry";

interface DockviewCommandsProps {
  onResetLayout?: () => void;
}

export function DockviewCommands(props: DockviewCommandsProps) {
  const { dockviewApi } = useAppShell();
  const capabilities = useStore(runtimeCapabilities);

  /** Registers palette commands for every dockable panel component. */
  createEffect(() => {
    for (const definition of panelDefinitionsForPalette()) {
      if (
        isExperimentalFlowPanel(definition.componentName) &&
        !capabilities()?.experimental_flows
      )
        continue;
      useCommand({
        id: definition.panelId,
        name: `Open ${definition.title}`,
        description: `Open a new ${definition.title} panel`,
        category: "Panels",
        shortcut: definition.shortcut,
        icon: definition.icon || AppWindowIcon,
        execute: (context) => {
          openOrFocusPanelDefinition(
            dockviewApi(),
            definition,
            panelOpenPlacementFromExecutionContext(context),
          );
        },
      });
    }
  });

  useCommand({
    id: "reset-layout",
    name: "Reset Layout",
    description: "Reset the dockview layout to default",
    category: "Layout",
    icon: BrowsersIcon,
    execute: () => {
      if (dockviewApi()) {
        props.onResetLayout?.();
      }
    },
  });

  useCommand({
    id: "focus-previous-panel",
    name: "Focus Previous Panel",
    description: "Move focus to the previous Dockview panel",
    category: "Layout",
    shortcut: "Control+PageUp",
    icon: ArrowRightIcon,
    execute: () => {
      dockviewApi()?.activatePrevious({ includePanel: true });
    },
  });

  useCommand({
    id: "focus-next-panel",
    name: "Focus Next Panel",
    description: "Move focus to the next Dockview panel",
    category: "Layout",
    shortcut: "Control+PageDown",
    icon: ArrowLeftIcon,
    execute: () => {
      dockviewApi()?.activateNext({ includePanel: true });
    },
  });

  useCommand({
    id: "close-panel",
    name: "Close Panel",
    description: "Close the currently focused panel",
    category: "Layout",
    shortcut: "$mod+k w",
    shortcutAliases: isTauriRuntime() ? ["$mod+w"] : undefined,
    icon: XSquareIcon,
    execute: () => {
      const activePanel = dockviewApi()?.activePanel;
      if (activePanel) {
        activePanel.api.close();
      }
    },
  });

  return null;
}
