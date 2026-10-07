// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! WebSocket commands for fixture library operations.
//!
//! Re-exports the shared command and response types defined by
//! `nightfall_fixtures::library::commands`, which every runtime serving fixture
//! profiles uses.

pub use nightfall_fixtures::library::commands::{
    AvailableFixtureInfo, FixtureLibraryCommand, FixtureLibraryEntry, GetFixtureProfileResponse,
    ListAvailableFixturesResponse,
};
