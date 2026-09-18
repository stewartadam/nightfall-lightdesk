// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/// Half-open byte range containing one top-level command statement.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StatementRange {
    /// First byte belonging to the statement.
    pub start: usize,
    /// First byte after the statement.
    pub end: usize,
}

/// Returns every raw top-level statement range, including empty segments.
pub fn statement_ranges(input: &str) -> Vec<StatementRange> {
    let mut ranges = Vec::new();
    let mut statement_start = 0;
    let mut in_quote = false;
    let mut escaped = false;

    for (index, character) in input.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if character == '\\' {
            escaped = true;
            continue;
        }
        if character == '"' {
            in_quote = !in_quote;
            continue;
        }
        if character == ';' && !in_quote {
            ranges.push(StatementRange {
                start: statement_start,
                end: index,
            });
            statement_start = index + character.len_utf8();
        }
    }

    ranges.push(StatementRange {
        start: statement_start,
        end: input.len(),
    });
    ranges
}

/// Returns the raw statement range containing the supplied cursor byte offset.
pub fn statement_range_at(input: &str, cursor: usize) -> StatementRange {
    let cursor = cursor.min(input.len());
    statement_ranges(input)
        .into_iter()
        .find(|range| cursor <= range.end)
        .unwrap_or(StatementRange {
            start: input.len(),
            end: input.len(),
        })
}

/// Splits non-empty top-level statements and trims their surrounding whitespace.
pub fn split_command_statements(input: &str) -> Vec<&str> {
    statement_ranges(input)
        .into_iter()
        .filter_map(|range| {
            let statement = input[range.start..range.end].trim();
            (!statement.is_empty()).then_some(statement)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{StatementRange, split_command_statements, statement_range_at, statement_ranges};

    /// Verifies quoted semicolons remain part of one command statement.
    #[test]
    fn split_preserves_quoted_semicolons() {
        assert_eq!(
            split_command_statements("fix 1 \"custom;attr\" @ 10; sleep 20ms; store cue 1.1"),
            vec!["fix 1 \"custom;attr\" @ 10", "sleep 20ms", "store cue 1.1"]
        );
    }

    /// Verifies an escaped semicolon is not treated as a statement delimiter.
    #[test]
    fn split_preserves_escaped_semicolons() {
        assert_eq!(
            split_command_statements("debug value foo\\;bar; clear"),
            vec!["debug value foo\\;bar", "clear"]
        );
    }

    /// Verifies empty segments remain available for cursor analysis but not submission.
    #[test]
    fn raw_ranges_include_empty_segments() {
        assert_eq!(
            statement_ranges("; clear ;"),
            vec![
                StatementRange { start: 0, end: 0 },
                StatementRange { start: 1, end: 8 },
                StatementRange { start: 9, end: 9 },
            ]
        );
        assert_eq!(split_command_statements("; clear ;"), vec!["clear"]);
    }

    /// Verifies autocomplete selects the statement containing the cursor.
    #[test]
    fn cursor_range_uses_top_level_boundaries() {
        assert_eq!(
            statement_range_at("clear; fix 1 \"red;blue\" @ 10", 12),
            StatementRange { start: 6, end: 28 }
        );
    }
}
