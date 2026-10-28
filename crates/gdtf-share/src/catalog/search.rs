// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Word search over the newest revision of each GDTF Share fixture type.

use std::cmp::Reverse;

use serde::Serialize;

use super::{Catalog, GdtfShareFixture};

/// The results of a search.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[typeshare::typeshare]
pub struct GdtfShareSearchResults {
    /// Every matching fixture, best match first.
    pub fixtures: Vec<GdtfShareFixture>,
    /// How many fixtures match, or for a summary, how many the list holds.
    pub total: u32,
    /// When the searched list was fetched from GDTF Share, in Unix seconds.
    pub fetched_at: u32,
}

/// Sort key of a match: score, manufacturer upload and rating (all best first), then
/// name and revision.
type Rank<'a> = (Reverse<u32>, Reverse<bool>, Reverse<u32>, &'a str, &'a str);

/// A fixture with the lowercase text searches match against.
pub(super) struct Indexed {
    fixture: GdtfShareFixture,
    /// Manufacturer and fixture name.
    name: String,
    /// Every mode name.
    modes: String,
    /// Fixture name alone, for exact matches.
    fixture_name: String,
}

impl Indexed {
    /// Prepares `fixture` for searching.
    pub(super) fn new(fixture: GdtfShareFixture) -> Self {
        let name = format!("{} {}", fixture.manufacturer, fixture.fixture).to_lowercase();
        let modes = fixture
            .modes
            .iter()
            .map(|mode| mode.name.to_lowercase())
            .collect::<Vec<_>>()
            .join("\n");
        let fixture_name = fixture.fixture.to_lowercase();
        Self {
            fixture,
            name,
            modes,
            fixture_name,
        }
    }

    /// Scores how well this fixture matches `words`, or `None` when a word matches
    /// neither its names nor its mode names.
    ///
    /// A word that starts a word of the manufacturer or fixture name scores 2, one found
    /// inside them 1, and one found only in a mode name 0. Typing the fixture's whole
    /// name puts it ahead of every partial match.
    fn score(&self, query: &str, words: &[String]) -> Option<u32> {
        let mut score = 0;
        for word in words {
            if starts_word(&self.name, word) {
                score += 2;
            } else if self.name.contains(word.as_str()) {
                score += 1;
            } else if !self.modes.contains(word.as_str()) {
                return None;
            }
        }
        if query == self.fixture_name {
            score += 1000;
        }
        Some(score)
    }

    /// Returns the sort key of a match scoring `score`: best score first, then
    /// manufacturer uploads, then the best rated, then alphabetically. Without `ranked`
    /// (an empty query) only the alphabetical order applies.
    fn rank(&self, score: u32, ranked: bool) -> Rank<'_> {
        if !ranked {
            return (
                Reverse(0),
                Reverse(false),
                Reverse(0),
                &self.name,
                &self.fixture.revision,
            );
        }
        (
            Reverse(score),
            Reverse(self.fixture.manufacturer_upload),
            // Ratings run 0-5 in tenths, so ten times the rating orders them exactly.
            Reverse(
                self.fixture
                    .rating
                    .map_or(0, |rating| (rating * 10.0).round() as u32),
            ),
            &self.name,
            &self.fixture.revision,
        )
    }
}

/// Whether `word` occurs in `text` at the start of one of its words.
fn starts_word(text: &str, word: &str) -> bool {
    text.match_indices(word).any(|(index, _)| {
        text[..index]
            .chars()
            .next_back()
            .is_none_or(|before| !before.is_alphanumeric())
    })
}

impl Catalog {
    /// Returns every fixture matching every word of `query`, best match first.
    ///
    /// Each word must appear in the manufacturer, fixture or a mode name, ignoring case.
    /// An empty query lists every fixture alphabetically.
    pub fn search(&self, query: &str) -> GdtfShareSearchResults {
        let query = query.trim().to_lowercase();
        let words: Vec<String> = query.split_whitespace().map(str::to_string).collect();
        let ranked = !words.is_empty();
        let mut matches: Vec<(Rank<'_>, &Indexed)> = self
            .latest
            .iter()
            .filter_map(|indexed| {
                let score = indexed.score(&query, &words)?;
                Some((indexed.rank(score, ranked), indexed))
            })
            .collect();
        matches.sort_unstable_by_key(|(rank, _)| *rank);
        GdtfShareSearchResults {
            total: u32::try_from(matches.len()).unwrap_or(u32::MAX),
            fixtures: matches
                .into_iter()
                .map(|(_, indexed)| indexed.fixture.clone())
                .collect(),
            fetched_at: u32::try_from(self.fetched_at).unwrap_or(u32::MAX),
        }
    }

    /// Describes the list without searching it: how many fixture types it holds and when
    /// it was fetched, with no fixtures.
    pub fn summary(&self) -> GdtfShareSearchResults {
        GdtfShareSearchResults {
            fixtures: Vec::new(),
            total: u32::try_from(self.latest.len()).unwrap_or(u32::MAX),
            fetched_at: u32::try_from(self.fetched_at).unwrap_or(u32::MAX),
        }
    }
}
