// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Patched fixtures as a source of fixtures for pure selection resolution.

use nightfall::prelude::FixtureRef;
use nightfall_selection::{SelectionDataSource, SelectionFixture};

use crate::prelude::FixtureDataProviderExt;

/// Converts fixture storage records into the narrow selection read model.
fn selection_fixture_from_parts(fixture_uid: uuid::Uuid, element_count: usize) -> SelectionFixture {
    SelectionFixture {
        fixture_ref: FixtureRef {
            fixture_uid,
            index: None,
        },
        element_count: element_count as u32,
    }
}

impl SelectionDataSource for FixtureDataProviderExt {
    fn fixture_by_id(&self, fixture_id: u32) -> Option<SelectionFixture> {
        self.inner.from_id(fixture_id).ok().map(|fixture| {
            selection_fixture_from_parts(fixture.identifiers.uid, fixture.elements.len())
        })
    }

    fn fixture_by_ref(&self, fixture_ref: &FixtureRef) -> Option<SelectionFixture> {
        self.inner.get(fixture_ref.fixture_uid).ok().map(|fixture| {
            selection_fixture_from_parts(fixture.identifiers.uid, fixture.elements.len())
        })
    }
}
