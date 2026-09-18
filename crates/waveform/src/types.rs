// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Waveform type definitions.

use serde::{Deserialize, Serialize};

/// Waveform shape kinds.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[typeshare::typeshare]
pub enum WaveformKind {
    /// Sine wave.
    Sin,
    /// Triangle wave.
    Triangle,
    /// Sawtooth wave.
    Sawtooth,
    /// Square wave.
    Square,
    /// Pulse wave.
    Pulse,
}

/// A single waveform sample result.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[typeshare::typeshare]
pub struct WaveformSample {
    /// Normalized waveform value [0.0, 1.0].
    pub value: f32,
}
