// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { type Accessor, Show } from "solid-js";
import Tooltip from "../../../components/ui/tooltip";

export type CommandValidationSeverity = "warning" | "error";
export type CommandValidationState = "idle" | "pending" | "valid" | "invalid";

interface CommandValidationStatusProps {
  variant: "panel" | "nav";
  input: Accessor<string>;
  state: Accessor<CommandValidationState>;
  severity: Accessor<CommandValidationSeverity>;
  error: Accessor<string | null>;
  forceTooltipOpen: Accessor<boolean>;
}

/** Renders the compact syntax-validation status and explanatory tooltip. */
export const CommandValidationStatus = (
  props: CommandValidationStatusProps,
) => {
  /** Formats the current validation state for assistive text and tooltip content. */
  const tooltipText = () => {
    const state = props.state();
    if (state === "pending") return "Checking command syntax…";
    if (state === "valid") return "Command syntax valid.";
    if (state === "invalid") return props.error() ?? "Invalid command.";
    return "Command syntax status.";
  };

  /** Projects the current validation state into a compact chip label. */
  const chipLabel = () => {
    const state = props.state();
    if (state === "pending") return "…";
    if (state === "valid") return "OK";
    if (state === "invalid") return "!";
    return "•";
  };

  /** Selects variant and severity styling for the validation chip. */
  const chipClasses = () => {
    const state = props.state();
    if (props.variant === "panel") {
      if (state === "pending") return "border-neutral-600 text-neutral-300";
      if (state === "valid") return "border-neutral-500 text-neutral-200";
      if (state === "invalid" && props.severity() === "error") {
        return "border-red-500/80 text-red-300";
      }
      if (state === "invalid") return "border-amber-500/80 text-amber-300";
      return "border-neutral-600 text-neutral-400";
    }
    if (state === "pending") {
      return "border-gray-300 text-gray-500 dark:border-slate-600 dark:text-slate-300";
    }
    if (state === "valid") {
      return "border-gray-400 text-gray-700 dark:border-slate-500 dark:text-slate-200";
    }
    if (state === "invalid" && props.severity() === "error") {
      return "border-red-500/80 text-red-600 dark:text-red-300";
    }
    if (state === "invalid") {
      return "border-amber-500/80 text-amber-700 dark:text-amber-300";
    }
    return "border-gray-300 text-gray-400 dark:border-slate-600 dark:text-slate-400";
  };

  return (
    <Show when={props.input().trim().length > 0}>
      <div class="absolute right-2 top-1/2 z-10 -translate-y-1/2">
        <Tooltip
          content={tooltipText}
          delay={120}
          forceVisible={props.forceTooltipOpen}
        >
          <span
            class={`inline-flex h-5 min-w-5 items-center justify-center rounded border px-1 text-[10px] font-semibold leading-none ${chipClasses()}`}
            role="status"
            aria-label={tooltipText()}
          >
            {chipLabel()}
          </span>
        </Tooltip>
      </div>
    </Show>
  );
};
