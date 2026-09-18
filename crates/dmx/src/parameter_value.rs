// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Parameter value types for DMX control

use std::fmt::Display;

use serde::{Deserialize, Serialize};
use serde_with::serde_as;

use crate::attributes::ParameterValuePolarity;
use crate::percentage_serde::PercentageAsF64;
use crate::{ParameterDmxValue, Percentage};

/// A value to be applied to a parameter
#[allow(missing_docs)]
#[serde_as]
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum ParameterValue {
    /// Absolute value, raw DMX to be applied to the parameter
    Absolute { value: ParameterDmxValue },
    /// Absolute value, a percentage of the parameter's valid value range
    AbsolutePercent {
        #[serde_as(as = "PercentageAsF64")]
        value: Percentage,
    },
    /// Relative value, an offset from the parameter's current raw DMX value
    Relative { offset: ParameterDmxValue },
    /// Relative value, a percentage of the parameter's valid value range
    RelativePercent {
        #[serde_as(as = "PercentageAsF64")]
        offset: Percentage,
    },
}

impl ParameterValue {
    /// Checks if the value is relative
    pub fn is_relative(&self) -> bool {
        matches!(
            self,
            ParameterValue::Relative { .. } | ParameterValue::RelativePercent { .. }
        )
    }

    /// Resolves this value to a raw DMX offset amount given the parameter's
    /// min/max range. Percentage variants are converted to a fraction of the range.
    pub fn resolve_as_dmx_offset(
        &self,
        min: ParameterDmxValue,
        max: ParameterDmxValue,
    ) -> ParameterDmxValue {
        let range = max - min;
        match self {
            ParameterValue::Absolute { value } | ParameterValue::Relative { offset: value } => {
                *value
            }
            ParameterValue::AbsolutePercent { value }
            | ParameterValue::RelativePercent { offset: value } => value.as_f32() * range,
        }
    }

    /// Return the value mirrored around the parameter's logical center.
    pub fn inverted(
        &self,
        min: ParameterDmxValue,
        max: ParameterDmxValue,
        value_polarity: ParameterValuePolarity,
    ) -> ParameterValue {
        match self {
            ParameterValue::Absolute { value } => ParameterValue::Absolute {
                value: min + max - *value,
            },
            ParameterValue::AbsolutePercent { value } => {
                let value_f = value.as_f32();
                let inverted = match value_polarity {
                    ParameterValuePolarity::Unsigned => 1.0_f32 - value_f,
                    ParameterValuePolarity::Signed => -value_f,
                };
                ParameterValue::AbsolutePercent {
                    value: inverted.into(),
                }
            }
            ParameterValue::Relative { offset } => ParameterValue::Relative { offset: -*offset },
            ParameterValue::RelativePercent { offset } => {
                let offset_f = offset.as_f32();
                ParameterValue::RelativePercent {
                    offset: (-offset_f).into(),
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verifies unsigned absolute percentages keep the existing mirror-around-half behavior.
    #[test]
    fn inverted_unsigned_absolute_percent_mirrors_around_half() {
        assert_eq!(
            ParameterValue::AbsolutePercent { value: 0.25.into() }.inverted(
                0.0,
                255.0,
                ParameterValuePolarity::Unsigned,
            ),
            ParameterValue::AbsolutePercent { value: 0.75.into() }
        );
    }

    /// Verifies signed absolute percentages mirror by changing sign around zero.
    #[test]
    fn inverted_signed_absolute_percent_mirrors_around_zero() {
        let inverted = ParameterValue::AbsolutePercent {
            value: (-0.15).into(),
        }
        .inverted(-270.0, 270.0, ParameterValuePolarity::Signed);

        let ParameterValue::AbsolutePercent { value } = inverted else {
            panic!("expected inverted signed absolute percent");
        };
        let value_f = value.as_f32();
        assert!((value_f - 0.15).abs() < 0.000_01);
    }
}

impl Display for ParameterValue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ParameterValue::Absolute { value } => write!(f, "{}", value),
            ParameterValue::AbsolutePercent { value } => write!(f, "{}", value),
            ParameterValue::Relative { offset } => {
                if *offset >= 0.0 {
                    write!(f, "+{:.1}", offset)
                } else {
                    write!(f, "{:.1}", offset)
                }
            }
            ParameterValue::RelativePercent { offset } => {
                if offset.as_f32() >= 0.0 {
                    write!(f, "+{}", offset)
                } else {
                    write!(f, "{}", offset)
                }
            }
        }
    }
}
