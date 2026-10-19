// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createMemo, For, Show } from "solid-js";
import { highlightSegments } from "./highlighted-text-segments";

interface HighlightedTextProps {
  /** Text to render. */
  text: string;
  /** Lower-cased search words whose occurrences are marked; none renders plain text. */
  terms: readonly string[];
}

/**
 * Renders text with every occurrence of the search words wrapped in `<mark>`, tinted with the
 * accent color, so search results show why they matched.
 */
export function HighlightedText(props: HighlightedTextProps) {
  /** Plain and matched runs of the text for the current search words. */
  const segments = createMemo(() => highlightSegments(props.text, props.terms));
  return (
    <For each={segments()}>
      {(segment) => (
        <Show when={segment.match} fallback={segment.text}>
          <mark class="rounded-sm bg-[var(--accent-soft)] text-[var(--accent)]">
            {segment.text}
          </mark>
        </Show>
      )}
    </For>
  );
}
