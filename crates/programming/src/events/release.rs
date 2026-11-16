// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Fixture and element partitioning for programmer release operations.

use super::*;

/// Returns whether a concrete fixture or element ref is covered by one release filter ref.
fn concrete_fixture_ref_matches_filter(fixture: &FixtureRef, filter: &FixtureRef) -> bool {
    fixture.fixture_uid == filter.fixture_uid
        && (filter.index.is_none() || fixture.index == filter.index)
}

/// Splits one resolved instruction target into release-matched and preserved fixture refs.
pub(super) fn partition_fixture_ref_for_release(
    fixture: &FixtureRef,
    filters: &[FixtureRef],
    fixture_data: &FixtureDataProviderExt,
) -> (Vec<FixtureRef>, Vec<FixtureRef>) {
    if filters
        .iter()
        .any(|filter| concrete_fixture_ref_matches_filter(fixture, filter))
    {
        return (vec![fixture.clone()], Vec::new());
    }

    if fixture.index.is_some()
        || !filters
            .iter()
            .any(|filter| filter.fixture_uid == fixture.fixture_uid && filter.index.is_some())
    {
        return (Vec::new(), vec![fixture.clone()]);
    }

    let Some(element_refs) = fixture_data.element_refs(fixture) else {
        return (Vec::new(), vec![fixture.clone()]);
    };

    let mut matched = Vec::new();
    let mut unmatched = Vec::new();
    for element_ref in element_refs {
        if filters
            .iter()
            .any(|filter| concrete_fixture_ref_matches_filter(&element_ref, filter))
        {
            matched.push(element_ref);
        } else {
            unmatched.push(element_ref);
        }
    }

    (matched, unmatched)
}
