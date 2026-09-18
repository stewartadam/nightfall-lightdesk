// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Shared waveform sampling algorithms for flow and FX systems.
//!
//! This crate provides waveform shape sampling functions compatible with both
//! the flow graph system and FX system.
//!
//! # Examples
//!
//! Sample a sine wave at a normalized phase:
//!
//! ```
//! use nightfall_waveform::prelude::*;
//!
//! let value = sample_waveform_normalized(WaveformKind::Sin, 0.25, 1.0);
//! assert!((value - 1.0).abs() < 0.01); // Peak at 0.25
//! ```
//!
//! Sample at phase in radians:
//!
//! ```
//! use nightfall_waveform::prelude::*;
//! use std::f32::consts::PI;
//!
//! let value = sample_waveform_radians(WaveformKind::Sin, PI / 2.0, 1.0);
//! assert!((value - 1.0).abs() < 0.01); // Peak at π/2
//! ```
//!
//! Generate samples for SVG visualization:
//!
//! ```
//! use nightfall_waveform::prelude::*;
//!
//! let samples = generate_waveform_samples(WaveformKind::Triangle, 0.0, 1.0, 100);
//! assert_eq!(samples.len(), 101); // 0 to 100 inclusive
//! ```

pub mod sampling;
pub mod types;

pub mod prelude {
    pub use crate::sampling::*;
    pub use crate::types::*;
}
