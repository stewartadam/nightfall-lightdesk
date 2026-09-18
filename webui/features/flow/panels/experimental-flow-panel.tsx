// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import type { Component } from "solid-js";
import { ExperimentalPanel } from "../../../components/ui/experimental-panel";
import { runtimeCapabilities } from "../../../state/appStores";

/** Keeps saved flow panels restorable while preventing disabled components from mounting. */
export function gateExperimentalFlowPanel<Props extends object>(
  Panel: Component<Props>,
): Component<Props> {
  /** Renders the flow panel only after the backend advertises an explicit opt-in. */
  return function ExperimentalFlowPanel(props: Props) {
    const capabilities = useStore(runtimeCapabilities);
    return (
      <ExperimentalPanel
        enabled={capabilities()?.experimental_flows === true}
        disabledMessage={
          <>
            Flows are experimental and disabled. Your saved flow data is
            preserved. Restart the backend with NIGHTFALL_EXPERIMENTAL_FLOWS=1
            to enable them.
          </>
        }
      >
        <Panel {...props} />
      </ExperimentalPanel>
    );
  };
}
