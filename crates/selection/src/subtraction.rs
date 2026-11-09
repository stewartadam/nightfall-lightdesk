// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::collections::HashSet;

use nightfall::prelude::*;
use uuid::Uuid;

/// The right-hand side of a selection subtraction, such as `Group 1 - Fixture 3`.
///
/// A whole-fixture ref removes the fixture and every one of its elements, so subtracting a
/// fixture still works when the left side resolved to element refs, as groups that expand
/// fixtures into their elements do.
pub(crate) struct RemovedFixtures {
    /// Refs removed exactly as written.
    refs: HashSet<FixtureRef>,
    /// Fixtures removed whole, along with all of their elements.
    whole_fixtures: HashSet<Uuid>,
}

impl RemovedFixtures {
    /// Collects the refs a subtraction removes.
    pub(crate) fn new(refs: Vec<FixtureRef>) -> Self {
        let whole_fixtures = refs
            .iter()
            .filter(|fixture_ref| fixture_ref.index.is_none())
            .map(|fixture_ref| fixture_ref.fixture_uid)
            .collect();
        Self {
            refs: refs.into_iter().collect(),
            whole_fixtures,
        }
    }

    /// Returns whether the subtraction removes `fixture_ref`.
    pub(crate) fn removes(&self, fixture_ref: &FixtureRef) -> bool {
        self.refs.contains(fixture_ref) || self.whole_fixtures.contains(&fixture_ref.fixture_uid)
    }
}
