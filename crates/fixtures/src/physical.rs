// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Physical characteristics of fixtures for visualizer rendering.
//!
//! Field names align with GDTF spec for future parsing compatibility.

use serde::{Deserialize, Serialize};

/// Beam rendering style, determines which shader is used for visualization.
#[derive(Default, Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(rename_all = "camelCase")]
pub enum BeamType {
    /// Hard-edged beam with sharp cutoff (e.g., profile spots, followspots)
    #[default]
    Spot,
    /// Soft-edged beam with gradual falloff (e.g., wash lights, PARs)
    Wash,
    /// Soft-edged beam with Fresnel lens characteristics
    Fresnel,
    /// Soft-edged beam with plano-convex lens characteristics
    Pc,
    /// Glow/pixel fixtures that emit light but shouldn't render volumetric beams
    /// (e.g., LED bars, pixel fixtures, GDTF Glow/Rectangle/None beam types)
    Glow,
}

/// Physical fixture characteristics from GDTF/OFL profiles.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(rename_all = "camelCase")]
pub struct FixturePhysical {
    /// Inner beam angle in degrees (GDTF: BeamAngle, OFL: degreesMinMax[0])
    pub beam_angle: f32,
    /// Outer beam angle in degrees (GDTF: FieldAngle, OFL: degreesMinMax[1])
    pub field_angle: f32,
    /// Light output in lumens (GDTF: LuminousFlux, OFL: bulb.lumens)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lumens: Option<f32>,
    /// Native color temperature in Kelvin (GDTF/OFL: colorTemperature)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color_temperature: Option<f32>,
    /// Beam rendering style (GDTF: BeamType)
    pub beam_type: BeamType,
}

impl Default for FixturePhysical {
    fn default() -> Self {
        Self {
            beam_angle: 15.0,
            field_angle: 15.0,
            lumens: None,
            color_temperature: None,
            beam_type: BeamType::default(),
        }
    }
}
