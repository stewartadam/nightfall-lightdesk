// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Runtime lookahead contracts shared by playback domains and integration layers.
#![warn(missing_docs)]

mod assertions;
mod provider;

pub use assertions::{LookaheadAssertion, LookaheadAssertions, LookaheadReason};
pub use provider::{FixtureFootprint, Lookahead, LookaheadProvider, PlaybackFootprint};
