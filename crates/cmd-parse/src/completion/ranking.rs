// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Completion candidate ranking and filtering helpers.

use std::collections::BTreeSet;

use crate::autocomplete::CompletionCandidate;
use crate::lexicon::aliases::canonical_token_has_alias_prefix;

/// Returns whether a candidate should stay visible for the typed prefix, including alias and numeric-range shorthands.
pub fn token_matches_typed_prefix(token: &str, prefix: &str) -> bool {
    if prefix.is_empty() {
        return true;
    }
    let token_lower = token.to_ascii_lowercase();
    if token_lower.starts_with(prefix) {
        return true;
    }
    if canonical_token_has_alias_prefix(&token_lower, prefix) {
        return true;
    }
    token_lower == "0..9"
        && prefix
            .chars()
            .all(|ch| ch.is_ascii_digit() || ch == '+' || ch == '-' || ch == '.')
}

/// Removes duplicate candidates by case-insensitive insert text while preserving the first occurrence.
pub fn dedupe_candidates(candidates: &mut Vec<CompletionCandidate>) {
    let mut seen = BTreeSet::new();
    candidates.retain(|candidate| seen.insert(candidate.insert_text.to_ascii_lowercase()));
}
