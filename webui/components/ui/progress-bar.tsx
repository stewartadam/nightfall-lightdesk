// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Show } from "solid-js";

/** Thin rounded track and fill, styled the same in every engine's native progress bar. */
const PROGRESS_CLASS =
  "h-1.5 w-full appearance-none overflow-hidden rounded-full bg-gray-700 [&::-webkit-progress-bar]:bg-gray-700 [&::-webkit-progress-value]:bg-blue-400 [&::-moz-progress-bar]:bg-blue-400";

/**
 * A slim native progress bar. Without a `max` it shows activity of unknown length, which
 * suits a download whose size is not known yet.
 */
export function ProgressBar(props: {
  /** Accessible name, such as "Update download progress". */
  label: string;
  value?: number;
  max?: number | null;
  class?: string;
  "data-testid"?: string;
}) {
  return (
    <Show
      when={props.max}
      fallback={
        <progress
          class={`${PROGRESS_CLASS} ${props.class ?? ""}`}
          aria-label={props.label}
          data-testid={props["data-testid"]}
        />
      }
    >
      {(max) => (
        <progress
          class={`${PROGRESS_CLASS} ${props.class ?? ""}`}
          aria-label={props.label}
          value={props.value ?? 0}
          max={max()}
          data-testid={props["data-testid"]}
        />
      )}
    </Show>
  );
}
