// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { ArrowsClockwiseIcon } from "@squidlab/phosphor-solid/arrows-clockwise";
import { LayoutIcon } from "@squidlab/phosphor-solid/layout";
import { type Accessor, createMemo } from "solid-js";
import {
  type ContextMenuEntry,
  openContextMenu,
} from "../../../components/providers/context-menu";
import {
  networkDmxOutputsFromSettings,
  usbDmxOutputsFromSettings,
} from "../../../lib/network-dmx-output-targets";
import { useSharedStore } from "../../../lib/use-shared-store";
import { normalizeAttributeName } from "../../../lib/utils";
import type { LayerElementParameterValues } from "../../../lib/ws/types";
import {
  dockApi,
  fixtures,
  layerStack,
  requestDmxRouteNavigation,
  requestLayerNavigation,
  routes,
} from "../../../state/appStores";
import { DmxIoMode } from "../../../types";
import type { ChannelInfo } from "../model/dmx-universe-model";
import {
  findInputRouteIdForOutputChannel,
  findOutputRouteIdForChannel,
} from "../model/output-route-follow";
import type { DmxUniverseSelectionController } from "./dmx-universe-selection-controller";

interface DmxChannelNavigationControllerOptions {
  selection: DmxUniverseSelectionController;
  channelToFixture: Accessor<Map<number, ChannelInfo>>;
}

/** Owns channel follow, DMX route lookup, and asserting-layer navigation. */
export function createDmxChannelNavigationController(
  options: DmxChannelNavigationControllerOptions,
) {
  const dock = useStore(dockApi);
  const routeSnapshot = useStore(routes);
  const fixtureMap = useSharedStore(fixtures);
  const layers = useStore(layerStack);
  /** Returns network output targets used for route lookup. */
  const networkDmxOutputs = createMemo(() =>
    networkDmxOutputsFromSettings(options.selection.settings()),
  );
  /** Returns USB output targets used for route lookup. */
  const usbDmxOutputs = createMemo(() =>
    usbDmxOutputsFromSettings(options.selection.settings()),
  );

  /** Opens or focuses the patch editor panel. */
  const ensurePatchPanelOpen = () => {
    const api = dock();
    if (!api) return;
    const panelId = "panel-PatchEditor";
    const panel = api.getPanel(panelId);
    if (panel) panel.focus();
    else
      api.addPanel({
        id: panelId,
        component: "PatchEditor",
        title: "Patch",
        params: {},
      });
  };

  /** Opens or focuses the layer stack panel. */
  const ensureLayerPanelOpen = () => {
    const api = dock();
    if (!api) return;
    const panelId = "panel-LayerStack";
    const panel = api.getPanel(panelId);
    if (panel) panel.focus();
    else
      api.addPanel({
        id: panelId,
        component: "LayerStack",
        title: "Layers",
        params: {},
      });
  };

  /** Reports whether a layer row asserts a normalized fixture attribute. */
  const layerHasAssertedAttribute = (
    rows: LayerElementParameterValues[],
    fixtureUid: string,
    elementIndex: number,
    attributeKey: string,
  ) => {
    const fixtureRow = rows.find((row) => row.fixture_uid === fixtureUid);
    const elementParams = fixtureRow?.parameters[elementIndex - 1];
    return Boolean(
      elementParams &&
        Object.keys(elementParams).some(
          (key) => normalizeAttributeName(key) === attributeKey,
        ),
    );
  };

  /** Finds the topmost layer asserting the fixture attribute mapped to a channel. */
  const findAssertingLayerIndex = (
    address: number,
    sourceLayers = layers(),
  ): number | null => {
    const channelInfo = options.channelToFixture().get(address);
    if (!channelInfo) return null;
    for (let index = sourceLayers.length - 1; index >= 0; index -= 1) {
      const layer = sourceLayers[index];
      if (
        layerHasAssertedAttribute(
          layer.asserted_absolute_values,
          channelInfo.fixtureUid,
          channelInfo.elementIndex,
          channelInfo.attributeKey,
        ) ||
        layerHasAssertedAttribute(
          layer.asserted_relative_values,
          channelInfo.fixtureUid,
          channelInfo.elementIndex,
          channelInfo.attributeKey,
        )
      )
        return index;
    }
    return null;
  };

  /** Finds the route row that supplies one visible output channel. */
  const findOutputRouteId = (address: number): string | null => {
    if (options.selection.ioMode() !== DmxIoMode.Output) return null;
    const universeId = options.selection.selectedUniverse();
    if (universeId === null) return null;
    const space = options.selection.selectedOutputSpace();
    const snapshot = routeSnapshot();
    const targets = {
      networkDmxOutputs: networkDmxOutputs(),
      usbDmxOutputs: usbDmxOutputs(),
    };
    return (
      findInputRouteIdForOutputChannel(
        snapshot,
        space,
        universeId,
        address,
        targets,
      ) ??
      findOutputRouteIdForChannel(
        snapshot,
        fixtureMap(),
        space,
        universeId,
        address,
        targets,
      )
    );
  };

  /** Navigates to the DMX route supplying one output channel. */
  const followOutputRoute = (address: number) => {
    const routeId = findOutputRouteId(address);
    if (!routeId) return false;
    requestDmxRouteNavigation(routeId);
    ensurePatchPanelOpen();
    return true;
  };

  /** Navigates to the topmost layer asserting one output channel. */
  const navigateToAssertingLayer = (address: number) => {
    const channelInfo = options.channelToFixture().get(address);
    if (!channelInfo) return false;
    const layerIndex = findAssertingLayerIndex(address);
    if (layerIndex === null) return false;
    requestLayerNavigation({
      layerIndex,
      fixtureUid: channelInfo.fixtureUid,
      elementIndex: channelInfo.elementIndex,
    });
    ensureLayerPanelOpen();
    return true;
  };

  /** Handles modifier-click shortcuts on one DMX channel. */
  const handleChannelClick = (event: MouseEvent, address: number) => {
    if (!event.altKey || options.selection.ioMode() !== DmxIoMode.Output)
      return;
    if (event.shiftKey) navigateToAssertingLayer(address);
    else followOutputRoute(address);
  };

  /** Opens channel navigation actions in the shared context menu. */
  const handleChannelContextMenu = (event: MouseEvent, address: number) => {
    if (options.selection.ioMode() !== DmxIoMode.Output) return;
    event.preventDefault();
    const items: ContextMenuEntry[] = [
      {
        id: "follow-output-route",
        label: "Follow route in Patch",
        icon: ArrowsClockwiseIcon,
        shortcut: "Alt+Click",
        disabled: findOutputRouteId(address) === null,
        onSelect: () => followOutputRoute(address),
      },
      {
        id: "show-asserting-layer",
        label: "Show asserting layer",
        icon: LayoutIcon,
        shortcut: "Alt+Shift+Click",
        disabled: findAssertingLayerIndex(address) === null,
        onSelect: () => navigateToAssertingLayer(address),
      },
    ];
    openContextMenu({ x: event.clientX, y: event.clientY, items });
  };

  return {
    layers,
    findAssertingLayerIndex,
    handleChannelClick,
    handleChannelContextMenu,
  };
}
