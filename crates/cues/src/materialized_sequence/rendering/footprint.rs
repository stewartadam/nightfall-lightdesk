// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Static fixture-footprint calculation for materialized sequence playback.

use std::collections::HashSet;

use nightfall_lookahead::{FixtureFootprint, PlaybackFootprint};
use uuid::Uuid;

use super::super::*;
use super::lookahead::parameter_instance;

impl PlaybackFootprint for MaterializedSequence {
    /// Returns the fixtures whose parameters may be asserted by this sequence.
    fn playback_footprint(
        &self,
        fixture_data_provider: &FixtureDataProviderExt,
    ) -> FixtureFootprint {
        FixtureFootprint::Known(
            self.mcues
                .iter()
                .flat_map(|mcue| layer_asserted_fixture_uids(&mcue.values, fixture_data_provider))
                .collect(),
        )
    }
}

/// Collects fixture UIDs for parameters asserted by a materialized layer.
fn layer_asserted_fixture_uids(
    layer: &Layer,
    fixture_data_provider: &FixtureDataProviderExt,
) -> HashSet<Uuid> {
    layer
        .absolute
        .keys()
        .chain(layer.relative.keys())
        .filter_map(|parameter| {
            fixture_data_provider
                .try_fixture_ref_for_parameter(&parameter_instance(parameter))
                .map(|fixture_ref| fixture_ref.fixture_uid)
        })
        .collect()
}
