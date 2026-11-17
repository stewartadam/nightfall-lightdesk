// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { matchesSearchTerms, searchTerms } from "./search-match";

/** One value an autocomplete field suggests, with an optional second line explaining it. */
export interface AutocompleteOption {
  value: string;
  description?: string;
}

/**
 * Returns the options matching what was typed: every typed word must appear in the value or
 * its description. Values that start with the typed text come first, and each group keeps the
 * caller's order. Blank text matches every option.
 */
export function filterAutocompleteOptions(
  options: readonly AutocompleteOption[],
  query: string,
): AutocompleteOption[] {
  const terms = searchTerms(query);
  const matches = options.filter((option) =>
    matchesSearchTerms(terms, [option.value, option.description]),
  );
  const lead = query.trim().toLocaleLowerCase();
  if (!lead) return matches;
  /** Whether an option's value begins with the typed text. */
  const leading = (option: AutocompleteOption) =>
    option.value.toLocaleLowerCase().startsWith(lead);
  return [
    ...matches.filter(leading),
    ...matches.filter((option) => !leading(option)),
  ];
}
