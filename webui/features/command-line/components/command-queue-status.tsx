// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { ArrowsClockwiseIcon } from "@squidlab/phosphor-solid/arrows-clockwise";
import { type Accessor, Show } from "solid-js";
import type { PendingCommandSubmission } from "../controllers/command-line-controller";

interface CommandQueueStatusProps {
  variant: "panel" | "nav";
  pending: Accessor<readonly PendingCommandSubmission[]>;
  /** Whether the validation chip occupies the input's right edge. */
  besideValidation: Accessor<boolean>;
  /** Reveals the running and queued commands, e.g. in the Console panel. */
  onReveal: () => void;
}

/** Summarizes running and queued submissions for the indicator's accessible name. */
export function commandQueueSummary(
  pending: readonly PendingCommandSubmission[],
): string {
  const queued = pending.length - 1;
  if (queued <= 0) return "1 command running";
  return `1 command running, ${queued} queued`;
}

/**
 * Shows that accepted commands are still running or waiting their turn, so a
 * cleared input does not read as the command having finished. Clicking it
 * reveals the pending commands.
 */
export const CommandQueueStatus = (props: CommandQueueStatusProps) => {
  /** Selects variant styling that matches the neighbouring validation chip. */
  const chipClasses = () =>
    props.variant === "panel"
      ? "border-sky-500/70 text-sky-300 hover:bg-sky-500/15"
      : "border-sky-500/70 text-sky-700 hover:bg-sky-500/10 dark:text-sky-300";

  return (
    <Show when={props.pending().length > 0}>
      <div
        class="absolute top-1/2 z-10 -translate-y-1/2"
        style={{ right: props.besideValidation() ? "34px" : "8px" }}
      >
        <button
          type="button"
          class={`inline-flex h-5 cursor-pointer items-center gap-1 rounded border px-1 text-[10px] font-semibold leading-none ${chipClasses()}`}
          aria-label={`${commandQueueSummary(props.pending())}. Show in Console`}
          data-command-queue-count={props.pending().length}
          onClick={() => props.onReveal()}
        >
          <ArrowsClockwiseIcon class="size-3 animate-spin" aria-hidden />
          {props.pending().length}
        </button>
      </div>
    </Show>
  );
};
