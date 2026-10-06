// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import type { Accessor } from "solid-js";
import { connectionStatus } from "../../../lib/engine-runtime";
import { wsStats } from "../../../state/appStores";
import Tooltip from "../../ui/tooltip";

/** Engine connection health as the toolbar indicator presents it. */
export interface ConnectionHealth {
  /** Short description such as "Connected" or "Degraded". */
  readonly label: Accessor<string>;
  /** Tailwind background class for the indicator dot. */
  readonly color: Accessor<string>;
}

/**
 * Tracks the engine connection, treating a connected socket whose main-thread
 * delivery is falling behind as degraded.
 */
export function useConnectionHealth(): ConnectionHealth {
  const websocketStats = useStore(wsStats);

  /** Whether websocket delivery is connected but falling behind on the main thread. */
  const isDegraded = () =>
    connectionStatus() === "connected" &&
    (websocketStats()?.main.backlogLagging ?? false);

  return {
    label: () => {
      if (isDegraded()) return "Degraded";
      switch (connectionStatus()) {
        case "connected":
          return "Connected";
        case "connecting":
          return "Connecting...";
        case "disconnected":
          return "Disconnected";
        default:
          return "Unknown";
      }
    },
    color: () => {
      if (isDegraded()) return "bg-yellow-500";
      switch (connectionStatus()) {
        case "connected":
          return "bg-green-500";
        case "connecting":
          return "bg-yellow-500";
        case "disconnected":
          return "bg-red-500";
        default:
          return "bg-gray-500";
      }
    },
  };
}

/** Colored dot for the engine connection, with its health in a tooltip and accessible name. */
export function ConnectionIndicator(props: { class?: string }) {
  const health = useConnectionHealth();
  return (
    <Tooltip content={health.label}>
      <span
        role="status"
        aria-label={health.label()}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users need access to the connection tooltip.
        tabIndex={0}
        class={`${props.class ?? ""} focus-visible:outline-2 focus-visible:outline-offset-2`}
      >
        <span class={`inline-block size-2 rounded-full ${health.color()}`} />
      </span>
    </Tooltip>
  );
}
