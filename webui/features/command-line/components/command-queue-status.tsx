// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { ArrowsClockwiseIcon } from "@squidlab/phosphor-solid/arrows-clockwise";
import { type Accessor, For, Show } from "solid-js";
import Tooltip from "../../../components/ui/tooltip";
import type { PendingCommandSubmission } from "../controllers/command-line-controller";

interface CommandQueueStatusProps {
  variant: "panel" | "nav";
  pending: Accessor<readonly PendingCommandSubmission[]>;
  /** Whether the validation chip occupies the input's right edge. */
  besideValidation: Accessor<boolean>;
}

/** Summarizes running and queued submissions for assistive text. */
export function commandQueueSummary(
  pending: readonly PendingCommandSubmission[],
): string {
  const queued = pending.length - 1;
  if (queued <= 0) return "1 command running";
  return `1 command running, ${queued} queued`;
}

/**
 * Shows that accepted commands are still running or waiting their turn, with
 * a tooltip listing each one, so a cleared input does not read as the command
 * having finished.
 */
export const CommandQueueStatus = (props: CommandQueueStatusProps) => {
  /** Selects variant styling that matches the neighbouring validation chip. */
  const chipClasses = () =>
    props.variant === "panel"
      ? "border-sky-500/70 text-sky-300"
      : "border-sky-500/70 text-sky-700 dark:text-sky-300";

  return (
    <Show when={props.pending().length > 0}>
      <div
        class="absolute top-1/2 z-10 -translate-y-1/2"
        style={{ right: props.besideValidation() ? "34px" : "8px" }}
      >
        <Tooltip
          content={() => (
            <div class="flex max-w-72 flex-col gap-0.5 font-mono text-xs">
              <For each={props.pending()}>
                {(submission, index) => (
                  <div class="truncate">
                    <span class="font-sans opacity-70">
                      {index() === 0 ? "Running: " : "Queued: "}
                    </span>
                    {submission.command}
                  </div>
                )}
              </For>
            </div>
          )}
          delay={120}
        >
          <span
            class={`inline-flex h-5 items-center gap-1 rounded border px-1 text-[10px] font-semibold leading-none ${chipClasses()}`}
            role="status"
            aria-label={commandQueueSummary(props.pending())}
            data-command-queue-count={props.pending().length}
          >
            <ArrowsClockwiseIcon class="size-3 animate-spin" aria-hidden />
            {props.pending().length}
          </span>
        </Tooltip>
      </div>
    </Show>
  );
};
