// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::collections::HashSet;

use bevy_ecs::prelude::*;
use moonshine_kind::prelude::InstanceMut;
use nightfall_compositor::prelude::Layer;
use nightfall_fixtures::prelude::{FixtureDataProviderExt, Parameter};
use nightfall_instances::InstanceOptions;
use uuid::Uuid;

use crate::LookaheadAssertions;

/// Fixture-level playback footprint for lookahead safety checks.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FixtureFootprint {
    /// The source footprint is known exactly enough for Lookahead blocking.
    Known(HashSet<Uuid>),
    /// The source may assert fixtures that cannot be known safely.
    Unknown,
}

impl FixtureFootprint {
    /// Returns a known footprint with no affected fixtures.
    pub fn empty() -> Self {
        Self::Known(HashSet::new())
    }

    /// Returns true when this known footprint has no fixtures.
    pub fn is_empty(&self) -> bool {
        matches!(self, Self::Known(fixtures) if fixtures.is_empty())
    }

    /// Returns true when this footprint must block a candidate fixture set.
    pub fn blocks(&self, candidate_fixtures: &HashSet<Uuid>) -> bool {
        match self {
            Self::Known(fixtures) => !candidate_fixtures.is_disjoint(fixtures),
            Self::Unknown => true,
        }
    }
}

/// Values that can produce lookahead assertions before normal activation.
pub trait Lookahead {
    /// Builds lookahead assertions for this value.
    fn lookahead_assertions(
        &self,
        rendered_layer: Option<&Layer>,
        fixture_data_provider: &FixtureDataProviderExt,
        parameter_query: &Query<InstanceMut<Parameter>>,
        instance_options: InstanceOptions,
    ) -> LookaheadAssertions;
}

/// Values that can describe the fixtures they may assert.
pub trait PlaybackFootprint {
    /// Returns the fixture-level playback footprint for Lookahead blocking.
    fn playback_footprint(
        &self,
        fixture_data_provider: &FixtureDataProviderExt,
    ) -> FixtureFootprint;
}

/// Values that can both produce lookahead assertions and describe their fixture footprint.
pub trait LookaheadProvider: Lookahead + PlaybackFootprint {}

impl<T> LookaheadProvider for T where T: Lookahead + PlaybackFootprint {}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verifies a known footprint blocks only overlapping candidate fixtures.
    #[test]
    fn known_footprint_blocks_overlapping_fixtures() {
        let fixture = Uuid::from_u128(1);
        let footprint = FixtureFootprint::Known(HashSet::from([fixture]));

        assert!(footprint.blocks(&HashSet::from([fixture])));
        assert!(!footprint.blocks(&HashSet::from([Uuid::from_u128(2)])));
    }

    /// Verifies unknown footprints conservatively block every candidate set.
    #[test]
    fn unknown_footprint_blocks_all_candidates() {
        let footprint = FixtureFootprint::Unknown;

        assert!(footprint.blocks(&HashSet::new()));
        assert!(footprint.blocks(&HashSet::from([Uuid::from_u128(1)])));
    }

    /// Verifies the empty constructor produces a known empty footprint.
    #[test]
    fn empty_footprint_is_known_and_empty() {
        let footprint = FixtureFootprint::empty();

        assert!(footprint.is_empty());
        assert_eq!(footprint, FixtureFootprint::Known(HashSet::new()));
    }
}
