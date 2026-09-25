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
    /// Source unit for physical values; `None` values must not be interpreted as metres or angles.
    pub physical_unit: PhysicalUnit,
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
    /// Transfer curve mapping DMX within the function to its physical range.
    pub profile: OpticalProfile,
    /// Other-channel conditions gating whether this function is active.
    pub mode_master: OpticalModeMaster,
    /// Named subintervals, including wheel-slot assignments.
    pub sets: Vec<OpticalChannelSet>,
}

/// Physical quantity of an optical function's values, mapped from the GDTF attribute definition.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub enum PhysicalUnit {
    /// No physical unit, or the attribute definition could not be resolved.
    #[default]
    None,
    /// Percentage (%).
    Percent,
    /// Meters (m).
    Length,
    /// Kilograms (kg).
    Mass,
    /// Seconds (s).
    Time,
    /// Kelvin (K).
    Temperature,
    /// Candela (cd).
    LuminousIntensity,
    /// Degrees.
    Angle,
    /// Newtons (N).
    Force,
    /// Hertz (Hz).
    Frequency,
    /// Amperes (A).
    Current,
    /// Volts (V).
    Voltage,
    /// Watts (W).
    Power,
    /// Joules (J).
    Energy,
    /// Square meters (m²).
    Area,
    /// Cubic meters (m³).
    Volume,
    /// Meters per second (m/s).
    Speed,
    /// Meters per second squared (m/s²).
    Acceleration,
    /// Degrees per second.
    AngularSpeed,
    /// Degrees per second squared.
    AngularAcceleration,
    /// Nanometers (nm).
    WaveLength,
    /// Abstract color component intensity from 0 to 1.
    ColorComponent,
}

/// DMX-to-physical transfer curve of one optical function.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum OpticalProfile {
    /// Physical values interpolate linearly across the function or channel set.
    Linear,
    /// A resolved source polynomial curve.
    Curve(OpticalDmxProfile),
    /// The source references a profile that could not be resolved; values must not be guessed.
    Unresolved,
}

/// Activation gate of one optical function driven by other channels.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum OpticalModeMaster {
    /// The function is always active within its DMX interval.
    None,
    /// Conditions that must all hold for the function to be active.
    Resolved(Vec<OpticalModeCondition>),
    /// The source declares a mode master that could not be resolved (missing link or cycle).
    Unresolved,
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

/// Full beam angles at the endpoints of a fixture's normalized zoom control.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(rename_all = "camelCase")]
pub struct BeamZoomRange {
    /// Full beam angle at the narrow end of the zoom travel, in degrees.
    pub narrow: f32,
    /// Full beam angle at the wide end of the zoom travel, in degrees.
    pub wide: f32,
}

/// Physical fixture characteristics from GDTF/OFL profiles.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(rename_all = "camelCase")]
pub struct FixturePhysical {
    /// Optional zoom travel, independent of the beam and field intensity contours.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub zoom_range: Option<BeamZoomRange>,
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
            zoom_range: None,
            beam_angle: 15.0,
            field_angle: 15.0,
            lumens: None,
            color_temperature: None,
            beam_type: BeamType::default(),
        }
    }
}
