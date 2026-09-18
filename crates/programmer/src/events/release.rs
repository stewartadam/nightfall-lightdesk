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

/// Expands a whole-fixture row into one ref per element when fixture metadata is available.
fn fixture_element_refs_for_release(
    fixture: &FixtureRef,
    fixture_data: &FixtureDataProviderExt,
) -> Option<Vec<FixtureRef>> {
    if fixture.index.is_some() {
        return Some(vec![fixture.clone()]);
    }

    let element_count = fixture_data.element_count(fixture.fixture_uid)?;
    let element_count = element_count.max(1);
    let Ok(element_count) = u32::try_from(element_count) else {
        return None;
    };
    Some(
        (1..=element_count)
            .map(|index| FixtureRef {
                fixture_uid: fixture.fixture_uid,
                index: Some(index),
            })
            .collect(),
    )
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

    let Some(element_refs) = fixture_element_refs_for_release(fixture, fixture_data) else {
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
