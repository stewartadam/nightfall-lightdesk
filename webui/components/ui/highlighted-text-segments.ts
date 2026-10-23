// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/** A run of text and whether it falls inside a search match. */
export interface HighlightSegment {
  text: string;
  match: boolean;
}

/**
 * Splits text into alternating plain and matched runs for every case-insensitive occurrence of
 * any search term. Overlapping or adjacent occurrences merge into one matched run, so "lay" and
 * "layout" in the same query mark "layout" once.
 */
export function highlightSegments(
  text: string,
  terms: readonly string[],
): HighlightSegment[] {
  const lower = text.toLocaleLowerCase();
  // Lower-casing a few characters (such as "İ") changes the length, so positions would not line up.
  if (lower.length !== text.length) return [{ text, match: false }];
  const marked = new Array<boolean>(text.length).fill(false);
  for (const term of terms) {
    const needle = term.toLocaleLowerCase();
    if (!needle) continue;
    for (
      let index = lower.indexOf(needle);
      index !== -1;
      index = lower.indexOf(needle, index + 1)
    ) {
      marked.fill(true, index, index + needle.length);
    }
  }

  const segments: HighlightSegment[] = [];
  for (let index = 0; index < text.length; index++) {
    const last = segments[segments.length - 1];
    if (last && last.match === marked[index]) {
      last.text += text[index];
    } else {
      segments.push({ text: text[index], match: marked[index] });
    }
  }
  return segments;
}
