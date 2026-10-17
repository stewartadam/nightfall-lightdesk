// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { JSX } from "solid-js";
import { formatNumber } from "../model/metrics";

interface PipelineStepProps {
  label: string;
  value: unknown;
}

interface MetricCardProps {
  label: JSX.Element;
  value: JSX.Element;
  valueClass?: string;
}

/** Renders a labeled instrumentation value in the shared metric-card treatment. */
export function MetricCard(props: MetricCardProps) {
  return (
    <div class="rounded-lg bg-gray-100 p-3 dark:bg-gray-800">
      <div class="mb-1 text-xs text-gray-500 dark:text-gray-400">
        {props.label}
      </div>
      <div
        class={`font-mono text-gray-900 dark:text-white ${props.valueClass ?? "text-lg"}`}
      >
        {props.value}
      </div>
    </div>
  );
}

interface MetricRowProps {
  label: string;
  value: JSX.Element;
}

/** Renders a compact label/value pair inside an instrumentation section. */
export function MetricRow(props: MetricRowProps) {
  return (
    <div class="flex items-center justify-between">
      <span class="text-sm text-gray-600 dark:text-gray-300">
        {props.label}
      </span>
      <span class="font-mono text-sm text-gray-900 dark:text-white">
        {props.value}
      </span>
    </div>
  );
}

/** Renders one timed stage in the visualizer rendering pipeline. */
export function PipelineStep(props: PipelineStepProps) {
  return (
    <div class="flex items-center gap-2 rounded-full border border-gray-200 bg-gray-50 px-3 py-1 dark:border-gray-700 dark:bg-gray-900">
      <span class="text-xs text-gray-500 dark:text-gray-400">
        {props.label}
      </span>
      <span class="font-mono text-xs">
        {formatNumber(props.value, 2, " ms")}
      </span>
    </div>
  );
}
