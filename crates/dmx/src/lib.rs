// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! This crate provides cues and sequences
#![warn(missing_docs)]

use serde::{Deserialize, Serialize};

mod attributes;
mod parameter_value;
mod percentage;
mod percentage_serde;
pub mod wire;

pub use percentage::Percentage;
pub use percentage_serde::PercentageAsF64;

/// Maximum number of channels per universe. This is conventionally *always* the
/// number of channels per universe at 44hz, but the specification technically
/// does permit for smaller universes with higher refresh rates.
pub const MAX_CHANNELS_PER_UNIVERSE: usize = 512;

/// Prelude for ergonomic imports
pub mod prelude {
    pub use crate::MAX_CHANNELS_PER_UNIVERSE;
    pub use crate::attributes::{
        Attribute, AttributeCategory, AttributeMetadata, ParameterUnit, ParameterValuePolarity,
        standard_attribute_metadata,
    };
    pub use crate::parameter_value::ParameterValue;
    pub use crate::{ChannelDmxValue, DmxValueResolution, ParameterDmxValue, Percentage};
}

/// A hardware DMX channel value (0-255).
#[typeshare::typeshare]
pub type ChannelDmxValue = u8;
/// A logical DMX channel value for a parameter, that may be clamped or split into multiple hardware channels on output.
/// Double precision retains every 32-bit raw integer before physical or percentage conversion.
#[typeshare::typeshare]
pub type ParameterDmxValue = f64;

/// Parameter resolution defines how many adjacent DMX channels should be
/// used to specify this parameter's value, permitting for more precision
/// when needed.
///
/// Names are derived from GDTF: https://gdtf-share.com/help/en/help/gdtf_builder/key_dmx.html
#[derive(Debug, Default, Clone, Copy, PartialEq, PartialOrd, Serialize, Deserialize)]
#[typeshare::typeshare]
pub enum DmxValueResolution {
    #[default]
    /// Occupies a single DMX channel (values 0-255)
    Coarse = 8,
    /// Occupies two adjacent DMX channels (values 0-65,535)
    Fine = 16,
    /// Occupies three adjacent DMX channels (values 0-16,777,215)
    UltraFine = 24,
    /// Occupies four adjacent DMX channels (values 0-4,294,967,295)
    Uber = 32,
}

impl DmxValueResolution {
    /// Returns the number of DMX channels this resolution occupies.
    pub fn channel_width(&self) -> u16 {
        (*self as u16) / 8
    }
}
