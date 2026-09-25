// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use nightfall::prelude::*;
use nightfall_engine::prelude::*;

/// Collect provider values into a stable id-sorted snapshot vector.
pub(super) fn sorted_provider_values<T>(provider: &DataProvider<T>) -> Vec<T>
where
    T: Clone + HasIdentifiers,
{
    let mut values: Vec<_> = provider
        .iter()
        .map(|entry| (*entry.value()).clone())
        .collect();
    values.sort_by_key(|a| a.identifiers().id);
    values
}
