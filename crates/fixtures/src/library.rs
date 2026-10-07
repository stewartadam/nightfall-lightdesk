// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Registry facade for explicit built-in fixture profiles.
//!
//! These profiles support sample data and direct fixture creation for a small set
//! of exact make/model identifiers. User-imported GDTF and OFL definitions are
//! scanned and converted by the separate `nightfall-fixture-library` crate; this
//! module intentionally does not duplicate that general profile system.
//!
//! Submodules define the fixture-library command contract (`commands`), the
//! built-in profile catalog (`catalog`), and fixture instantiation with parameter
//! spawning (`instantiate`), shared by every runtime that serves fixture profiles,
//! including the embedded browser demo, which has no file-backed library.

pub mod catalog;
pub mod commands;
pub mod instantiate;
mod moving_heads;
mod pixel_bars;
mod strobes;

#[cfg(test)]
mod tests;

use crate::prelude::Fixture;

/// Updates known built-in fixture profiles that may have been persisted before profile fixes.
pub fn normalize_fixture_profile(fixture: &mut Fixture) {
    moving_heads::normalize_fixture_profile(fixture);
}

/// Creates an explicit built-in fixture for an exact make/model identifier.
///
/// The mode is accepted to match the fixture creation command contract but is
/// currently ignored by built-in profiles. Returns `None` for identifiers owned
/// by imported fixture-library sources or otherwise unknown to this registry.
pub fn create_fixture_from_library(
    id: u32,
    make: &str,
    model: &str,
    _mode: &str,
) -> Option<Fixture> {
    catalog::find_builtin_fixture_profile(make, model).map(|profile| profile.build_fixture(id))
}
