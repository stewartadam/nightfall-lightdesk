// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { type JSX, Show } from "solid-js";

interface ExperimentalPanelProps {
  enabled: boolean;
  disabledMessage: JSX.Element;
  children: JSX.Element;
}

/** Defers mounting experimental panel content until enabled, showing guidance otherwise. */
export function ExperimentalPanel(props: ExperimentalPanelProps) {
  return (
    <Show
      when={props.enabled}
      fallback={
        <div
          class="relative h-full w-full bg-[#18181b] p-4 text-sm text-gray-400"
          role="status"
        >
          {props.disabledMessage}
        </div>
      }
    >
      {props.children}
    </Show>
  );
}
