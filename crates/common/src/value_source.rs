// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Value source types for cue instructions

use nightfall_dmx::prelude::ParameterValue;
use serde::{Deserialize, Serialize};

/// Source of a value for a cue instruction
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum ValueSource {
    /// An inline value
    Inline(ParameterValue),
    /// Fanned values to be interpolated across the selection.
    /// - 2 values = linear fan from start to end
    /// - 3+ values = envelope with interpolated waypoints
    Fanned { values: Vec<ParameterValue> },
    /// Clear the tracked value for this attribute from this cue forward.
    Release,
    /// Keep the tracked position value active and opt it out of lookahead.
    HoldPosition,
}
