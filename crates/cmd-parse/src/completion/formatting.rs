// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Completion formatting helpers.

use crate::statement_range_at;

const TIGHT_JOIN_TOKENS: &[&str] = &[":", ".", ">", "~", "+", "-", "(", ")"];
const PATCH_TRANSPORT_ENDPOINT_TOKENS: &[&str] = &["console", "sacn", "artnet", "udmx"];

/// Returns whether a token should be inserted without surrounding spaces.
pub fn is_tight_join_token(token: &str) -> bool {
    TIGHT_JOIN_TOKENS.contains(&token)
}

/// Formats the text inserted for a completion candidate, preserving spacing rules for operators, numeric suffixes, and patch endpoints.
pub fn apply_text_for_candidate(
    input: &str,
    replace_start: usize,
    replace_end: usize,
    token: &str,
) -> String {
    let replace_start = replace_start.min(input.len());
    let replace_end = replace_end.min(input.len());
    let prefix = &input[..replace_start];
    let suffix = &input[replace_end..];
    let segment_start = statement_range_at(input, replace_start).start;
    let segment = prefix[segment_start..].trim_start();
    let patch_context = is_patch_context(segment);
    let token_lower = token.to_ascii_lowercase();
    let previous_char = prefix.chars().last().unwrap_or(' ');
    let previous_char_is_whitespace = previous_char.is_ascii_whitespace();
    let previous_char_is_at = previous_char == '@';
    let should_tight_join_numeric_suffix = previous_char.is_ascii_digit()
        && crate::parser::parse_specs::duration_unit_texts().contains(&token_lower.as_str());

    let should_prepend_space = !(previous_char_is_whitespace
        || is_tight_join_token(token)
        || should_tight_join_numeric_suffix
        || patch_context && token == "@"
        || patch_context && previous_char_is_at);

    let should_append_space = !(is_tight_join_token(token)
        || patch_context && token == "@"
        || patch_context && PATCH_TRANSPORT_ENDPOINT_TOKENS.contains(&token_lower.as_str()))
        && (suffix.is_empty()
            || suffix
                .chars()
                .next()
                .is_some_and(|value| value.is_ascii_whitespace()));

    format!(
        "{}{}{}",
        if should_prepend_space { " " } else { "" },
        token,
        if should_append_space { " " } else { "" }
    )
}

/// Returns the text range to replace for the token under the cursor, while preserving set-subtraction operators as insertion points.
pub fn token_replace_bounds(
    input: &str,
    cursor: usize,
    segment_start: usize,
    segment_end: usize,
) -> (usize, usize) {
    if cursor > segment_start
        && input.as_bytes().get(cursor - 1) == Some(&b'-')
        && looks_like_set_remove_operator(input, cursor - 1, segment_start, segment_end)
    {
        return (cursor, cursor);
    }

    if cursor < input.len() && !is_word_char(input.as_bytes()[cursor]) {
        return (cursor, cursor);
    }

    let mut start = cursor;
    while start > segment_start && is_word_char(input.as_bytes()[start - 1]) {
        start -= 1;
    }

    let mut end = cursor;
    while end < segment_end && is_word_char(input.as_bytes()[end]) {
        end += 1;
    }

    (start, end)
}

/// Returns whether a byte belongs to a replaceable word token.
fn is_word_char(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')
}

/// Returns whether a `-` at the cursor is acting as a set-removal operator rather than part of a token.
fn looks_like_set_remove_operator(
    input: &str,
    op_index: usize,
    segment_start: usize,
    segment_end: usize,
) -> bool {
    let bytes = input.as_bytes();

    let mut left = op_index;
    while left > segment_start {
        left -= 1;
        let ch = bytes[left];
        if ch.is_ascii_whitespace() {
            continue;
        }
        if !matches!(ch, b'0'..=b'9' | b')') {
            return false;
        }
        break;
    }

    let mut right = op_index.saturating_add(1);
    while right < segment_end {
        let ch = bytes[right];
        if ch.is_ascii_whitespace() {
            right += 1;
            continue;
        }
        return matches!(ch, b'0'..=b'9' | b'(');
    }

    true
}

/// Returns whether the current segment prefix is inside a `patch` or `rm patch` command.
fn is_patch_context(prefix: &str) -> bool {
    let words = prefix
        .split_whitespace()
        .map(|word| word.to_ascii_lowercase())
        .collect::<Vec<_>>();
    let head = words.first().map(String::as_str);
    let second = words.get(1).map(String::as_str);

    head == Some("patch") || (head == Some("rm") && matches!(second, Some("patch") | Some("p")))
}

#[cfg(test)]
mod tests {
    use super::{apply_text_for_candidate, is_tight_join_token, token_replace_bounds};

    #[test]
    fn computes_word_replace_bounds_for_partial_token() {
        let input = "delete fi";
        let (start, end) = token_replace_bounds(input, input.len(), 0, input.len());
        assert_eq!((start, end), (7, 9));
    }

    #[test]
    fn keeps_cursor_range_for_set_remove_operator() {
        let input = "fix 133>32-";
        let (start, end) = token_replace_bounds(input, input.len(), 0, input.len());
        assert_eq!((start, end), (input.len(), input.len()));
    }

    #[test]
    fn formats_standard_token_with_trailing_space() {
        let input = "fx 1 ";
        let applied = apply_text_for_candidate(input, input.len(), input.len(), "start");
        assert_eq!(applied, "start ");
    }

    #[test]
    fn formats_numeric_suffix_unit_without_leading_space() {
        let input = "store fx 1 step group 14 5";
        let applied = apply_text_for_candidate(input, input.len(), input.len(), "s");
        assert_eq!(applied, "s ");
    }

    #[test]
    fn keeps_tight_join_tokens_unspaced() {
        let input = "fix 1";
        let applied = apply_text_for_candidate(input, input.len(), input.len(), ">");
        assert_eq!(applied, ">");
        assert!(is_tight_join_token(">"));
    }

    #[test]
    fn preserves_patch_endpoint_spacing_rules() {
        let input = "patch sacn:1 @ ";
        let applied = apply_text_for_candidate(input, input.len(), input.len(), "console");
        assert_eq!(applied, "console");
    }
}
