// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { RepeatIcon } from "@squidlab/phosphor-solid/repeat";

/** Renders the compact visual tag used for sequences that wrap after their final cue. */
export default function SequenceWrapTag() {
  return (
    <span
      aria-label="Wrap sequence"
      class="inline-flex size-5 shrink-0 items-center justify-center rounded bg-sky-500/15 text-sky-200"
      data-sequence-tag="wrap"
      role="img"
      title="Wrap sequence"
    >
      <RepeatIcon class="size-3" aria-hidden />
    </span>
  );
}
