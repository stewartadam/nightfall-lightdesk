// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Word search over the newest revision of each GDTF Share fixture type.

use std::cmp::Reverse;

use nightfall_fixture_model::prelude::fixture_name_key;
use serde::{Deserialize, Serialize};

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
    /// Manufacturer and fixture name folded by [`fixture_name_key`], for lookups by name.
    name_key: (String, String),
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
        let name_key = (
            fixture_name_key(&fixture.manufacturer),
            fixture_name_key(&fixture.fixture),
        );
        Self {
            fixture,
            name,
            modes,
            fixture_name,
            name_key,
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

/// A fixture type named by manufacturer and fixture name, as a rig file names one it
/// leaves out.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct GdtfShareFixtureName {
    /// Manufacturer name.
    pub manufacturer: String,
    /// Fixture name.
    pub fixture: String,
}

/// The fixtures to look up on GDTF Share by name.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct GdtfShareMatchRequest {
    /// Names to look up.
    pub fixtures: Vec<GdtfShareFixtureName>,
}

/// What GDTF Share lists under one looked-up name.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct GdtfShareMatch {
    /// The newest revision listed under the name, or none when GDTF Share lists none or no
    /// list is saved.
    pub fixture: Option<GdtfShareFixture>,
}

/// The GDTF Share fixture for each looked-up name.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct GdtfShareMatches {
    /// One answer per looked-up name, in request order.
    pub matches: Vec<GdtfShareMatch>,
}

impl Catalog {
    /// Finds the fixture type GDTF Share lists as `manufacturer` `fixture`, ignoring case,
    /// spacing and punctuation, and returns its newest revision. When several fixture types
    /// share the names, a manufacturer upload wins, then the best rated, then the most
    /// recently changed.
    pub fn find(&self, manufacturer: &str, fixture: &str) -> Option<&GdtfShareFixture> {
        let key = (fixture_name_key(manufacturer), fixture_name_key(fixture));
        if key.0.is_empty() || key.1.is_empty() {
            return None;
        }
        self.latest
            .iter()
            .filter(|indexed| indexed.name_key == key)
            .max_by_key(|indexed| {
                let fixture = &indexed.fixture;
                (
                    fixture.manufacturer_upload,
                    fixture
                        .rating
                        .map_or(0, |rating| (rating * 10.0).round() as u32),
                    fixture.last_modified,
                    fixture.rid,
                )
            })
            .map(|indexed| &indexed.fixture)
    }
}
