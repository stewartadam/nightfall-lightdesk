// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! WebSocket commands for fixture library operations.
//!
//! The contract is owned by `nightfall_fixtures::library::commands` so runtimes without
//! the file-backed library can serve built-in profiles through the same commands.

pub use nightfall_fixtures::library::commands::{
    AvailableFixtureInfo, FixtureLibraryCommand, FixtureLibraryEntry, GetFixtureProfileResponse,
    ListAvailableFixturesResponse,
};
