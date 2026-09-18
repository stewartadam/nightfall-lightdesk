// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { For, Show } from "solid-js";
import type * as types from "../../../types";

interface InputContributionTraceProps {
  fixtures: Record<string, types.Fixture>;
  trace: types.OutboundInputContribution[];
}

/** Formats an attribute name for the input contribution trace. */
function formatAttributeName(attribute: types.Attribute): string {
  if (attribute.type === "Custom" && attribute.data) {
    return attribute.data.label;
  }
  return attribute.type;
}

/** Presents live and stale input contributions without reading application stores. */
export function InputContributionTrace(props: InputContributionTraceProps) {
  const visibleTrace = () => props.trace.slice(0, 200);
  const liveCount = () => props.trace.filter((item) => !item.is_stale).length;
  const staleCount = () => props.trace.filter((item) => item.is_stale).length;

  return (
    <Show when={props.trace.length > 0}>
      <div class="rounded border border-gray-700 bg-gray-900 p-2">
        <div class="mb-2 flex items-center justify-between text-xs text-gray-400">
          <span>Input contribution trace</span>
          <span>
            {liveCount()} live / {staleCount()} stale
          </span>
        </div>
        <div class="max-h-56 space-y-1 overflow-auto text-xs">
          <For each={visibleTrace()}>
            {(item) => {
              const fixture = props.fixtures[item.fixture_uid];
              const fixtureLabel = fixture
                ? `#${fixture.identifiers.id}.${item.element_index}`
                : `${item.fixture_uid.slice(0, 8)}.${item.element_index}`;
              return (
                <div class="flex items-center gap-2 rounded bg-gray-800 px-2 py-1">
                  <span
                    class="h-2 w-2 rounded-full"
                    classList={{
                      "bg-emerald-400": !item.is_stale,
                      "bg-amber-400": item.is_stale,
                    }}
                  />
                  <span class="w-28 shrink-0 text-gray-300">
                    {item.transport} U{item.universe_id}:{item.source_address}
                  </span>
                  <span class="w-24 shrink-0 text-gray-300">
                    {fixtureLabel}
                  </span>
                  <span class="min-w-0 flex-1 truncate text-gray-200">
                    {formatAttributeName(item.attribute)}
                  </span>
                  <span class="w-16 shrink-0 text-right font-mono text-gray-300">
                    {Math.round(item.output_value)}
                  </span>
                  <span class="w-16 shrink-0 text-right text-gray-500">
                    {item.frame_age_ms}ms
                  </span>
                </div>
              );
            }}
          </For>
        </div>
        <Show when={props.trace.length > visibleTrace().length}>
          <div class="mt-2 text-right text-xs text-gray-500">
            Showing first {visibleTrace().length} of {props.trace.length}
          </div>
        </Show>
      </div>
    </Show>
  );
}
