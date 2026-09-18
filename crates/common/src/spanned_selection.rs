// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Spanned selection types for preserving selection-set grouping information.

use crate::data::FixtureRef;

/// A selection that preserves span/grouping information.
///
/// Spans represent logical selection-set groupings. Effects like fanned
/// fades and FX phase distribution operate at the span level rather than individual fixtures.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SpannedSelection {
    /// All fixtures stored contiguously.
    fixtures: Vec<FixtureRef>,
    /// Indices where each span ends (exclusive).
    span_boundaries: Vec<usize>,
}

impl SpannedSelection {
    /// Creates a `SpannedSelection` from pre-computed spans.
    ///
    /// Each inner `Vec<FixtureRef>` becomes one span. Empty spans are ignored.
    pub fn from_spans(spans: Vec<Vec<FixtureRef>>) -> Self {
        let mut fixtures = Vec::new();
        let mut span_boundaries = Vec::new();

        for span in spans {
            if span.is_empty() {
                continue;
            }
            fixtures.extend(span);
            span_boundaries.push(fixtures.len());
        }

        // Ensure at least one span boundary if fixtures exist but no spans were added
        if !fixtures.is_empty() && span_boundaries.is_empty() {
            span_boundaries.push(fixtures.len());
        }

        Self {
            fixtures,
            span_boundaries,
        }
    }

    /// Creates a `SpannedSelection` from a flat list of fixtures (single implicit span).
    pub fn from_flat(fixtures: Vec<FixtureRef>) -> Self {
        if fixtures.is_empty() {
            return Self::default();
        }

        let len = fixtures.len();
        Self {
            fixtures,
            span_boundaries: vec![len],
        }
    }

    /// Returns the number of spans (minimum 1 if non-empty, 0 if empty).
    pub fn span_count(&self) -> usize {
        self.span_boundaries.len()
    }

    /// Returns an iterator yielding `&[FixtureRef]` slices for each span.
    pub fn spans(&self) -> SpanIter<'_> {
        SpanIter {
            fixtures: &self.fixtures,
            boundaries: &self.span_boundaries,
            current_start: 0,
            current_index: 0,
        }
    }

    /// Returns all fixtures as a flat `Vec<FixtureRef>` for backward compatibility.
    pub fn flatten(&self) -> Vec<FixtureRef> {
        self.fixtures.clone()
    }

    /// Returns the total number of fixtures across all spans.
    pub fn fixture_count(&self) -> usize {
        self.fixtures.len()
    }

    /// Returns true if there are no fixtures in this selection.
    pub fn is_empty(&self) -> bool {
        self.fixtures.is_empty()
    }
}

/// Iterator over spans in a `SpannedSelection`.
pub struct SpanIter<'a> {
    fixtures: &'a [FixtureRef],
    boundaries: &'a [usize],
    current_start: usize,
    current_index: usize,
}

impl<'a> Iterator for SpanIter<'a> {
    type Item = &'a [FixtureRef];

    fn next(&mut self) -> Option<Self::Item> {
        if self.current_index >= self.boundaries.len() {
            return None;
        }

        let end = self.boundaries[self.current_index];
        let span = &self.fixtures[self.current_start..end];
        self.current_start = end;
        self.current_index += 1;
        Some(span)
    }

    fn size_hint(&self) -> (usize, Option<usize>) {
        let remaining = self.boundaries.len() - self.current_index;
        (remaining, Some(remaining))
    }
}

impl ExactSizeIterator for SpanIter<'_> {}

#[cfg(test)]
mod tests {
    use uuid::Uuid;

    use super::*;

    fn fixture_ref(id: u128) -> FixtureRef {
        FixtureRef {
            fixture_uid: Uuid::from_u128(id),
            index: None,
        }
    }

    #[test]
    fn from_flat_single_span() {
        let fixtures = vec![fixture_ref(1), fixture_ref(2), fixture_ref(3)];
        let selection = SpannedSelection::from_flat(fixtures.clone());

        assert_eq!(selection.span_count(), 1);
        assert_eq!(selection.fixture_count(), 3);

        let spans: Vec<_> = selection.spans().collect();
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0], &fixtures[..]);
    }

    #[test]
    fn from_spans_multiple() {
        let span1 = vec![fixture_ref(1), fixture_ref(2)];
        let span2 = vec![fixture_ref(3), fixture_ref(4)];
        let selection = SpannedSelection::from_spans(vec![span1.clone(), span2.clone()]);

        assert_eq!(selection.span_count(), 2);
        assert_eq!(selection.fixture_count(), 4);

        let spans: Vec<_> = selection.spans().collect();
        assert_eq!(spans.len(), 2);
        assert_eq!(spans[0], &span1[..]);
        assert_eq!(spans[1], &span2[..]);
    }

    #[test]
    fn empty_selection() {
        let selection = SpannedSelection::default();
        assert_eq!(selection.span_count(), 0);
        assert_eq!(selection.fixture_count(), 0);
        assert!(selection.is_empty());
        assert_eq!(selection.spans().count(), 0);
    }

    #[test]
    fn flatten_returns_all_fixtures() {
        let span1 = vec![fixture_ref(1), fixture_ref(2)];
        let span2 = vec![fixture_ref(3)];
        let selection = SpannedSelection::from_spans(vec![span1, span2]);

        let flattened = selection.flatten();
        assert_eq!(flattened.len(), 3);
        assert_eq!(flattened[0], fixture_ref(1));
        assert_eq!(flattened[1], fixture_ref(2));
        assert_eq!(flattened[2], fixture_ref(3));
    }
}
