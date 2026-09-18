// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use serde::{Deserialize, Serialize};
use strum::EnumString;

/// Attribute categories are used to group attributes together
#[allow(missing_docs)]
#[non_exhaustive]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[typeshare::typeshare]
pub enum AttributeCategory {
    #[default]
    Dimmer,
    Position,
    Gobo,
    Color,
    Beam,
    Focus,
    Control,
    Other,
}

/// Attributes are the properties of a fixture that can be controlled
#[allow(missing_docs)]
#[non_exhaustive]
#[derive(
    Debug, Default, strum::Display, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, EnumString,
)]
/// DMX attribute names understood by fixture definitions and command parsing.
#[strum(ascii_case_insensitive)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum Attribute {
    #[default]
    Intensity,
    VirtualIntensity,
    Pan,
    Tilt,
    StrobeShutter,
    StrobeRate,
    Red,
    Green,
    Blue,
    Amber,
    White,
    WarmWhite,
    CoolWhite,
    Cyan,
    Magenta,
    Yellow,
    UV,
    Raw,
    Gobo,
    GoboRot,
    Shaper,
    Prism,
    Frost,
    Zoom,
    Custom {
        label: String,
    },
}

/// Declares whether a parameter's logical value range is unsigned or signed around zero.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub enum ParameterValuePolarity {
    /// Values run from zero to the parameter's positive maximum.
    #[default]
    Unsigned,
    /// Values run negative-to-positive around a logical midpoint.
    Signed,
}

/// Unit used for operator-facing values of a fixture parameter.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub enum ParameterUnit {
    /// Values are entered and displayed as percentages of the parameter range.
    #[default]
    Percent,
    /// Values are entered and displayed as degrees.
    Degrees,
}

/// Presentation metadata for a fixture attribute.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct AttributeMetadata {
    /// Canonical stable key used by clients for lookup.
    pub key: String,
    /// Attribute value represented by this metadata row.
    pub attribute: Attribute,
    /// Human-readable display label.
    pub label: String,
    /// Canonical attribute category.
    pub category: AttributeCategory,
    /// Canonical presentation sort order.
    pub sort_order: u8,
}

impl Attribute {
    /// Standard non-custom attributes in canonical presentation order.
    pub fn standard_attributes() -> &'static [Attribute] {
        &[
            Attribute::Intensity,
            Attribute::VirtualIntensity,
            Attribute::Red,
            Attribute::Green,
            Attribute::Blue,
            Attribute::White,
            Attribute::CoolWhite,
            Attribute::WarmWhite,
            Attribute::Amber,
            Attribute::Cyan,
            Attribute::Yellow,
            Attribute::Magenta,
            Attribute::UV,
            Attribute::Pan,
            Attribute::Tilt,
            Attribute::StrobeShutter,
            Attribute::StrobeRate,
            Attribute::Gobo,
            Attribute::GoboRot,
            Attribute::Shaper,
            Attribute::Prism,
            Attribute::Frost,
            Attribute::Zoom,
            Attribute::Raw,
        ]
    }

    /// Get the sort order for this attribute based on the desired presentation order:
    /// dimmer, r/g/b, white, cool white, warm white, amber, c/y/m/k, uv, pan/tilt, strobe, gobos, shaper, prism
    pub fn sort_order(&self) -> u8 {
        match self {
            // Dimmer
            Attribute::Intensity => 0,
            Attribute::VirtualIntensity => 1,

            // R/G/B
            Attribute::Red => 2,
            Attribute::Green => 3,
            Attribute::Blue => 4,

            // White variants
            Attribute::White => 5,
            Attribute::CoolWhite => 6,
            Attribute::WarmWhite => 7,

            // Amber
            Attribute::Amber => 8,

            // C/Y/M/K (Cyan/Yellow/Magenta/Key-Black)
            Attribute::Cyan => 9,
            Attribute::Yellow => 10,
            Attribute::Magenta => 11,
            // Note: No "K" (Key/Black) attribute in current enum

            // UV
            Attribute::UV => 12,

            // Pan/Tilt
            Attribute::Pan => 13,
            Attribute::Tilt => 14,

            // Strobe
            Attribute::StrobeShutter => 15,
            Attribute::StrobeRate => 16,

            // Gobos
            Attribute::Gobo => 17,
            Attribute::GoboRot => 18,

            // Shaper
            Attribute::Shaper => 19,

            // Prism
            Attribute::Prism => 20,

            // Beam/Focus
            Attribute::Frost => 21,
            Attribute::Zoom => 22,

            // Other attributes
            Attribute::Raw => 23,

            // Custom attributes go last
            Attribute::Custom { .. } => 255,
        }
    }

    /// Get the canonical category for this attribute.
    pub fn category(&self) -> AttributeCategory {
        match self {
            Attribute::Intensity
            | Attribute::VirtualIntensity
            | Attribute::StrobeShutter
            | Attribute::StrobeRate => AttributeCategory::Dimmer,
            Attribute::Pan | Attribute::Tilt => AttributeCategory::Position,
            Attribute::Red
            | Attribute::Green
            | Attribute::Blue
            | Attribute::Amber
            | Attribute::White
            | Attribute::WarmWhite
            | Attribute::CoolWhite
            | Attribute::Cyan
            | Attribute::Magenta
            | Attribute::Yellow
            | Attribute::UV => AttributeCategory::Color,
            Attribute::Gobo | Attribute::GoboRot => AttributeCategory::Gobo,
            Attribute::Shaper | Attribute::Prism | Attribute::Frost | Attribute::Zoom => {
                AttributeCategory::Beam
            }
            Attribute::Raw | Attribute::Custom { .. } => AttributeCategory::Other,
        }
    }

    /// Canonical stable key used by clients for lookup.
    pub fn key(&self) -> String {
        match self {
            Attribute::Custom { label } => label.clone(),
            _ => self.to_string(),
        }
    }

    /// Human-readable display label.
    pub fn label(&self) -> String {
        self.key()
    }

    /// Full presentation metadata for this attribute.
    pub fn metadata(&self) -> AttributeMetadata {
        AttributeMetadata {
            key: self.key(),
            attribute: self.clone(),
            label: self.label(),
            category: self.category(),
            sort_order: self.sort_order(),
        }
    }

    /// Returns the default logical value polarity for this attribute.
    pub fn value_polarity(&self) -> ParameterValuePolarity {
        match self {
            Attribute::Pan | Attribute::Tilt => ParameterValuePolarity::Signed,
            _ => ParameterValuePolarity::Unsigned,
        }
    }

    /// Returns the default operator-facing unit for this attribute.
    pub fn native_unit(&self) -> ParameterUnit {
        match self {
            Attribute::Pan | Attribute::Tilt => ParameterUnit::Degrees,
            _ => ParameterUnit::Percent,
        }
    }
}

impl PartialOrd for Attribute {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for Attribute {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        match (self, other) {
            // Custom attributes are ordered by their label
            (Attribute::Custom { label: a }, Attribute::Custom { label: b }) => a.cmp(b),
            // Otherwise, use the sort order
            _ => self.sort_order().cmp(&other.sort_order()),
        }
    }
}

/// Returns canonical metadata for all standard non-custom attributes.
pub fn standard_attribute_metadata() -> Vec<AttributeMetadata> {
    Attribute::standard_attributes()
        .iter()
        .map(Attribute::metadata)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn standard_attribute_metadata_covers_all_standard_attributes() {
        let metadata = standard_attribute_metadata();
        assert_eq!(metadata.len(), Attribute::standard_attributes().len());
        for (index, attribute) in Attribute::standard_attributes().iter().enumerate() {
            let row = &metadata[index];
            assert_eq!(row.attribute, *attribute);
            assert_eq!(row.key, attribute.key());
            assert_eq!(row.category, attribute.category());
            assert_eq!(row.sort_order, attribute.sort_order());
        }
    }

    /// Verifies position and level attributes use their expected native units.
    #[test]
    fn attributes_report_native_units() {
        assert_eq!(Attribute::Red.native_unit(), ParameterUnit::Percent);
        assert_eq!(Attribute::Intensity.native_unit(), ParameterUnit::Percent);
        assert_eq!(Attribute::Pan.native_unit(), ParameterUnit::Degrees);
        assert_eq!(Attribute::Tilt.native_unit(), ParameterUnit::Degrees);
    }
}
