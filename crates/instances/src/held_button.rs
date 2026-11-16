// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use bevy_ecs::prelude::*;
use serde::{Deserialize, Serialize};

/// How a held fader Flash or Swop button changes one playback.
///
/// Fader controls put it on the playback entity while a button concerns that playback and take
/// it off on release, so rendering and every client view read the same answer and a playback a
/// Swop takes out never looks normal anywhere.
#[derive(Component, Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum HeldButtonEffect {
    /// A Flash held on the fader plays the playback at full intensity.
    Flashed { fader_index: u32 },
    /// A Swop held on the fader plays the playback at full intensity on its own.
    Swopping { fader_index: u32 },
    /// A Swop held on the fader takes the playback out entirely.
    SwoppedOut { fader_index: u32 },
}
