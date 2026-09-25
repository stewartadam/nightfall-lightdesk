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
import { buildFixturePatchMapFromBindings } from "../../../lib/binding-utils";
import {
  networkDmxOutputsFromSettings,
  usbDmxOutputsFromSettings,
} from "../../../lib/network-dmx-output-targets";
import { normalizeAttributeName } from "../../../lib/utils";
import {
  bindings,
  dockApi,
  fixtures,
  layerStack,
  requestLayerNavigation,
  requestPatchBindingNavigation,
} from "../../../state/appStores";
import type * as types from "../../../types";
import { DmxIoMode } from "../../../types";
import type { ChannelInfo } from "../model/dmx-universe-model";
import {
  getChannelWidth,
  normalizeSelectedTransport,
  outputTransportMatchesSelection,
} from "../model/dmx-universe-model";
import { findInputBindingIdForOutputChannel } from "../model/output-binding-follow";
import type { DmxUniverseSelectionController } from "./dmx-universe-selection-controller";

interface DmxChannelNavigationControllerOptions {
  selection: DmxUniverseSelectionController;
  channelToFixture: Accessor<Map<number, ChannelInfo>>;
}

/** Owns channel follow, patch binding lookup, and asserting-layer navigation. */
export function createDmxChannelNavigationController(
  options: DmxChannelNavigationControllerOptions,
) {
  const dock = useStore(dockApi);
  const bindingSnapshot = useStore(bindings);
  const fixtureMap = useStore(fixtures);
  const layers = useStore(layerStack);
  /** Returns network output targets used for binding lookup. */
  const networkDmxOutputs = createMemo(() =>
    networkDmxOutputsFromSettings(options.selection.settings()),
  );
  /** Returns USB output targets used for binding lookup. */
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
    rows: types.OutboundElementParameterValues[],
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

  /** Calculates the number of physical DMX channels used by one fixture element. */
  const elementChannelWidth = (fixture: types.Fixture, elementId: number) => {
    const element = fixture.elements[elementId - 1];
    if (!element) return 0;
    return element.parameters.reduce(
      (width, parameter) =>
        parameter.attribute.type === "VirtualIntensity"
          ? width
          : width + getChannelWidth(parameter.resolution),
      0,
    );
  };

  /** Finds the binding row that supplies one visible output channel. */
  const findOutputBindingId = (address: number): string | null => {
    if (options.selection.ioMode() !== DmxIoMode.Output) return null;
    const universeId = options.selection.selectedUniverse();
    if (universeId === null) return null;
    const transport = normalizeSelectedTransport(
      options.selection.selectedTransport(),
    );
    const snapshot = bindingSnapshot();
    const fixturesByUid = fixtureMap();
    const inputBindingId = findInputBindingIdForOutputChannel(
      snapshot,
      transport,
      universeId,
      address,
    );
    if (inputBindingId) return inputBindingId;

    const fixtureConsoleBindings = snapshot.output.filter(
      (binding) =>
        binding.source.type === "Fixture" && binding.target.type === "Console",
    );
    for (const [bindingIndex, binding] of snapshot.output.entries()) {
      const isConsolePassthrough =
        binding.source.type === "Console" &&
        binding.target.type === "Transport";
      const isFixtureBinding =
        binding.source.type === "Fixture" &&
        (binding.target.type === "Transport" ||
          binding.target.type === "Console");
      if (!isConsolePassthrough && !isFixtureBinding) continue;
      const patchMap = buildFixturePatchMapFromBindings(
        {
          input: [],
          output: isConsolePassthrough
            ? [...fixtureConsoleBindings, binding]
            : [binding],
          disabled: snapshot.disabled,
        },
        fixturesByUid,
        networkDmxOutputs(),
        usbDmxOutputs(),
      );
      for (const [fixtureUid, patchesByElement] of Object.entries(patchMap)) {
        const fixture = fixturesByUid[fixtureUid];
        if (!fixture) continue;
        for (const [elementIdText, patches] of Object.entries(
          patchesByElement,
        )) {
          const width = elementChannelWidth(
            fixture,
            Number.parseInt(elementIdText, 10),
          );
          if (width <= 0) continue;
          for (const patch of patches) {
            if (
              (!isConsolePassthrough || patch.transport !== null) &&
              patch.universe === universeId &&
              outputTransportMatchesSelection(patch.transport, transport) &&
              address >= patch.address &&
              address <= patch.address + width - 1
            )
              return `output-${bindingIndex}`;
          }
        }
      }
    }
    return null;
  };

  /** Navigates to the patch binding supplying one output channel. */
  const followOutputBinding = (address: number) => {
    const bindingId = findOutputBindingId(address);
    if (!bindingId) return false;
    requestPatchBindingNavigation(bindingId);
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
    else followOutputBinding(address);
  };

  /** Opens channel navigation actions in the shared context menu. */
  const handleChannelContextMenu = (event: MouseEvent, address: number) => {
    if (options.selection.ioMode() !== DmxIoMode.Output) return;
    event.preventDefault();
    const items: ContextMenuEntry[] = [
      {
        id: "follow-output-binding",
        label: "Follow binding in Patch",
        icon: ArrowsClockwiseIcon,
        shortcut: "Alt+Click",
        disabled: findOutputBindingId(address) === null,
        onSelect: () => followOutputBinding(address),
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
