// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Lightweight percentage values used by runtime DMX math.

use std::fmt::{Debug, Display};
use std::ops::{Add, Sub};

use serde::{Deserialize, Serialize};

/// A normalized percentage-like value backed by `f64` to retain 32-bit DMX precision.
///
/// Values are not implicitly clamped because some runtime paths use signed
/// percentages or offsets. Callers that require a bounded interval should use
/// [`Percentage::clamp`].
#[derive(Clone, Copy, Default, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Percentage(f64);

impl Percentage {
    /// Narrow to single precision for waveform phase and other approximate calculations.
    pub fn as_f32(self) -> f32 {
        self.0 as f32
    }

    /// Return the stored precision for logical parameter arithmetic and serialization.
    pub fn as_f64(self) -> f64 {
        self.0
    }

    /// Returns this percentage clamped to the inclusive range `[min, max]`.
    pub fn clamp(self, min: Self, max: Self) -> Self {
        Self(self.0.clamp(min.0, max.0))
    }
}

impl From<f32> for Percentage {
    fn from(value: f32) -> Self {
        Self(f64::from(value))
    }
}

impl From<f64> for Percentage {
    fn from(value: f64) -> Self {
        Self(value)
    }
}

impl From<Percentage> for f32 {
    fn from(value: Percentage) -> Self {
        value.as_f32()
    }
}

impl From<Percentage> for f64 {
    fn from(value: Percentage) -> Self {
        value.as_f64()
    }
}

impl Add for Percentage {
    type Output = Self;

    fn add(self, rhs: Self) -> Self::Output {
        Self(self.0 + rhs.0)
    }
}

impl Sub for Percentage {
    type Output = Self;

    fn sub(self, rhs: Self) -> Self::Output {
        Self(self.0 - rhs.0)
    }
}

impl Debug for Percentage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        Debug::fmt(&self.0, f)
    }
}

impl Display for Percentage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let percentage = self.0 * 100.0;
        let display_value = if (percentage - percentage.round()).abs() < 0.000_01 {
            percentage.round()
        } else {
            percentage
        };
        let mut formatted = format!("{display_value:.6}");
        while formatted.contains('.') && formatted.ends_with('0') {
            formatted.pop();
        }
        if formatted.ends_with('.') {
            formatted.pop();
        }
        write!(f, "{formatted}%")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verifies that display formatting preserves percentage-point output for absolute values.
    #[test]
    fn display_formats_absolute_percentage_points() {
        assert_eq!(Percentage::from(1.0).to_string(), "100%");
        assert_eq!(Percentage::from(0.5).to_string(), "50%");
    }

    /// Verifies that display formatting preserves signed percentage-point output for offsets.
    #[test]
    fn display_formats_signed_percentage_points() {
        assert_eq!(Percentage::from(-0.15).to_string(), "-15%");
        assert_eq!(Percentage::from(0.333).to_string(), "33.3%");
    }
}
