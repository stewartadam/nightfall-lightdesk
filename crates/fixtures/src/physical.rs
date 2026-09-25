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
    /// Rectangular projected distribution described by throw and aspect ratios.
    Rectangle,
    /// Self-emitting geometry without a projected beam (GDTF Glow/None).
    Glow,
}

/// Optical properties of one emitting aperture, independent of fixture layout.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(rename_all = "camelCase")]
pub struct BeamOptics {
    /// Distribution, flux and color temperature of this emitter alone.
    pub physical: FixturePhysical,
    /// Radius of the emitting aperture in meters.
    pub radius: f32,
    /// Projection distance divided by projected width for rectangular beams.
    pub throw_ratio: f32,
    /// Projected width divided by height for rectangular beams.
    pub rectangle_ratio: f32,
}

/// One optical wheel, retaining source slot order for DMX wheel-slot selection.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(rename_all = "camelCase")]
pub struct OpticalWheel {
    /// Name referenced by channel functions in the fixture definition.
    pub name: String,
    /// Slots in source order, including open slots without media or facets.
    pub slots: Vec<OpticalWheelSlot>,
}

/// A source channel's optical functions, evaluated against its normalized DMX output.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(rename_all = "camelCase")]
pub struct OpticalChannel {
    /// Canonical parameter output key after fixture attribute conversion.
    pub parameter_key: String,
    /// Geometry owning the channel; descendants inherit its optical controls.
    pub geometry: String,
    /// Logical attribute used to find the element's parameter output.
    pub attribute: String,
    /// Largest integer DMX value at the source channel's resolution.
    pub dmx_max: u32,
    /// Functions in ascending DMX order.
    pub functions: Vec<OpticalFunction>,
}

/// An inclusive source-defined DMX interval and its physical interpretation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(rename_all = "camelCase")]
pub struct OpticalFunction {
    /// Exact function attribute, distinguishing selection from rotation effects.
    pub attribute: String,
    /// Source unit for physical values; absent units must not be interpreted as metres or angles.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub physical_unit: Option<String>,
    /// Inclusive channel-resolution DMX boundaries.
    pub dmx_from: u32,
    /// Inclusive final DMX value.
    pub dmx_to: u32,
    /// Physical value at the start of the interval.
    pub physical_from: f64,
    /// Physical value at the end of the interval.
    pub physical_to: f64,
    /// Referenced wheel name, if this function selects wheel slots.
    pub wheel: Option<String>,
    /// Referenced nonlinear DMX profile, if present.
    pub dmx_profile: Option<String>,
    /// Resolved source polynomial segments and physical limits, when the profile exists.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_curve: Option<OpticalDmxProfile>,
    /// Source mode-master condition retained for conditional-function evaluation.
    pub mode_master: Option<String>,
    /// Resolved conditions that must all hold; absent when a source link cannot be resolved.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode_conditions: Option<Vec<OpticalModeCondition>>,
    /// Named subintervals, including wheel-slot assignments.
    pub sets: Vec<OpticalChannelSet>,
}

/// An inclusive mode-master range in the controlling channel's native DMX resolution.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(rename_all = "camelCase")]
pub struct OpticalModeCondition {
    /// Geometry owning the controlling parameter.
    pub geometry: String,
    /// Parameter output key, independent of the controlled optical attribute.
    pub parameter_key: String,
    /// Largest integer DMX value of the controlling channel.
    pub dmx_max: u32,
    /// Inclusive lower activation boundary.
    pub dmx_from: u32,
    /// Inclusive upper activation boundary.
    pub dmx_to: u32,
}

/// A resolved GDTF transfer curve; percentages and coefficients retain source units.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(rename_all = "camelCase")]
pub struct OpticalDmxProfile {
    /// Physical lower endpoint declared by the channel function's Min value.
    pub min: f64,
    /// Physical upper endpoint declared by the channel function's Max value.
    pub max: f64,
    /// Polynomial segments in ascending input-percentage order.
    pub points: Vec<OpticalDmxProfilePoint>,
}

/// One polynomial segment evaluated relative to its starting DMX percentage.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(rename_all = "camelCase")]
pub struct OpticalDmxProfilePoint {
    /// Inclusive start percentage of this segment.
    pub dmx_percentage: f64,
    /// Coefficients of powers zero through three, in source order.
    pub coefficients: [f64; 4],
}

/// One inclusive channel-set interval; slot indices retain GDTF's one-based convention.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(rename_all = "camelCase")]
pub struct OpticalChannelSet {
    /// Inclusive channel-resolution start value.
    pub dmx_from: u32,
    /// Inclusive channel-resolution final value.
    pub dmx_to: u32,
    /// Physical start value, including inheritance from the parent function.
    pub physical_from: f64,
    /// Physical end value, including inheritance from the parent function.
    pub physical_to: f64,
    /// One-based wheel slot; absent for intervals without a slot assignment.
    pub wheel_slot: Option<i32>,
}

/// Visual optics of one wheel position; absent media does not imply a fabricated pattern.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(rename_all = "camelCase")]
pub struct OpticalWheelSlot {
    /// Source wheel-media name, resolved inside the fixture's GDTF archive.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media_name: Option<String>,
    /// Individual prism facets; an empty list represents no prism splitting.
    pub facets: Vec<OpticalPrismFacet>,
}

/// Source-defined facet transform and transmission color.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(rename_all = "camelCase")]
pub struct OpticalPrismFacet {
    /// Column-major 3x3 matrix, ready for the renderer's matrix convention.
    pub transform: [f32; 9],
    /// CIE xyY transmission color as supplied by the fixture definition.
    pub color_cie: [f32; 3],
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
