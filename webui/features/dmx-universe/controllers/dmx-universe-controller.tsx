// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { createMemo } from "solid-js";
import { buildFixturePatchMapFromBindings } from "../../../lib/binding-utils";
import { fixtureValueTransitionColor } from "../../../lib/datagrid";
import { fixtureValueSourceState } from "../../../lib/fixture-value-state";
import { layerHasTransitioningAttribute } from "../../../lib/layer-transition-state";
import {
  networkDmxOutputsFromSettings,
  usbDmxOutputsFromSettings,
} from "../../../lib/network-dmx-output-targets";
import { normalizeAttributeName } from "../../../lib/utils";
import {
  bindings,
  fixtures,
  layerStack,
  programmerSelection,
} from "../../../state/appStores";
import { DmxIoMode } from "../../../types";
import { DmxUniverseView } from "../components/dmx-universe-view";
import {
  type ChannelInfo,
  DMX_CHANNEL_VALUE_TEXT_COLORS,
  type DmxChannelValueTone,
  type FixtureJumpTarget,
  getAttributeName,
  normalizeFixtureJumpAttributeSearch,
} from "../model/dmx-universe-model";
import { createDmxChannelNavigationController } from "./dmx-channel-navigation-controller";
import { createDmxFixtureJumpController } from "./dmx-fixture-jump-controller";
import { createDmxUniverseSelectionController } from "./dmx-universe-selection-controller";

export interface DmxUniverseControllerProps {
  id?: string;
  initialPanelId?: string;
}

/** Coordinates DMX universe state and projects it into the props-only view. */
export function DmxUniverseController(_props: DmxUniverseControllerProps) {
  const $fixtures = useStore(fixtures);
  const $bindings = useStore(bindings);
  const $layerStack = useStore(layerStack);
  const $programmerSelection = useStore(programmerSelection);
  const selection = createDmxUniverseSelectionController();
  const {
    settings,
    ioMode,
    setIoMode,
    inputUniverseVisibilityMode,
    setInputUniverseVisibilityMode,
    availableTransports,
    selectedTransport,
    setSelectedTransport,
    universeIds,
    universeById,
    currentUniverse,
    selectedUniverse,
    setSelectedUniverse,
  } = selection;
  const panelId = (_props.initialPanelId as string | undefined) ?? _props.id;

  /** Returns configured network output target mappings from showfile settings. */
  const networkDmxOutputs = createMemo(() =>
    networkDmxOutputsFromSettings(settings()),
  );
  /** Returns configured USB output target mappings from showfile settings. */
  const usbDmxOutputs = createMemo(() => usbDmxOutputsFromSettings(settings()));

  /** Projects fixture patches across console, network, and USB transports. */
  const patchData = createMemo(() =>
    buildFixturePatchMapFromBindings(
      $bindings(),
      $fixtures(),
      networkDmxOutputs(),
      usbDmxOutputs(),
    ),
  );

  /** Maps the selected display transport onto binding transport variants. */
  const transportFilter = createMemo(() => {
    if (ioMode() !== DmxIoMode.Output) return null;
    const transport = selectedTransport();
    if (!transport || transport === "Console") return null;
    switch (transport) {
      case "sACN":
        return "Sacn";
      case "Art-Net":
        return "ArtNet";
      case "USB":
        return "Udmx";
      case "Disabled":
        return "Disabled";
      default:
        return null;
    }
  });

  /** Indexes visible DMX addresses by their patched fixture parameter. */
  const channelToFixture = createMemo(() => {
    const map = new Map<number, ChannelInfo>();
    if (ioMode() !== DmxIoMode.Output) return map;

    const universeId = selectedUniverse();
    if (universeId === null) return map;
    const transport = transportFilter();

    for (const [fixtureUid, patchByElement] of Object.entries(patchData())) {
      const fixture = $fixtures()[fixtureUid];
      if (!fixture) continue;

      // Iterate through each element
      for (const [elementIdStr, patches] of Object.entries(patchByElement)) {
        const elementId = Number.parseInt(elementIdStr, 10);
        const elementIndex = elementId - 1; // Convert 1-based to 0-based
        const element = fixture.elements[elementIndex];
        if (!element) continue;

        for (const patch of patches) {
          if (patch.universe !== universeId) continue;
          if (transport && patch.transport?.type !== transport) continue;

          element.parameters.forEach((param, parameterIndex) => {
            const attrName = getAttributeName(param.attribute);
            const attributeKey = normalizeAttributeName(attrName);
            const addresses = patch.parameterAddresses[parameterIndex] ?? [];

            addresses.forEach((address, byte) => {
              map.set(address, {
                fixtureUid,
                fixtureId: fixture.identifiers.id,
                fixtureLabel: fixture.identifiers.label,
                elementIndex: elementId,
                elementLabel: element.label,
                attribute:
                  byte === 0 ? attrName : `${attrName} (byte ${byte + 1})`,
                attributeKey,
              });
            });
          });
        }
      }
    }
    return map;
  });

  /** Builds jump targets for fixture IDs visible in the current output transport filter. */
  const fixtureJumpTargets = createMemo<FixtureJumpTarget[]>(() => {
    if (ioMode() !== DmxIoMode.Output) return [];
    const visibleUniverseIds = new Set(universeIds());
    if (visibleUniverseIds.size === 0) return [];
    const transport = transportFilter();
    const targets: FixtureJumpTarget[] = [];
    const seenFixtureUniverses = new Set<string>();
    const seenElementUniverses = new Set<string>();

    for (const [fixtureUid, patchByElement] of Object.entries(patchData())) {
      const fixture = $fixtures()[fixtureUid];
      if (!fixture) continue;

      for (const [elementIdText, patches] of Object.entries(patchByElement)) {
        const elementId = Number.parseInt(elementIdText, 10);
        const element = fixture.elements[elementId - 1];
        if (!element) continue;

        for (const patch of patches) {
          if (!visibleUniverseIds.has(patch.universe)) continue;
          if (transport && patch.transport?.type !== transport) continue;

          const targetKey = `${fixture.identifiers.id}:${patch.universe}`;
          if (!seenFixtureUniverses.has(targetKey)) {
            seenFixtureUniverses.add(targetKey);
            targets.push({
              universeId: patch.universe,
              address: patch.address,
              fixtureId: fixture.identifiers.id,
              targetKind: "fixture",
            });
          }

          const elementTargetKey = `${targetKey}:${elementId}`;
          if (!seenElementUniverses.has(elementTargetKey)) {
            seenElementUniverses.add(elementTargetKey);
            targets.push({
              universeId: patch.universe,
              address: patch.address,
              fixtureId: fixture.identifiers.id,
              elementIndex: elementId,
              targetKind: "element",
            });
          }

          element.parameters.forEach((param, parameterIndex) => {
            const address = patch.parameterAddresses[parameterIndex]?.[0];
            if (address === undefined) return;

            const attributeName = getAttributeName(param.attribute);
            targets.push({
              universeId: patch.universe,
              address,
              fixtureId: fixture.identifiers.id,
              elementIndex: elementId,
              attributeName,
              attributeSearchText:
                normalizeFixtureJumpAttributeSearch(attributeName),
              targetKind: "attribute",
            });
          });
        }
      }
    }

    return targets.sort(
      (a, b) =>
        a.fixtureId - b.fixtureId ||
        (a.elementIndex ?? 0) - (b.elementIndex ?? 0) ||
        a.universeId - b.universeId ||
        a.address - b.address,
    );
  });

  /** Returns visible channel addresses belonging to selected fixtures. */
  const selectedChannels = createMemo(() => {
    const channels = new Set<number>();
    if (ioMode() !== DmxIoMode.Output) return channels;

    const universeId = selectedUniverse();
    if (universeId === null) return channels;
    const transport = transportFilter();

    const selection = $programmerSelection();
    if (selection.length === 0) return channels;

    // Build a set of selected fixture UIDs
    const selectedUids = new Set(selection);

    for (const [fixtureUid, patchByElement] of Object.entries(patchData())) {
      // Only process fixtures that are selected
      if (!selectedUids.has(fixtureUid)) continue;

      const fixture = $fixtures()[fixtureUid];
      if (!fixture) continue;

      // Iterate through each element's patch
      for (const [elementIdStr, patches] of Object.entries(patchByElement)) {
        const elementId = Number.parseInt(elementIdStr, 10);
        const elementIndex = elementId - 1;
        const element = fixture.elements[elementIndex];
        if (!element) continue;

        for (const patch of patches) {
          if (patch.universe !== universeId) continue;
          if (transport && patch.transport?.type !== transport) continue;

          for (const addresses of patch.parameterAddresses) {
            for (const address of addresses) {
              channels.add(address);
            }
          }
        }
      }
    }
    return channels;
  });

  const navigation = createDmxChannelNavigationController({
    selection,
    channelToFixture,
  });

  /** Returns whether the mapped fixture attribute for a DMX channel is transitioning. */
  const channelIsTransitioning = (
    address: number,
    channelInfo: ChannelInfo,
  ): boolean => {
    const transitionOwnerLayerIndex =
      navigation.findAssertingLayerIndex(address);
    if (transitionOwnerLayerIndex === null) {
      return false;
    }

    return layerHasTransitioningAttribute(
      $layerStack()[transitionOwnerLayerIndex]?.computed_transitioning,
      channelInfo.fixtureUid,
      channelInfo.elementIndex,
      channelInfo.attributeKey,
    );
  };

  /** Resolves the display tone for one DMX channel value. */
  const channelValueTone = (
    address: number,
    dmxValue: number,
  ): DmxChannelValueTone => {
    if (ioMode() === DmxIoMode.Input) {
      return dmxValue === 0 ? "default" : "input";
    }

    const channelInfo = channelToFixture().get(address);
    if (!channelInfo) {
      return dmxValue === 0 ? "default" : "asserted";
    }

    const sourceState = fixtureValueSourceState(
      $layerStack(),
      channelInfo.fixtureUid,
      channelInfo.elementIndex,
      channelInfo.attributeKey,
    );
    if (sourceState.winningSource === "manual") {
      return "manual";
    }
    if (sourceState.winningSource === "input") {
      return "input";
    }
    if (sourceState.winningSource !== null) {
      return "asserted";
    }
    return "default";
  };

  /** Resolves the text color for one DMX channel value. */
  const channelValueColor = (address: number, dmxValue: number): string => {
    const tone = channelValueTone(address, dmxValue);
    const color = DMX_CHANNEL_VALUE_TEXT_COLORS[tone];
    const channelInfo = channelToFixture().get(address);
    return channelInfo && channelIsTransitioning(address, channelInfo)
      ? fixtureValueTransitionColor(color)
      : color;
  };

  const fixtureJump = createDmxFixtureJumpController({
    panelId,
    ioMode,
    targets: fixtureJumpTargets,
    selectedUniverse,
    setSelectedUniverse,
  });

  return (
    <DmxUniverseView
      ioMode={ioMode()}
      inputUniverseVisibilityMode={inputUniverseVisibilityMode()}
      availableTransports={availableTransports()}
      selectedTransport={selectedTransport()}
      universeIds={universeIds()}
      selectedUniverse={selectedUniverse()}
      currentUniverse={currentUniverse()}
      fixtures={$fixtures()}
      fixtureJumpActive={fixtureJump.active()}
      fixtureJumpText={fixtureJump.text()}
      fixtureJumpHighlight={fixtureJump.highlight()}
      universeForId={(id) => universeById().get(id)}
      channelInfo={(address) => channelToFixture().get(address)}
      channelIsSelected={(address) => selectedChannels().has(address)}
      channelValueColor={channelValueColor}
      onIoModeChange={setIoMode}
      onInputUniverseVisibilityModeChange={setInputUniverseVisibilityMode}
      onSelectedTransportChange={setSelectedTransport}
      onSelectedUniverseChange={setSelectedUniverse}
      onFixtureJumpInputRef={fixtureJump.setInputElement}
      onFixtureJumpTextChange={fixtureJump.updateText}
      onFixtureJumpFinish={(restore) => {
        if (fixtureJump.active()) fixtureJump.finish(restore);
      }}
      onScrollRef={fixtureJump.setScrollElement}
      onChannelClick={navigation.handleChannelClick}
      onChannelContextMenu={navigation.handleChannelContextMenu}
    />
  );
}
