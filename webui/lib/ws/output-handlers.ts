// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  dmxUniverseChannels,
  dmxUniverseList,
  inputContributionTrace,
  layerStack,
} from "../../state/appStores";
import type * as types from "../../types";
import { setStoreAction } from "../nanostore-action";
import { queueReactiveParameterState } from "../parameter-state-publisher";
import {
  measureNextAnimationFrame,
  measurePerformanceScope,
} from "../performance-marks";
import type { WsMessageHandlerRegistry } from "./message-registry";
import type { AnyWsMessage, FixtureParameterState, LayerState } from "./types";

/** Registers parameter output, layer stack, DMX universe, and input trace handlers. */
export function registerOutputHandlers(
  registry: WsMessageHandlerRegistry<AnyWsMessage>,
): void {
  registry.register("ParameterState", (message) => {
    // The runtime already refreshed the immediate visualizer outputs before
    // dispatch; the reactive panel store is throttled to keep Solid
    // subscribers responsive.
    queueReactiveParameterState(message.data as FixtureParameterState[]);
  });

  registry.register("LayerStack", (message) => {
    const data = message.data as LayerState[];
    measurePerformanceScope(
      "websocket-main.layer-stack.store-set",
      () => setStoreAction(layerStack, "Receive LayerStack", data),
      { layerCount: data.length },
    );
    measureNextAnimationFrame("websocket-main.layer-stack.next-frame", {
      layerCount: data.length,
    });
  });

  registry.register("DmxUniverseList", (message) => {
    setStoreAction(
      dmxUniverseList,
      "Receive DmxUniverseList",
      message.data as types.DmxUniverseSummary[],
    );
  });

  registry.register("DmxUniverseChannels", (message) => {
    setStoreAction(
      dmxUniverseChannels,
      "Receive DmxUniverseChannels",
      message.data as types.DmxUniverseChannels[],
    );
  });

  registry.register("InputContributionTrace", (message) => {
    setStoreAction(
      inputContributionTrace,
      "Receive InputContributionTrace",
      message.data as types.OutboundInputContribution[],
    );
  });
}
