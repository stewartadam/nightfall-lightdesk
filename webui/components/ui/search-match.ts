// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/** Splits a typed query into lowercased words, so "dmx rate" matches "DMX output rate". */
export function searchTerms(query: string): string[] {
  return query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
}

/** Returns the query words that appear nowhere in the given texts, ignoring case. */
export function unmatchedSearchTerms(
  terms: readonly string[],
  texts: readonly (string | undefined)[],
): string[] {
  if (terms.length === 0) return [];
  const haystack = texts.filter(Boolean).join(" ").toLocaleLowerCase();
  return terms.filter((term) => !haystack.includes(term));
}

/** Whether every query word appears somewhere in the given texts; no words match everything. */
export function matchesSearchTerms(
  terms: readonly string[],
  texts: readonly (string | undefined)[],
): boolean {
  return unmatchedSearchTerms(terms, texts).length === 0;
}

/**
 * Reads the text a rendered JSX value shows, so rich content can be searched like a plain
 * string. Elements contribute their text content at the time of the call.
 */
export function renderedText(value: unknown): string {
  if (value === null || value === undefined || typeof value === "boolean") {
    return "";
  }
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  if (Array.isArray(value)) return value.map(renderedText).join(" ");
  if (typeof Node !== "undefined" && value instanceof Node) {
    return value.textContent ?? "";
  }
  return "";
}
