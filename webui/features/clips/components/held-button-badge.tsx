// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { type JSX, Show } from "solid-js";
import type { HeldButtonEffect } from "../../../types";
import { heldButtonTag } from "../model/held-button";

/** Props for {@link HeldButtonBadge}. */
export interface HeldButtonBadgeProps {
  /** Backend-resolved held-button effect on the playback, if any. */
  effect: HeldButtonEffect | null | undefined;
}

/**
 * Tags a playback a held Flash or Swop changes, naming the responsible slot in its tooltip.
 * Taken-out playbacks get an amber tag so they stand out; flashed ones a neutral one.
 */
export function HeldButtonBadge(props: HeldButtonBadgeProps): JSX.Element {
  return (
    <Show when={heldButtonTag(props.effect)}>
      {(tag) => (
        <span
          data-testid="held-button-badge"
          data-held-button={props.effect?.type}
          title={tag().title}
          class="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide"
          classList={{
            "bg-amber-500/20 text-amber-300": tag().takenOut,
            "bg-sky-500/20 text-sky-300": !tag().takenOut,
          }}
        >
          {tag().label}
        </span>
      )}
    </Show>
  );
}
